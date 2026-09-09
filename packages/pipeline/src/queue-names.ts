/**
 * Queue and Redis-key namespacing.
 *
 * One shared queue per stage is the thing this exists to prevent. A single
 * 90-million-URL site enqueues tens of thousands of jobs, and on a shared queue
 * every other site's work sits behind them — a fleet of 650 sites where one
 * bulk-tier site can stall a priority-tier one is the isolation failure the
 * legacy tool had, and it is not visible in testing because it needs a large
 * site and a small one at the same time.
 *
 * The namespace is `{tier}.{siteId}.{stage}`, so a worker can be pointed at one
 * tier, one site, or one stage without touching the others, and Redis keys for
 * two sites can never collide.
 *
 * THE SEPARATOR IS `.`, NOT `:` — corrected here rather than left as
 * originally designed. `:` was the separator this scheme was documented with
 * from M5 onward, and every prose description of it elsewhere in this
 * codebase still says so; that documentation is a historical record now, not
 * a spec to re-derive from. BullMQ's own `Queue`/`Worker` constructors THROW
 * on any name containing `:` — it is the delimiter BullMQ's own Redis keys use
 * internally (`bull:{queueName}:wait`, etc.), so a queue name containing one
 * would corrupt BullMQ's own key parsing. This was never caught because
 * nothing before the Phase 1 orchestration work ever constructed a real
 * BullMQ `Queue` or `Worker` with a name this function produced — the
 * pure-string tests here could not have found it, and `packages/pipeline`'s
 * own e2e suite is deliberately Redis-free by design (see `deps.ts`). The
 * first real `SitePipeline` test against a real Redis failed on construction,
 * immediately, for every site.
 */

export const PIPELINE_STAGES = [
  /** Fetch the sitemap (or index) and enumerate the files it names. */
  "discover",
  /**
   * One streaming pass: download each file, extract patterns, count
   * populations, and draw the sample. All four in one pass because that is
   * M2's whole point — the alternative needs a re-read of every `<loc>` per
   * question asked.
   */
  "ingest",
  /** Resolve one pattern's sample to URLs and probe them. */
  "verify",
  /** Turn one pattern's observations into a claim: interval, band, impact. */
  "estimate",
  /** Close the run: health figures, status, and why if it is degraded. */
  "finalize"
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * The one queue that is NOT per-site.
 *
 * Every stage queue needs a `Worker` already listening before a job on it can
 * run, which means something has to attach a site's five queues before the
 * first `discover` job can be enqueued onto any of them. `apps/worker` has no
 * fleet-wide read to decide which sites need attaching on its own — that read
 * is deliberately not built (see `attachSite`'s own docblock) — so instead
 * the caller who already knows a specific site's `organizationId`/`tier`
 * (the API, handling a request for that one site) posts a small message here,
 * and the worker's own listener on this single well-known queue attaches that
 * one site and starts its run. No enumeration, no cross-tenant read: every
 * message names exactly the site it is about.
 */
export const ATTACH_REQUESTS_QUEUE = "attach-requests";

export const SITE_TIERS = ["standard", "priority", "bulk"] as const;

export type SiteTier = (typeof SITE_TIERS)[number];

/** Thrown when a queue name would be ambiguous or unparseable. */
export class InvalidQueueNameError extends Error {
  public override readonly name = "InvalidQueueNameError";
}

/**
 * A site id is a UUID everywhere in this system, and the separator is `.`.
 *
 * Checked rather than assumed because the name is also a Redis key prefix: a
 * site id containing the separator would silently split into a different
 * namespace, and two sites could then share one. A UUID cannot contain `.`,
 * so this check alone is what makes that structurally impossible rather than
 * merely unlikely. Cheap check, unrecoverable failure.
 */
const SITE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface QueueAddress {
  readonly tier: SiteTier;
  readonly siteId: string;
  readonly stage: PipelineStage;
}

/**
 * Build the queue name for one site's stage.
 *
 * Deliberately a function and not a template literal at each call site: the
 * shape is a contract between the API that enqueues and the worker that
 * consumes, and a typo in one of them produces a queue nothing reads rather
 * than an error.
 */
export function queueName(address: QueueAddress): string {
  if (!SITE_ID_PATTERN.test(address.siteId)) {
    throw new InvalidQueueNameError(
      `siteId must be a UUID to be used as a queue namespace; got "${address.siteId}"`
    );
  }

  return `${address.tier}.${address.siteId}.${address.stage}`;
}

/**
 * Parse a queue name back into its parts.
 *
 * Used by the admin surface to answer "whose jobs are these?" from a queue
 * listing, which is otherwise a wall of opaque strings.
 */
export function parseQueueName(name: string): QueueAddress {
  const parts = name.split(".");

  if (parts.length !== 3) {
    throw new InvalidQueueNameError(
      `expected "{tier}.{siteId}.{stage}", got "${name}"`
    );
  }

  const [tier, siteId, stage] = parts;

  if (
    tier === undefined ||
    siteId === undefined ||
    stage === undefined ||
    !isSiteTier(tier) ||
    !isPipelineStage(stage) ||
    !SITE_ID_PATTERN.test(siteId)
  ) {
    throw new InvalidQueueNameError(
      `"${name}" is not a valid pipeline queue name`
    );
  }

  return { tier, siteId, stage };
}

export function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

export function isSiteTier(value: string): value is SiteTier {
  return (SITE_TIERS as readonly string[]).includes(value);
}

/**
 * Every queue one site occupies.
 *
 * A worker process takes this list rather than subscribing to a wildcard,
 * because BullMQ has no wildcard consumer and faking one by polling key
 * patterns is how a scheduler ends up scanning Redis in a hot loop.
 */
export function queueNamesForSite(
  tier: SiteTier,
  siteId: string
): readonly string[] {
  return PIPELINE_STAGES.map((stage) => queueName({ tier, siteId, stage }));
}
