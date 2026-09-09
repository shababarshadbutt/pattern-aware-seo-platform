import type { Database, SiteScope } from "@pattern-aware/database";
import type { SampleBudget } from "@pattern-aware/sampling";
import type { Logger } from "@pattern-aware/shared";
import type {
  OversizeThresholds,
  SitemapFileStore
} from "@pattern-aware/sitemap";
import type {
  HostCircuitBreaker,
  HostRateLimiter,
  ProbeOptions
} from "@pattern-aware/verification";

import type { PipelineStage } from "./queue-names.js";

/**
 * What a stage needs from the outside world.
 *
 * BULLMQ IS DELIBERATELY ABSENT. A stage handler takes an `enqueue` function,
 * not a `Queue`, so every stage is a plain async function testable against a
 * real Postgres and a fake HTTP server with no Redis anywhere. The worker is
 * the only thing that knows BullMQ exists — which also means the queue library
 * could be replaced without touching a single line of pipeline logic.
 */

/** Minimal shape of a sitemap download, so tests need no network. */
export interface SitemapResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: AsyncIterable<Uint8Array>;
}

export type SitemapFetcher = (url: string) => Promise<SitemapResponse>;

/** Hands a follow-on job to whatever is actually running the pipeline. */
export type EnqueueStage = (
  stage: PipelineStage,
  payload: Record<string, unknown>
) => Promise<void>;

/**
 * One thing worth timing or counting inside the `verify` stage.
 *
 * Deliberately does NOT carry a "have we resolved this file before" flag:
 * "already resolved once" only means something relative to whatever window
 * the caller considers "the same run" (a whole benchmark process, a single
 * site's run, etc.), and `runVerify` itself has no such notion — it only
 * ever sees one pattern's one job. A caller that wants cross-call
 * repetition (e.g. scripts/benchmark-scale.ts, per
 * docs/reports/phase-2b-prior-art-analysis.md §11) tracks its own
 * `Set<fileOrdinal>` across the `resolveCandidates` events it receives.
 * Keeping that bookkeeping out of this event is what keeps `resolveAll`
 * stateless.
 */
export type VerifyTelemetryEvent =
  | {
      readonly kind: "resolveCandidates";
      readonly fileOrdinal: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: "verifyProbe";
      readonly durationMs: number;
    }
  | {
      readonly kind: "candidateFileSpread";
      readonly patternId: string;
      readonly distinctFiles: number;
    };

export interface PipelineDeps {
  readonly db: Database;
  readonly store: SitemapFileStore;
  readonly logger: Logger;
  readonly fetchSitemap: SitemapFetcher;
  readonly enqueue: EnqueueStage;
  /**
   * PROCESS-WIDE, not per job — and that is the whole point of putting them
   * here.
   *
   * Both hold per-host state that only means anything when it is shared: a rate
   * limiter constructed per pattern would let a hundred concurrent patterns each
   * open their own allowance against one host and send a hundred times the
   * agreed rate, and a per-job circuit breaker would forget that the host just
   * refused the previous ninety-nine patterns. Neither failure shows up in a
   * single-pattern test.
   *
   * Their own limitation is documented in packages/verification: this state is
   * in-memory, so it multiplies by the container count. Redis-backed
   * replacements are M7.
   */
  readonly rateLimiter?: HostRateLimiter;
  readonly circuitBreaker?: HostCircuitBreaker;
  /** Injected for tests; falls through to undici in deployment. */
  readonly probeFetch?: ProbeOptions["fetch"];
  /**
   * Report how far a long-running stage has gotten, as a fraction in [0, 1].
   *
   * OPTIONAL, and its absence changes nothing about correctness — no stage's
   * result depends on whether progress was reported. `ingest` is the one
   * caller (its per-file loop is the only stage-internal work worth
   * surfacing mid-flight); `apps/worker` wires this to BullMQ's
   * `job.updateProgress`, a fresh closure per job since progress belongs to
   * one job, not to the whole site the way `enqueue` does. Test callers can
   * simply omit it.
   */
  readonly reportProgress?: (fraction: number) => Promise<void>;
  /**
   * The sampling budget, INJECTED rather than read from global config.
   *
   * A stage that called `getConfig()` would drag the whole validated
   * environment in with it — and `getConfig` validates every key, so reading a
   * sample-size floor made the stage require `REDIS_URL` and `DATABASE_URL` to
   * be present. That is how a pure handler stops being testable without a full
   * environment, and it failed in CI while passing locally off a developer
   * `.env`, which is the worst version of the problem. The worker assembles
   * this from config once at startup, where reading config belongs.
   */
  readonly sampleBudget?: SampleBudget;
  /**
   * How big a run is allowed to get before `ingest` stops discovering more
   * files rather than continuing indefinitely, INJECTED the same way as
   * `sampleBudget` and for the same reason.
   *
   * Phase 2A wires only the file-count hard limit into `ingest.ts` — a
   * caller that omits this falls back to `@pattern-aware/sitemap`'s
   * `DEFAULT_OVERSIZE_THRESHOLDS`, which leaves the URL-based limits at
   * `Infinity` so they cannot fire on this round's behalf. The worker
   * supplies the real configured value at startup.
   */
  readonly oversizeThresholds?: OversizeThresholds;
  /**
   * Read-only timing/counting hook for verify-stage instrumentation.
   *
   * OPTIONAL and side-effect-only on whatever the caller does with the
   * events — nothing in `runVerify`/`resolveAll` branches on whether this is
   * present, and no return value feeds back into pipeline behavior or the
   * observations written to the database. Built for
   * scripts/benchmark-scale.ts (see docs/reports/phase-2b-prior-art-analysis.md
   * §11) to measure candidate-resolution time/repetition separately from
   * HTTP-probe time; `apps/worker` omits it.
   */
  readonly onVerifyTelemetry?: (event: VerifyTelemetryEvent) => void;
}

/**
 * Confirm the job's site matches the scope the worker built.
 *
 * The queue name carries the site id and so does the payload. They agree in
 * every normal case, and if they ever disagree something has enqueued a job
 * into the wrong site's lane — which, without this check, writes one tenant's
 * rows under another tenant's id. That is the single worst outcome available in
 * a multi-tenant system, so it is checked on every job rather than reasoned
 * about.
 */
export function assertScopeMatchesPayload(
  scope: SiteScope,
  payload: { readonly siteId: string },
  stage: PipelineStage
): void {
  if (scope.siteId !== payload.siteId) {
    throw new Error(
      `stage "${stage}" received a job for site ${payload.siteId} while scoped to ${scope.siteId} — refusing to write across a tenant boundary`
    );
  }
}
