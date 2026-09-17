import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOrganization,
  createSite,
  type Database,
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
import {
  ATTACH_REQUESTS_QUEUE,
  type SitemapResponse
} from "@pattern-aware/pipeline";
import { DEFAULT_SAMPLE_BUDGET } from "@pattern-aware/sampling";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import {
  DEFAULT_OVERSIZE_THRESHOLDS,
  LocalDiskFileStore
} from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAttachRequestsWorker,
  createSiteAttacher,
  type SiteAttacher
} from "worker/src/attach-requests-worker.js";

import { buildApp } from "../src/app.js";
import { resetOrgScopeCacheForTesting } from "../src/org-scope.js";
import { createRunTrigger, type RunTrigger } from "../src/run-trigger.js";

/**
 * THE MISSING HOP, PROVEN AS ONE SYSTEM.
 *
 * Every piece exercised here already has its own proof elsewhere:
 * `apps/api/test/routes.test.ts` proves `POST /sites/:siteId/runs` against a
 * FAKE `RunTrigger` (a recorded call, no Redis); `apps/worker/test/
 * site-pipeline.test.ts` proves `SitePipeline` self-chains through a REAL
 * BullMQ, but starts from a direct `pipeline.startRun()` call, never from a
 * queued attach request. Neither test — nor anything else in the suite —
 * ever posts a real HTTP request and lets a real `attach-requests` consumer
 * pick it up. This file is that missing hop: real Fastify route →
 * `createRunTrigger` → real Redis → real `attachRequestsWorker` → real
 * `SitePipeline` → real Postgres, with nothing mocked at any join.
 *
 * `createSiteAttacher`/`createAttachRequestsWorker` are imported from the
 * `worker` app (a test-only devDependency added for exactly this) rather than
 * reimplemented here, because a test that re-derived the worker's wiring
 * would prove that reimplementation self-consistent, not the real one.
 */

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

let harness: TestDatabase;
let db: Database;
let server: Server;
let baseUrl = "";
let storeRoot = "";
let workerConnection: Redis;
let triggerConnection: Redis;
let attacher: SiteAttacher;
let attachWorker: ReturnType<typeof createAttachRequestsWorker>;
let runTrigger: RunTrigger;
/**
 * Built fresh per test rather than once here, because each test creates its
 * own organization and `resolveDefaultOrgScope`'s cache is keyed on nothing
 * — it just remembers whichever slug resolved first. Left `undefined` until
 * a test builds one, and `afterAll` only closes it if a test actually did.
 */
