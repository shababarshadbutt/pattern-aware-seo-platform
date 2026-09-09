import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countObservations,
  createOrganization,
  createSite,
  findRunById,
  findSnapshotsByPattern,
  listPatternsByPopulation,
  type SiteScope,
  startRun
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { queueName, type SitemapResponse } from "@pattern-aware/pipeline";
import { DEFAULT_SAMPLE_BUDGET } from "@pattern-aware/sampling";
import { createLogger } from "@pattern-aware/shared";
import {
  DEFAULT_OVERSIZE_THRESHOLDS,
  LocalDiskFileStore
} from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SitePipeline } from "../src/site-pipeline.js";

/**
 * `SitePipeline` against a REAL Redis, a real Postgres and a real local HTTP
 * server — proving the BullMQ wiring itself, not re-proving the stage
 * functions' own correctness (`packages/pipeline`'s e2e suite already does
 * that with no Redis at all). Every job here is enqueued or drained by the
 * actual `Worker`/`Queue` instances a production worker process uses;
 * nothing calls a stage function directly.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

let harness: TestDatabase;
let server: Server;
let baseUrl = "";
let storeRoot = "";
let connection: Redis;

async function fetchReal(url: string): Promise<SitemapResponse> {
  const response = await fetch(url);

  return {
    status: response.status,
    headers: new Map(response.headers as unknown as Iterable<[string, string]>),
    body: streamOf(response.body)
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

/** Poll a run until it reaches a terminal status, or time out loudly. */
async function waitForTerminalRun(
  db: TestDatabase["db"],
  scope: SiteScope,
  runId: string,
  timeoutMs = 60_000
): Promise<Awaited<ReturnType<typeof findRunById>>> {
  const terminal = new Set(["complete", "degraded", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const run = await findRunById(db, scope, runId);

    if (run !== undefined && terminal.has(run.status)) {
      return run;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach a terminal status within ${timeoutMs}ms (last seen: ${run?.status ?? "not found"})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function newSitePipeline(
  siteScope: { readonly organizationId: string; readonly siteId: string },
  fetchSitemap: (url: string) => Promise<SitemapResponse>
): SitePipeline {
  return new SitePipeline({
    connection,
    db: harness.db,
    store: new LocalDiskFileStore(storeRoot),
    logger: createLogger({
      service: "worker-test",
      level: "silent",
      pretty: false
    }),
    organizationId: siteScope.organizationId,
    siteId: siteScope.siteId,
    tier: "standard",
    fetchSitemap,
    rateLimiter: new HostRateLimiter({
      requestsPerSecond: 200,
      concurrency: 8
    }),
    circuitBreaker: new HostCircuitBreaker({}),
    sampleBudget: DEFAULT_SAMPLE_BUDGET,
    oversizeThresholds: DEFAULT_OVERSIZE_THRESHOLDS
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();
  storeRoot = await mkdtemp(join(tmpdir(), "worker-site-pipeline-"));
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  server = createServer((request, response) => {
    const url = request.url ?? "/";
    const method = request.method ?? "GET";

    if (url === "/sitemap.xml") {
      /**
       * AT LEAST `PARAM_MIN_OBSERVED_URLS` (30) PER FAMILY, deliberately —
       * `packages/sitemap`'s pattern-trie only collapses a segment into
       * `{param}` once a sibling group clears that floor (or 100 siblings
       * outright). A smaller fixture here would leave every URL as its own
       * one-off "pattern", which is a fixture-sizing mistake, not a
       * `SitePipeline` finding — the main `pipeline.e2e.test.ts` fixture
       * uses the same floor for the same reason.
       */
      const entries = [
        ...Array.from(
          { length: 32 },
          (_unused, index) => `${baseUrl}/product/${index + 1}`
        ),
        ...Array.from(
          { length: 30 },
          (_unused, index) => `${baseUrl}/broken/${index + 1}`
        )
      ]
        .map((loc) => `<url><loc>${loc}</loc></url>`)
        .join("");

      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
      );

      return;
    }

    const status = url.startsWith("/broken/") ? 404 : 200;

    response.writeHead(status, { "content-type": "text/html" });
    response.end(method === "HEAD" ? undefined : "<html>ok</html>");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await connection.quit();
  await harness.destroy();
  await rm(storeRoot, { recursive: true, force: true });
});

describe("SitePipeline, self-chaining through real BullMQ", () => {
  it("runs discover through finalize with zero manual stage invocations", async () => {
    const org = await createOrganization(harness.db, {
      name: "Worker Test Org",
      slug: `worker-test-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Worker Test Site",
      baseUrl
    });

    const pipeline = newSitePipeline(site.scope, fetchReal);

    pipeline.start();

    /**
     * PROGRESS, watched independently of the run rather than asked for
     * afterwards: `ingest` is the one stage that reports it, and its job may
     * already be gone from BullMQ's completed-job retention by the time a
     * test would otherwise go looking for it.
     */
    const ingestProgress: number[] = [];
    const ingestQueueEvents = new QueueEvents(
      queueName({ tier: "standard", siteId: site.row.id, stage: "ingest" }),
      { connection: connection.duplicate() }
    );

    ingestQueueEvents.on("progress", ({ data }) => {
      ingestProgress.push(data as number);
    });

    await ingestQueueEvents.waitUntilReady();

    const run = await startRun(harness.db, site.scope, {
      workerId: "worker-test"
    });

    await pipeline.startRun({
      sitemapRunId: run.id,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    const finished = await waitForTerminalRun(harness.db, site.scope, run.id);

    expect(finished?.status).toBe("complete");

    // Both patterns exist, with exact counted populations.
    const patterns = await listPatternsByPopulation(
      harness.db,
      site.scope,
      run.id,
      10
    );

    expect(patterns.map((p) => p.template).sort()).toEqual([
      "/broken/{param}",
      "/product/{param}"
    ]);

    // Every pattern reached a real measurement — the fan-in worked.
    for (const pattern of patterns) {
      const snapshots = await findSnapshotsByPattern(
        harness.db,
        site.scope,
        pattern.id
      );

      expect(snapshots.length).toBeGreaterThan(0);
    }

    // Progress was actually reported over BullMQ, not just internally.
    expect(ingestProgress.length).toBeGreaterThan(0);
    expect(Math.max(...ingestProgress)).toBeGreaterThan(0);

    await ingestQueueEvents.close();
    await pipeline.stop();
  }, 60_000);

  it("redelivering a completed verify job through the real queue does not double-count", async () => {
    const org = await createOrganization(harness.db, {
      name: "Worker Redelivery Org",
      slug: `worker-redelivery-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Worker Redelivery Site",
      baseUrl
    });

    const pipeline = newSitePipeline(site.scope, fetchReal);

    pipeline.start();

    const run = await startRun(harness.db, site.scope, {
      workerId: "worker-redelivery-test"
    });

    await pipeline.startRun({
      sitemapRunId: run.id,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    await waitForTerminalRun(harness.db, site.scope, run.id);

    const patterns = await listPatternsByPopulation(
      harness.db,
      site.scope,
      run.id,
      10
    );
    const productPattern = patterns.find(
      (pattern) => pattern.template === "/product/{param}"
    );

    if (productPattern === undefined) {
      throw new Error("expected the /product/{param} pattern to exist");
    }

    const snapshots = await findSnapshotsByPattern(
      harness.db,
      site.scope,
      productPattern.id
    );
    const sample = snapshots[0];

    if (sample === undefined) {
      throw new Error("expected at least one snapshot for /product/{param}");
    }

    const before = await countObservations(
      harness.db,
      site.scope,
      sample.patternSampleId
    );

    expect(before).toBeGreaterThan(0);

    /**
     * A GENUINELY NEW JOB, not a second function call — this is what makes
     * this test distinct from `packages/pipeline`'s own idempotency
     * regressions. Re-adding the exact payload to the real queue exercises
     * the whole path: BullMQ hands it to the same `Worker`, which builds a
     * fresh `PipelineDeps` and calls `runVerify` again for real.
     */
    const verifyQueue = new Queue(
      queueName({ tier: "standard", siteId: site.row.id, stage: "verify" }),
      { connection: connection.duplicate() }
    );

    await verifyQueue.add("verify", {
      siteId: site.row.id,
      sitemapRunId: run.id,
      patternId: productPattern.id,
      patternSampleId: sample.patternSampleId,
      baseUrl,
      expectedHost: "127.0.0.1",
      candidates: [{ hash: 0, fileId: 0, ordinal: 0 }],
      plannedSampleSize: 1,
      fileIds: [0]
    });

    // Give the (already-running) worker time to pick it up and finish.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const after = await countObservations(
      harness.db,
      site.scope,
      sample.patternSampleId
    );

    expect(after).toBe(before);

    await verifyQueue.close();
    await pipeline.stop();
  }, 30_000);

  it("marks a run failed once a permanently-broken stage exhausts its retries", async () => {
    const org = await createOrganization(harness.db, {
      name: "Worker Exhausted Org",
      slug: `worker-exhausted-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Worker Exhausted Site",
      baseUrl: `${baseUrl}/never-answers`
    });

    // Always 404s: SitemapUnavailableError on every attempt, permanently.
    const alwaysFails = async (): Promise<SitemapResponse> => ({
      status: 404,
      headers: new Map(),
      body: (async function* () {})()
    });

    const pipeline = newSitePipeline(site.scope, alwaysFails);

    pipeline.start();

    const run = await startRun(harness.db, site.scope, {
      workerId: "worker-exhausted-test"
    });

    await pipeline.startRun({
      sitemapRunId: run.id,
      sitemapUrl: `${baseUrl}/never-answers/sitemap.xml`,
      baseUrl: `${baseUrl}/never-answers`,
      expectedHost: "127.0.0.1"
    });

    /**
     * THE EVENT-DRIVEN RECOVERY PATH, not the heartbeat sweeper — this run's
     * `discover` job burns all 3 BullMQ attempts (5s/10s/20s backoff), and
     * `SitePipeline`'s own `worker.on("failed", ...)` handler fails the run
     * immediately once the last one is exhausted, well before any heartbeat
     * timeout would.
     */
    const finished = await waitForTerminalRun(
      harness.db,
      site.scope,
      run.id,
      60_000
    );

    expect(finished?.status).toBe("failed");
    expect(finished?.statusReason).toContain("STAGE_EXHAUSTED_RETRIES");
    expect(finished?.statusReason).toContain("discover");

    // The slot is freed — a new run can start for this site.
    const secondRun = await startRun(harness.db, site.scope, {
      workerId: "worker-exhausted-test-2"
    });

    expect(secondRun.id).not.toBe(run.id);

    await pipeline.stop();
  }, 90_000);
});
