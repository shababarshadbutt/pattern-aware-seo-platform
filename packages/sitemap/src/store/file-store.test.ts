import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalDiskFileStore, StoredFileMissingError } from "./file-store.js";

describe("LocalDiskFileStore", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = (): LocalDiskFileStore => new LocalDiskFileStore(root);

  it("round-trips bytes and reports the digest of what it wrote", async () => {
    const body = "<urlset><url><loc>https://x.test/a</loc></url></urlset>";

    const stored = await store().put(
      { runId: "run-1", fileId: 0 },
      Readable.from([body])
    );

    expect(stored.bytes).toBe(Buffer.byteLength(body));
    expect(stored.digest).toBe(createHash("sha256").update(body).digest("hex"));

    const readBack = await store().open({ runId: "run-1", fileId: 0 });
    const chunks: Buffer[] = [];

    for await (const chunk of readBack) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    expect(Buffer.concat(chunks).toString()).toBe(body);
  });

  it("digests every byte, including across chunk boundaries", async () => {
    // The digest is computed in a transform inside the pipeline rather than from
    // a `data` listener on the source, because a listener puts the stream into
    // flowing mode and can lose chunks before the pipeline attaches. A
    // multi-chunk source is what tells the two apart.
    const chunks = [
      "<urlset>",
      "<url><loc>https://x.test/a</loc></url>",
      "</urlset>"
    ];
    const whole = chunks.join("");

    const stored = await store().put(
      { runId: "run-1", fileId: 3 },
      Readable.from(chunks)
    );

    expect(stored.bytes).toBe(Buffer.byteLength(whole));
    expect(stored.digest).toBe(
      createHash("sha256").update(whole).digest("hex")
    );
    expect((await readFile(join(root, "run-1", "3"))).toString()).toBe(whole);
  });

  it("leaves nothing behind when the source fails mid-write", async () => {
    // A truncated sitemap still parses, so it would read as a legitimately
    // smaller population — the one outcome worse than a missing file.
    const failing = new Readable({
      read(): void {
        this.push("<urlset><url><loc>https://x.test/a</loc></url>");
        this.destroy(new Error("connection reset"));
      }
    });

    await expect(
      store().put({ runId: "run-2", fileId: 0 }, failing)
    ).rejects.toThrow(/connection reset/);

    // Neither the target nor the .partial sibling survives.
    await expect(readdir(join(root, "run-2"))).resolves.toEqual([]);
  });

  it("reports a missing file as missing rather than an empty read", async () => {
    await expect(store().open({ runId: "nope", fileId: 0 })).rejects.toThrow(
      StoredFileMissingError
    );
  });

  it("refuses a fileId that is not a non-negative integer", async () => {
    // fileId reaches a filesystem path, so a fractional or negative value is a
    // bug worth failing on rather than writing to a surprising filename.
    for (const fileId of [-1, 1.5, Number.NaN]) {
      await expect(store().stat({ runId: "run-3", fileId })).rejects.toThrow(
        TypeError
      );
    }
  });

  it("stats a stored file and removes a whole run", async () => {
    await store().put({ runId: "run-4", fileId: 0 }, Readable.from(["abc"]));
    await store().put({ runId: "run-4", fileId: 1 }, Readable.from(["de"]));

    expect(await store().stat({ runId: "run-4", fileId: 1 })).toMatchObject({
      bytes: 2
    });

    await store().removeRun("run-4");

    expect(await store().stat({ runId: "run-4", fileId: 0 })).toBeUndefined();
  });

  it("does not confuse two runs that share a fileId", async () => {
    // File ids are run-local integers, so storage has to be scoped by run or
    // one run's parse would read another's bytes.
    await store().put({ runId: "a", fileId: 0 }, Readable.from(["from-a"]));
    await store().put({ runId: "b", fileId: 0 }, Readable.from(["from-b"]));

    await writeFile(join(root, "sentinel"), "");

    const a = await store().open({ runId: "a", fileId: 0 });
    const chunks: Buffer[] = [];

    for await (const chunk of a) {
      chunks.push(Buffer.from(chunk as Buffer));
    }

    expect(Buffer.concat(chunks).toString()).toBe("from-a");
  });
});
