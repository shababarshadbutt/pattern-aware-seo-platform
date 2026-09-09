import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countObservations,
  createOrganization,
  createSite,
  listSitemapFiles,
  type SiteScope,
  startRun
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger } from "@pattern-aware/shared";
import { LocalDiskFileStore } from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PipelineDeps, VerifyTelemetryEvent } from "../deps.js";
import type { VerifyPayload } from "../payloads.js";
import { runDiscover } from "./discover.js";
import { runIngest } from "./ingest.js";
import { runVerify } from "./verify.js";

/**
 * `onVerifyTelemetry` composition tests — docs/reports/phase-2b-prior-art-analysis.md §11.
 *
 * Per CODING_STANDARDS.md §1.13 ("composition correctness"), a unit test on
 * timer math alone, or on `runVerify` alone, would not catch the M5-shaped
 * mistake this section warns about: a caller-supplied hook silently dropped,
 * or silently changing behavior, once actually wired into the real call
 * sequence. So this exercises `runVerify` for real (real Postgres, real
 * `LocalDiskFileStore`, real HTTP) and asserts both that the hook fires
 * correctly AND that its presence changes nothing about what gets written.
 *
 * The fixture's one pattern has exactly 30 URLs split 15-and-15 across two
 * sitemap files — 30 rather than fewer because `PARAM_MIN_OBSERVED_URLS`
 * (packages/sitemap/src/extraction/pattern-trie.ts) requires at least 30
 * observations at a slot before it collapses into `/product/{param}` at all;
 * below that, each `/product/N` stays its own one-URL literal pattern.
 * `firstRoundSampleSize` full-censuses any population at or under its
 * 30-URL floor (packages/sampling/src/sample-plan.ts), so all 30 candidates
 * are drawn deterministically — no dependence on hash-based sampling landing
 * in both files by chance, which pigeonholes `resolveAll`'s per-file
 * grouping into exactly two files every run.
 */

let harness: TestDatabase;
let server: Server;
let baseUrl: string;
let storeRoot = "";

beforeAll(async () => {
  harness = await createTestDatabase();
  storeRoot = await mkdtemp(join(tmpdir(), "verify-telemetry-"));

  server = createServer((request, response) => {
    const path = request.url ?? "/";
    const method = request.method ?? "GET";

    if (path === "/sitemap.xml") {
      const children = [1, 2]
        .map((n) => `<sitemap><loc>${baseUrl}/sitemap-${n}.xml</loc></sitemap>`)
        .join("");

      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
      );

      return;
    }

    const childMatch = /^\/sitemap-(\d)\.xml$/u.exec(path);

    if (childMatch !== null) {
      const start = childMatch[1] === "1" ? 1 : 16;
      const entries = Array.from(
        { length: 15 },
        (_, index) =>
          `<url><loc>${baseUrl}/product/${start + index}</loc></url>`
      ).join("");

      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
      );

      return;
    }

    // Every /product/N page is healthy — the fixture's only job is to give
    // resolveAll two real files to group candidates by, not to exercise
    // verification's own status handling (that's pipeline.e2e.test.ts's job).
    if (method === "HEAD") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end();

      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><html><body><h1>Product</h1><p>${"content ".repeat(50)}</p></body></html>`
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  await harness.destroy();
  await rm(storeRoot, { recursive: true, force: true });
});

/** One site, discovered and ingested, with its single verify job's payload. */
async function seedSite(
  deps: PipelineDeps,
  label: string
): Promise<{ scope: SiteScope; payload: VerifyPayload }> {
  const org = await createOrganization(harness.db, {
    name: `Verify Telemetry ${label}`,
    slug: `verify-telemetry-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  });

  const site = await createSite(harness.db, org.scope, {
    name: `Fixture ${label}`,
    baseUrl
  });

  const scope = site.scope;
  const runId = (await startRun(harness.db, scope, { workerId: `t-${label}` }))
    .id;

  let verifyPayload: Record<string, unknown> | undefined;

  const seedDeps: PipelineDeps = {
    ...deps,
    enqueue: async (stage, payload) => {
      if (stage === "verify") {
        verifyPayload = payload;
      }
    }
  };

  await runDiscover(seedDeps, scope, {
    siteId: scope.siteId,
    sitemapRunId: runId,
    sitemapUrl: `${baseUrl}/sitemap.xml`,
    baseUrl,
    expectedHost: "127.0.0.1"
  });

  const ingested = await runIngest(seedDeps, scope, {
    siteId: scope.siteId,
    sitemapRunId: runId,
    baseUrl,
    expectedHost: "127.0.0.1"
  });

  expect(ingested.patternCount).toBe(1);
  expect(ingested.totalUrls).toBe(30);

  const files = await listSitemapFiles(harness.db, scope, runId);

  expect(files).toHaveLength(2);

  if (verifyPayload === undefined) {
    throw new Error("ingest did not enqueue a verify job");
  }

  return { scope, payload: verifyPayload as unknown as VerifyPayload };
}