let app: ReturnType<typeof buildApp> | undefined;

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
  scope: SiteScope,
  runId: string,
  timeoutMs = 60_000
): Promise<Awaited<ReturnType<typeof findRunById>>> {
  // The current implementation's own terminal statuses — not invented here.
  const terminal = new Set(["complete", "degraded", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const run = await findRunById(db, scope, runId);

    if (run !== undefined && terminal.has(run.status)) {
      return run;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} did not reach a terminal status within ${timeoutMs}ms ` +
          `(last seen: ${run?.status ?? "not found"})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  storeRoot = await mkdtemp(join(tmpdir(), "run-trigger-e2e-"));

  // Two independent connections, matching production: the API's `RunTrigger`
  // only ever enqueues, the worker's connection only ever consumes/produces
  // stage jobs. Sharing one `Redis` instance between them would not prove
  // anything false, but it would not prove the real topology either.
  workerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  triggerConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

  // A real, local, deterministic HTTP target — never an external site.
  server = createServer((request, response) => {
    const url = request.url ?? "/";
    const method = request.method ?? "GET";

    if (url === "/sitemap.xml") {
      /**
       * AT LEAST `PARAM_MIN_OBSERVED_URLS` (30) PER FAMILY — see
       * `site-pipeline.test.ts`'s identical fixture for why a smaller one
       * would leave every URL uncollapsed and prove a fixture-sizing mistake
       * instead of a pipeline finding.
       */
      const entries = [
        ...Array.from(
          { length: 32 },
          (_unused, index) => `${baseUrl}/page/${index + 1}`
        ),
        ...Array.from(
          { length: 30 },
          (_unused, index) => `${baseUrl}/missing/${index + 1}`
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

    const status = url.startsWith("/missing/") ? 404 : 200;

    response.writeHead(status, { "content-type": "text/html" });
    response.end(method === "HEAD" ? undefined : "<html>ok</html>");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The REAL worker half: the same `createSiteAttacher`/
  // `createAttachRequestsWorker` production's `apps/worker/src/index.ts`
  // builds, given test-scoped dependencies instead of process-config ones.
  attacher = createSiteAttacher({
    connection: workerConnection,
    db,
    store: new LocalDiskFileStore(storeRoot),
    logger: createLogger({
      service: "run-trigger-e2e-worker",
      level: "silent",
      pretty: false
    }),
    fetchSitemap: fetchReal,
    rateLimiter: new HostRateLimiter({
      requestsPerSecond: 200,
      concurrency: 8
    }),
    circuitBreaker: new HostCircuitBreaker({}),
    sampleBudget: DEFAULT_SAMPLE_BUDGET,
    oversizeThresholds: DEFAULT_OVERSIZE_THRESHOLDS
  });

  attachWorker = createAttachRequestsWorker({
    connection: workerConnection,
    logger: createLogger({
      service: "run-trigger-e2e-attach",
      level: "silent",
      pretty: false
    }),
    attacher
  });

  // The REAL API half: `createRunTrigger` is the exact function
  // `apps/api/src/index.ts` calls in production, posting to the exact same
  // `ATTACH_REQUESTS_QUEUE` the worker above just started listening on.
  runTrigger = createRunTrigger(REDIS_URL);
}, 60_000);

afterAll(async () => {
  if (app !== undefined) {
    await app.close();
  }

  await runTrigger.close();
  await attachWorker.close();
  await attacher.stopAll();
  await workerConnection.quit();
  await triggerConnection.quit();

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await harness.destroy();
  await rm(storeRoot, { recursive: true, force: true });
  resetOrgScopeCacheForTesting();
});

describe("POST /sites/:siteId/runs, all the way to a real Postgres", () => {
  it("drives discover through finalize via the real queue, with no direct SitePipeline call", async () => {
    const org = await createOrganization(db, {
      name: "Run Trigger E2E Org",
      slug: `run-trigger-e2e-org-${Date.now()}`
    });

    // `resolveDefaultOrgScope` memoises the FIRST slug it ever resolves for
    // the lifetime of the module — reset before every rebuild, or a later
    // test's freshly-created organization would silently resolve to an
    // earlier test's cached scope instead of its own.
    resetOrgScopeCacheForTesting();

    // `buildApp` above is configured to act as THIS organization, so the
    // route resolves to this site without any auth to fake.
    app = buildApp(
      {
        NODE_ENV: "test",
        DEFAULT_ORGANIZATION_SLUG: org.row.slug,
        ...loadPolicyConfig({})
      },
      createLogger({
        service: "run-trigger-e2e-api",
        level: "silent",
        pretty: false
      }),
      db,
      runTrigger
    );

    await app.ready();

    const site = await createSite(db, org.scope, {
      name: "Run Trigger E2E Site",
      baseUrl
    });

    /**
     * THE ONLY ACTION THIS TEST TAKES TO START THE RUN: a real HTTP request
     * through `app.inject()` against the real Fastify route. Everything
     * from here on — the attach request landing in Redis, the worker's
     * listener picking it up, `SitePipeline` attaching and self-chaining,
     * the row reaching a terminal status — happens because the real
     * production wiring makes it happen, not because the test drove any of
     * the intermediate steps directly.
     */
    const response = await app.inject({
      method: "POST",
      url: `/sites/${site.row.id}/runs`
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as { readonly id: string };

    expect(body.id).toEqual(expect.any(String));

    const finished = await waitForTerminalRun(site.scope, body.id, 60_000);

    // GREEN, not merely present: a run stuck `pending`/`running`/`queued`
    // past the deadline throws inside `waitForTerminalRun` instead of
    // reaching this line at all.
    expect(finished?.status).toBe("complete");

    // Real ingestion happened — not just an accepted HTTP request. Both
    // patterns exist with exactly-counted populations, which only a
    // completed `ingest` stage produces.
    const patterns = await listPatternsByPopulation(
      db,
      site.scope,
      body.id,
      10
    );

    expect(patterns.map((pattern) => pattern.template).sort()).toEqual([
      "/missing/{param}",
      "/page/{param}"
    ]);

    // Real verification and estimation happened for every pattern — the
    // fan-in through `verify` → `estimate` → `finalize` actually completed,
    // not merely `ingest`.
    for (const pattern of patterns) {
      const snapshots = await findSnapshotsByPattern(
        db,
        site.scope,
        pattern.id
      );

      expect(snapshots.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("one HTTP request produces exactly one run, even though the API and the worker are two processes talking over a queue", async () => {
    /**
     * TASK 15 — IDEMPOTENCY, EXPOSED RATHER THAN REDESIGNED. `startRun`'s
     * partial unique index is what the API relies on to answer 409 for a
     * concurrent second call (`ActiveRunExistsError`, mapped in
     * `routes/sites.ts`); this proves that guarantee holds when the
     * "second call" arrives through the real HTTP route while the first
     * run is still genuinely in flight through the real queue, not just
     * against two direct repository calls.
     */
    const org = await createOrganization(db, {
      name: "Run Trigger E2E Idempotency Org",
      slug: `run-trigger-e2e-idem-${Date.now()}`
    });

    resetOrgScopeCacheForTesting();

    const idempotencyApp = buildApp(
      {
        NODE_ENV: "test",
        DEFAULT_ORGANIZATION_SLUG: org.row.slug,
        ...loadPolicyConfig({})
      },
      createLogger({
        service: "run-trigger-e2e-idempotency",
        level: "silent",
        pretty: false
      }),
      db,
      runTrigger
    );

    await idempotencyApp.ready();

    const site = await createSite(db, org.scope, {
      name: "Idempotency Site",
      baseUrl
    });

    const first = await idempotencyApp.inject({
      method: "POST",
      url: `/sites/${site.row.id}/runs`
    });

    expect(first.statusCode).toBe(201);

    const second = await idempotencyApp.inject({
      method: "POST",
      url: `/sites/${site.row.id}/runs`
    });

    expect(second.statusCode).toBe(409);

    const runId = (first.json() as { readonly id: string }).id;

    await waitForTerminalRun(site.scope, runId, 60_000);
    await idempotencyApp.close();
  }, 60_000);
});

describe("the attach-requests queue's failure protection", () => {
  it("carries the same retry/backoff policy as the pipeline's own stage queues", async () => {
    /**
     * TASK 7 — asserted directly against the real queue's job options
     * rather than only read from `run-trigger.ts`'s source: this is what a
     * job added through `createRunTrigger` is actually configured with once
     * it reaches Redis.
     */
    const inspectionQueue = new Queue(ATTACH_REQUESTS_QUEUE, {
      connection: triggerConnection
    });

    const org = await createOrganization(db, {
      name: "Retry Policy Org",
      slug: `run-trigger-e2e-retry-${Date.now()}`
    });

    const site = await createSite(db, org.scope, {
      name: "Retry Policy Site",
      baseUrl
    });

    // A REAL run row, not a placeholder id — the same worker started in
    // `beforeAll` is actively consuming this queue, so an unresolvable
    // `sitemapRunId` here would send a genuine job through three real
    // retries against a row that can never exist, wasting the run rather
    // than proving the policy.
    const run = await startRun(db, site.scope, { workerId: "retry-policy" });

    await runTrigger.requestRun({
      organizationId: org.scope.organizationId,
      siteId: site.row.id,
      tier: "standard",
      sitemapRunId: run.id,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    const jobs = await inspectionQueue.getJobs([
      "waiting",
      "completed",
      "active"
    ]);
    const job = jobs.find((candidate) => candidate.data.siteId === site.row.id);

    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({
      type: "exponential",
      delay: 5_000
    });

    await inspectionQueue.close();

    // Let the worker actually finish this run rather than leaving it
    // in flight when `afterAll` tears the harness down.
    await waitForTerminalRun(site.scope, run.id, 60_000);
  }, 60_000);
});
