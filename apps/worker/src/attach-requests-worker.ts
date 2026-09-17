import type { Database } from "@pattern-aware/database";
import {
  ATTACH_REQUESTS_QUEUE,
  attachRequestPayloadSchema,
  parsePayload,
  type SitemapResponse,
  type SiteTier
} from "@pattern-aware/pipeline";
import type { SampleBudget } from "@pattern-aware/sampling";
import type { Logger } from "@pattern-aware/shared";
import type {
  OversizeThresholds,
  SitemapFileStore
} from "@pattern-aware/sitemap";
import type {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";

import { SitePipeline } from "./site-pipeline.js";

/**
 * The site-attaching half of the worker process, and the BullMQ `Worker` that
 * drives it from real jobs — pulled out of `index.ts` so both the production
 * bootstrap and a real-infrastructure integration test construct the exact
 * same objects rather than a test re-deriving this wiring by hand. See
 * `apps/api/test/run-trigger.e2e.test.ts`, which is the reason this file
 * exists as something importable rather than a top-level script effect.
 */

export interface SiteAttacherOptions {
  readonly connection: Redis;
  readonly db: Database;
  readonly store: SitemapFileStore;
  readonly logger: Logger;
  readonly fetchSitemap: (url: string) => Promise<SitemapResponse>;
  readonly rateLimiter: HostRateLimiter;
  readonly circuitBreaker: HostCircuitBreaker;
  readonly sampleBudget: SampleBudget;
  readonly oversizeThresholds: OversizeThresholds;
}

export interface SiteAttacher {
  /** Attach one site's queues (a no-op if already attached), idempotently. */
  readonly attachSite: (input: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly tier: SiteTier;
  }) => Promise<SitePipeline>;
  /** Every site currently attached, keyed by site id. */
  readonly attached: ReadonlyMap<string, SitePipeline>;
  /** Detach every attached site, letting in-flight jobs finish. */
  readonly stopAll: () => Promise<void>;
}

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
 * Until then a run is attached explicitly: the API posts to
 * `ATTACH_REQUESTS_QUEUE` (see `createAttachRequestsWorker` below), and that
 * whole hop — real HTTP route, real queue, real worker, real pipeline — is
 * what `apps/api/test/run-trigger.e2e.test.ts` exercises directly.
 */
export function createSiteAttacher(options: SiteAttacherOptions): SiteAttacher {
  const attached = new Map<string, SitePipeline>();

  async function attachSite(input: {
    readonly organizationId: string;
    readonly siteId: string;
    readonly tier: SiteTier;
  }): Promise<SitePipeline> {
    const existing = attached.get(input.siteId);

    if (existing !== undefined) {
      return existing;
    }

    const pipeline = new SitePipeline({
      connection: options.connection,
      db: options.db,
      store: options.store,
      logger: options.logger,
      organizationId: input.organizationId,
      siteId: input.siteId,
      tier: input.tier,
      fetchSitemap: options.fetchSitemap,
      rateLimiter: options.rateLimiter,
      circuitBreaker: options.circuitBreaker,
      sampleBudget: options.sampleBudget,
      oversizeThresholds: options.oversizeThresholds
    });

    pipeline.start();
    attached.set(input.siteId, pipeline);

    return pipeline;
  }

  return {
    attachSite,
    attached,
    async stopAll() {
      await Promise.all([...attached.values()].map(async (p) => p.stop()));
    }
  };
}

export interface AttachRequestsWorkerOptions {
  readonly connection: Redis;
  readonly logger: Logger;
  readonly attacher: SiteAttacher;
}

/**
 * The one thing that lets a worker process start any work at all: a listener
 * on the single well-known queue a caller posts to when it wants a specific
 * site attached and a specific run started. See `ATTACH_REQUESTS_QUEUE`'s own
 * docblock for why this is a queue message rather than a fleet-wide poll — the
 * short version is that attaching needs no enumeration when the caller already
 * knows exactly which site it means.
 *
 * Concurrency is deliberately 1: attach requests are rare and cheap, and
 * serializing them avoids two requests for the same new site racing
 * `attachSite`'s own idempotent-but-not-atomic `Map` check.
 */
export function createAttachRequestsWorker(
  options: AttachRequestsWorkerOptions
): Worker {
  const worker = new Worker(
    ATTACH_REQUESTS_QUEUE,
    async (job: Job) => {
      const request = parsePayload(
        attachRequestPayloadSchema,
        "attach-request",
        job.data
      );

      const pipeline = await options.attacher.attachSite({
        organizationId: request.organizationId,
        siteId: request.siteId,
        tier: request.tier
      });

      await pipeline.startRun({
        sitemapRunId: request.sitemapRunId,
        sitemapUrl: request.sitemapUrl,
        baseUrl: request.baseUrl,
        expectedHost: request.expectedHost
      });

      options.logger.info(
        { siteId: request.siteId, sitemapRunId: request.sitemapRunId },
        "site attached and run started"
      );
    },
    {
      connection: options.connection,
      concurrency: 1
    }
  );

  worker.on("failed", (job, error) => {
    options.logger.error(
      { jobId: job?.id, err: error },
      "attach request failed"
    );
  });

  return worker;
}