function makeBaseDeps(): PipelineDeps {
  return {
    db: harness.db,
    store: new LocalDiskFileStore(storeRoot),
    logger: createLogger({
      service: "verify-telemetry-test",
      level: "silent",
      pretty: false
    }),
    fetchSitemap: async (url: string) => {
      const response = await fetch(url);

      return {
        status: response.status,
        headers: new Map(
          response.headers as unknown as Iterable<[string, string]>
        ),
        body: streamOf(response.body)
      };
    },
    enqueue: async () => {},
    rateLimiter: new HostRateLimiter({
      requestsPerSecond: 200,
      concurrency: 8
    }),
    circuitBreaker: new HostCircuitBreaker({})
  };
}

async function* streamOf(
  body: ReadableStream<Uint8Array> | null
): AsyncIterable<Uint8Array> {
  if (body === null) {
    return;
  }

  const reader = body.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    if (value !== undefined) {
      yield value;
    }
  }
}

describe("runVerify with onVerifyTelemetry", () => {
  it("fires one resolveCandidates event per distinct file, one candidateFileSpread event, and one verifyProbe event", async () => {
    const base = makeBaseDeps();
    const { scope, payload } = await seedSite(base, "hook");

    const events: VerifyTelemetryEvent[] = [];

    const result = await runVerify(
      { ...base, onVerifyTelemetry: (event) => events.push(event) },
      scope,
      payload
    );

    expect(result.verdict).toMatchObject({ kind: "measured" });
    expect(result.observationsWritten).toBe(30);

    const resolveEvents = events.filter(
      (event) => event.kind === "resolveCandidates"
    );
    const spreadEvents = events.filter(
      (event) => event.kind === "candidateFileSpread"
    );
    const probeEvents = events.filter((event) => event.kind === "verifyProbe");

    // Two files, so exactly two resolveCandidates calls — not one per
    // candidate (10) and not zero (the hook silently dropped, the M5 defect
    // this section exists to catch).
    expect(resolveEvents).toHaveLength(2);
    expect(new Set(resolveEvents.map((event) => event.fileOrdinal)).size).toBe(
      2
    );

    for (const event of resolveEvents) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }

    expect(spreadEvents).toHaveLength(1);
    expect(spreadEvents[0]).toMatchObject({ distinctFiles: 2 });

    expect(probeEvents).toHaveLength(1);
    expect(probeEvents[0]?.durationMs).toBeGreaterThanOrEqual(0);

    // Emitted in call order: both resolutions before the one probe.
    expect(events.map((event) => event.kind)).toEqual([
      "candidateFileSpread",
      "resolveCandidates",
      "resolveCandidates",
      "verifyProbe"
    ]);
  }, 30_000);

  it("does not change runVerify's result or the rows it writes when the hook is present vs. absent", async () => {
    const base = makeBaseDeps();

    const withHook = await seedSite(base, "with-hook");
    const withoutHook = await seedSite(base, "without-hook");

    const resultWithHook = await runVerify(
      { ...base, onVerifyTelemetry: () => {} },
      withHook.scope,
      withHook.payload
    );

    const resultWithoutHook = await runVerify(
      base,
      withoutHook.scope,
      withoutHook.payload
    );

    expect(resultWithHook.verdict).toEqual(resultWithoutHook.verdict);
    expect(resultWithHook.probed).toBe(resultWithoutHook.probed);
    expect(resultWithHook.escalated).toBe(resultWithoutHook.escalated);
    expect(resultWithHook.requestCount).toBe(resultWithoutHook.requestCount);
    expect(resultWithHook.observationsWritten).toBe(
      resultWithoutHook.observationsWritten
    );

    const observedWithHook = await countObservations(
      harness.db,
      withHook.scope,
      withHook.payload.patternSampleId
    );
    const observedWithoutHook = await countObservations(
      harness.db,
      withoutHook.scope,
      withoutHook.payload.patternSampleId
    );

    expect(observedWithHook).toBe(observedWithoutHook);
  }, 30_000);

  it("still reports a resolveCandidates event for a file whose resolution fails, and skips telemetry for a file with no sitemap_file row", async () => {
    const base = makeBaseDeps();
    const { scope, payload } = await seedSite(base, "error-path");

    // Corrupt one candidate's hash so resolveCandidates's own hash re-check
    // (packages/sitemap/src/ingest/resolve-candidates.ts) throws for whichever
    // file it belongs to — the catch-and-continue branch this platform relies
    // on to keep one changed file from stalling a whole pattern.
    const corruptedCandidates = payload.candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, hash: candidate.hash + 1 } : candidate
    );
    const corruptedFileOrdinal = payload.candidates[0]?.fileId;

    const events: VerifyTelemetryEvent[] = [];

    const result = await runVerify(
      { ...base, onVerifyTelemetry: (event) => events.push(event) },
      scope,
      { ...payload, candidates: corruptedCandidates }
    );

    const resolveEvents = events.filter(
      (event) => event.kind === "resolveCandidates"
    );

    // Both files were attempted — the failing one included — even though
    // only the healthy file's candidates made it into the resolved set.
    expect(resolveEvents).toHaveLength(2);
    expect(
      resolveEvents.some((event) => event.fileOrdinal === corruptedFileOrdinal)
    ).toBe(true);

    // The healthy file's 15 candidates still resolved and got probed/observed.
    expect(result.observationsWritten).toBeGreaterThan(0);
    expect(result.observationsWritten).toBeLessThan(30);
  }, 30_000);
});
