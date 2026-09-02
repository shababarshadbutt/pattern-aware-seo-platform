import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { stableHash } from "@pattern-aware/sampling";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalDiskFileStore } from "../store/file-store.js";
import {
  CandidateResolutionError,
  resolveCandidates
} from "./resolve-candidates.js";

const BASE = "https://shop.test";
const OPTIONS = { baseUrl: BASE, expectedHost: "shop.test" } as const;

function urlset(paths: readonly string[]): string {
  const entries = paths
    .map((path) => `<url><loc>${BASE}${path}</loc></url>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

describe("resolveCandidates", () => {
  let root = "";
  let store: LocalDiskFileStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "resolve-"));
    store = new LocalDiskFileStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(body: string, fileId = 0): Promise<void> {
    await store.put({ runId: "run-1", fileId }, Readable.from([body]));
  }

  it("recovers the URL a candidate was drawn from", async () => {
    const paths = ["/p/1", "/p/2", "/p/3", "/p/4"];

    await write(urlset(paths));

    const resolved = await resolveCandidates(
      store,
      { runId: "run-1", fileId: 0 },
      [
        { ordinal: 2, hash: stableHash("/p/3") },
        { ordinal: 0, hash: stableHash("/p/1") }
      ],
      OPTIONS
    );

    // Returned in the caller's order, not the file's, so results can be zipped
    // straight back against the candidates that produced them.
    expect(resolved.map((r) => r.url)).toEqual([`${BASE}/p/3`, `${BASE}/p/1`]);
    expect(resolved[0]?.path).toBe("/p/3");
  });

  it("stops reading once the last wanted ordinal is seen", async () => {
    /**
     * Asserted structurally rather than by counting bytes: everything after the
     * last wanted ordinal is deliberately malformed XML. If resolution read to
     * the end it would fail to parse, so passing IS the proof it stopped.
     */
    const head = urlset(["/p/1", "/p/2"]).replace("</urlset>", "");
    const truncatedTail = `${head}<url><loc>${BASE}/p/3</loc></url`;

    await write(truncatedTail);

    const resolved = await resolveCandidates(
      store,
      { runId: "run-1", fileId: 0 },
      [{ ordinal: 0, hash: stableHash("/p/1") }],
      OPTIONS
    );

    expect(resolved).toHaveLength(1);
  });

  it("refuses to resolve when the file's URLs have shifted", async () => {
    /**
     * THE FAILURE THIS WHOLE FUNCTION EXISTS FOR. The sitemap was regenerated
     * with a URL inserted at the front, so every ordinal now addresses its
     * neighbour. Probing the shifted URL and recording the result against the
     * original candidate would be wrong in a way nothing downstream could see.
     */
    await write(urlset(["/p/0", "/p/1", "/p/2", "/p/3"]));

    await expect(
      resolveCandidates(
        store,
        { runId: "run-1", fileId: 0 },
        [{ ordinal: 2, hash: stableHash("/p/3") }],
        OPTIONS
      )
    ).rejects.toThrow(/hashes to \d+, but was sampled as \d+/);
  });

  it("reports which ordinals a shortened file no longer contains", async () => {
    // Resolving what it can and returning a short list would shrink the sample
    // without shrinking n, inflating every interval computed from it.
    await write(urlset(["/p/1", "/p/2"]));

    await expect(
      resolveCandidates(
        store,
        { runId: "run-1", fileId: 0 },
        [
          { ordinal: 0, hash: stableHash("/p/1") },
          { ordinal: 7, hash: stableHash("/p/8") }
        ],
        OPTIONS
      )
    ).rejects.toThrow(/ended before 1 sampled ordinal\(s\) \[7\]/);
  });

  it("refuses a sampled ordinal that now points off-host", async () => {
    await write(
      urlset(["/p/1"]).replace(`${BASE}/p/1`, "https://other.test/p/1")
    );

    await expect(
      resolveCandidates(
        store,
        { runId: "run-1", fileId: 0 },
        [{ ordinal: 0, hash: stableHash("/p/1") }],
        OPTIONS
      )
    ).rejects.toThrow(/now parses as foreign/);
  });

  it("still reports a hash mismatch on a file that needed its preamble stripped", async () => {
    /**
     * INTERACTION REGRESSION, found while writing this and not by a test that
     * existed. `streamLocs` rewrites any error into a preamble error when junk
     * was stripped and parsing then failed — right for parse errors, wrong for
     * an error this function raised, which it would replace with a misleading
     * "not recoverable preamble" report. Resolution therefore records its
     * failure and throws outside the stream. Both features are individually
     * correct; only their composition was wrong.
     */
    // Recoverable junk specifically: the stripper drops everything before the
    // first "<", so the document has to resume at <urlset> with no declaration
    // after the junk. An XML declaration that is not first is invalid XML and
    // fails the parse outright — a different case than the one under test.
    const withoutProlog = urlset(["/p/0", "/p/1"]).replace(
      /^<\?xml[^>]*\?>/,
      ""
    );

    await write(`cdn diagnostics: cache MISS\n${withoutProlog}`);

    await expect(
      resolveCandidates(
        store,
        { runId: "run-1", fileId: 0 },
        [{ ordinal: 0, hash: stableHash("/p/99") }],
        OPTIONS
      )
    ).rejects.toThrow(CandidateResolutionError);
  });

  it("reads nothing at all for an empty candidate list", async () => {
    // No file is even opened, so a pattern with nothing sampled costs no I/O.
    await expect(
      resolveCandidates(store, { runId: "missing-run", fileId: 0 }, [], OPTIONS)
    ).resolves.toEqual([]);
  });
});
