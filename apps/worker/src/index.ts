import { Readable } from "node:stream";

import { createDatabase } from "@pattern-aware/database";
import type { SitemapResponse, SiteTier } from "@pattern-aware/pipeline";
import {
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "@pattern-aware/sampling";
import { createLogger, getConfig } from "@pattern-aware/shared";
import { LocalDiskFileStore } from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { Redis } from "ioredis";

import { SitePipeline } from "./site-pipeline.js";

/**
 * The worker process: attaches pipeline queues for the sites with work in
 * flight, and detaches when they finish.
 *
 * Per-site queues mean there is no single queue to sit on, so this supervises
 * a set of {@link SitePipeline}s instead. See that file for why the set is
 * bounded by runs in flight rather than by the whole fleet.
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

const attached = new Map<string, SitePipeline>();

/**
 * FLEET-WIDE AUTO-ATTACH IS NOT WIRED, and is left as a stated gap.
 *
 * Attaching needs to enumerate sites across every organization, and every
 * repository read is organization- or site-scoped by construction (ADR-0004) —
 * correctly, since that is what makes a cross-tenant query a compile error.
 * A worker legitimately needs a fleet-wide read, which is a new scope origin
 * (`systemOrganizationScope` exists for exactly this shape) plus a repository
 * that answers "which sites have a run in flight". Adding it is small; deciding
 * that the worker may read across tenants is not, and it is the kind of hole
 * that gets punched casually and never closed.
 *
 * Until then a run is attached explicitly, which is what the API will call and
 * what the end-to-end test exercises directly.
 */
export async function attachSite(input: {
  readonly organizationId: string;
  readonly siteId: string;
  readonly tier: SiteTier;
}): Promise<SitePipeline> {
  const existing = attached.get(input.siteId);

  if (existing !== undefined) {
    return existing;
  }

  const pipeline = new SitePipeline({
    connection,
    db: database.db,
    store,
    logger,
    organizationId: input.organizationId,
    siteId: input.siteId,
    tier: input.tier,
    fetchSitemap,
    rateLimiter,
    circuitBreaker,
    sampleBudget
  });

  pipeline.start();
  attached.set(input.siteId, pipeline);

  return pipeline;
}

logger.info(
  {
    perHostRps: config.HTTP_PER_HOST_REQUESTS_PER_SECOND,
    perHostConcurrency: config.HTTP_PER_HOST_CONCURRENCY
  },
  "worker started; awaiting site attachments"
);

/**
 * Detach every site before closing Redis, so an in-flight job finishes and
 * releases its lock. Killing the connection first would leave the job stalled
 * until BullMQ's lock expiry reclaimed it and handed out a duplicate.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutdown signal received, detaching sites");

    Promise.all([...attached.values()].map(async (p) => p.stop()))
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
