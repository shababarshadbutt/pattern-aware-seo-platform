import { Readable } from "node:stream";

import { createDatabase } from "@pattern-aware/database";
import type { SitemapResponse } from "@pattern-aware/pipeline";
import {
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "@pattern-aware/sampling";
import { createLogger, getConfig } from "@pattern-aware/shared";
import {
  LocalDiskFileStore,
  type OversizeThresholds
} from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { Redis } from "ioredis";

import {
  createAttachRequestsWorker,
  createSiteAttacher
} from "./attach-requests-worker.js";
import { sweepStaleRuns } from "./stale-run-sweeper.js";

/**
 * The worker process: attaches pipeline queues for the sites with work in
 * flight, and detaches when they finish.
 *
 * Per-site queues mean there is no single queue to sit on, so this supervises
 * a set of `SitePipeline`s instead, via `createSiteAttacher`
 * (`attach-requests-worker.ts`). See that file for why the set is bounded by
 * runs in flight rather than by the whole fleet.
 */

// Fail fast and loudly on bad configuration, before anything connects.
const config = getConfig();
const logger = createLogger({
  service: "worker",
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development"
});

// BullMQ requires this to be null rather than a retry count: a blocking command
// that gives up mid-wait leaves the worker silently not consuming.
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

const database = createDatabase({
  connectionString: config.DATABASE_URL,
  /**
   * Budgeted separately from the API's pool.
   *
   * An ingest pass streaming a large site must not be able to exhaust the
   * shared connections the API needs to answer a dashboard request — the
   * "population scan starves the API" failure the architecture plan names.
   */
  maxConnections: config.WORKER_DB_POOL_SIZE
});

/**
 * ONE limiter and ONE breaker for the whole process, shared by every site.
 *
 * Both key on host, and their state is only meaningful shared: two sites on the
 * same CDN host must draw on the same per-host allowance, or the origin sees
 * double the rate that was agreed with it. Their in-memory nature is the known
 * limitation — the budget multiplies by container count until M7 replaces them
 * with Redis-backed equivalents.
 */
const rateLimiter = new HostRateLimiter({
  requestsPerSecond: config.HTTP_PER_HOST_REQUESTS_PER_SECOND,
  concurrency: config.HTTP_PER_HOST_CONCURRENCY
});

const circuitBreaker = new HostCircuitBreaker({
  openAfter429: config.HTTP_CIRCUIT_BREAK_AFTER_429,
  openAfter403: config.HTTP_CIRCUIT_BREAK_AFTER_403,
  cooldownMs: config.HTTP_CIRCUIT_COOLDOWN_MS
});

const store = new LocalDiskFileStore(config.SITEMAP_STORE_ROOT);

/**
 * The sampling budget, assembled from config ONCE, here.
 *
 * Read at the process edge and handed to the stages rather than read inside
 * them. A stage that called `getConfig()` itself would require the whole
 * validated environment to be present just to learn a sample-size floor —
 * which is how a handler that needs neither Redis nor a database ends up
 * unable to run without both. `sampleRate` has no env override yet, so it
 * comes from the package default.
 */
const sampleBudget: SampleBudget = {
  sampleRate: DEFAULT_SAMPLE_BUDGET.sampleRate,
  minSample: config.SAMPLE_MIN_SIZE,
  maxFirstRound: config.SAMPLE_MAX_FIRST_ROUND,
  maxExpanded: config.SAMPLE_MAX_EXPANDED,
  maxExpansionFactor: config.SAMPLE_MAX_EXPANSION_FACTOR,
  maxPopulationFraction: config.SAMPLE_MAX_POPULATION_FRACTION,
  minPerStratum: config.SAMPLE_MIN_PER_STRATUM
};

/**
 * Phase 2A wires only the file-count hard limit through — the soft limit and
 * the URL-based hard limit stay at `Infinity` so they cannot fire yet, even
 * though `POPULATION_SOFT_LIMIT_URLS`/`POPULATION_HARD_LIMIT_URLS` are
 * already validated config. Wiring those is scoped as a fast-follow, not
 * dropped silently.
 */
const oversizeThresholds: OversizeThresholds = {
  softLimitUrls: Number.POSITIVE_INFINITY,
  hardLimitUrls: Number.POSITIVE_INFINITY,
  hardLimitFiles: config.POPULATION_HARD_LIMIT_FILES
};

/** Fetch a sitemap. The one place the pipeline reaches the open internet. */
async function fetchSitemap(url: string): Promise<SitemapResponse> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)"
    }
  });

  return {
    status: response.status,
    headers: new Map(response.headers as unknown as Iterable<[string, string]>),
    body:
      response.body === null
        ? Readable.from([])
        : Readable.fromWeb(
            response.body as Parameters<typeof Readable.fromWeb>[0]
          )
  };
}

/**
 * FLEET-WIDE AUTO-ATTACH IS NOT WIRED, and is left as a stated gap.
 *
 * See `createSiteAttacher`'s own docblock in `attach-requests-worker.ts` for
 * the full reasoning; this process just supplies the real dependencies.
 */
const attacher = createSiteAttacher({
  connection,
  db: database.db,
  store,
  logger,
  fetchSitemap,
  rateLimiter,
  circuitBreaker,
  sampleBudget,
  oversizeThresholds
});

/** Kept as a named export for parity with the pre-extraction API. */
export const attachSite = attacher.attachSite;

const attachRequestsWorker = createAttachRequestsWorker({
  connection,
  logger,
  attacher
});

/**
 * The stale-run sweeper: the backstop for a worker PROCESS dying mid-run,
 * where no BullMQ "failed" event ever fires because nothing survives to fire
 * it. See `sweepStaleRuns`'s own docblock for why this needs no `SiteScope`.
 */
const sweepInterval = setInterval(() => {
  sweepStaleRuns(
    database.db,
    logger,
    config.HEARTBEAT_STALE_THRESHOLD_MS
  ).catch((error: unknown) => {
    logger.error({ err: error }, "stale-run sweep failed");
  });
}, config.HEARTBEAT_SWEEP_INTERVAL_MS);

logger.info(
  {
    perHostRps: config.HTTP_PER_HOST_REQUESTS_PER_SECOND,
    perHostConcurrency: config.HTTP_PER_HOST_CONCURRENCY,
    heartbeatStaleThresholdMs: config.HEARTBEAT_STALE_THRESHOLD_MS
  },
  "worker started; listening for attach requests"
);

/**
 * Detach every site before closing Redis, so an in-flight job finishes and
 * releases its lock. Killing the connection first would leave the job stalled
 * until BullMQ's lock expiry reclaimed it and handed out a duplicate.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutdown signal received, detaching sites");

    clearInterval(sweepInterval);

    Promise.all([attachRequestsWorker.close(), attacher.stopAll()])
      .then(async () => {
        await database.close();
        await connection.quit();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "worker failed to shut down cleanly");
        process.exit(1);
      });
  });
}
