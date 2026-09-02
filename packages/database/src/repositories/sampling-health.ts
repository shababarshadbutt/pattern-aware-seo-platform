import { and, desc, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { samplingHealth } from "../schema/observability.js";
import type { SiteScope } from "../scope.js";

/**
 * Per-window operational health for one site's sampling.
 *
 * These are the SLI inputs, not a dashboard convenience. Two of them are
 * paging signals in their own right: a site whose patterns are mostly at LOW
 * confidence is producing numbers nobody should act on, and a GET-escalation
 * rate climbing fleet-wide means the request budget is being spent on
 * escalations rather than coverage.
 */

export interface SamplingHealthRow {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly patternsTotal: number;
  readonly patternsLowConfidence: number;
  readonly patternsExpanded: number;
  readonly patternsBlocked: number;
  readonly patternsNeedsReview: number;
  readonly samplesDrawn: number;
  readonly httpRequests: number;
  readonly getEscalations: number;
  readonly circuitBreaks: number;
}

const COLUMNS = {
  id: samplingHealth.id,
  siteId: samplingHealth.siteId,
  sitemapRunId: samplingHealth.sitemapRunId,
  windowStart: samplingHealth.windowStart,
  windowEnd: samplingHealth.windowEnd,
  patternsTotal: samplingHealth.patternsTotal,
  patternsLowConfidence: samplingHealth.patternsLowConfidence,
  patternsExpanded: samplingHealth.patternsExpanded,
  patternsBlocked: samplingHealth.patternsBlocked,
  patternsNeedsReview: samplingHealth.patternsNeedsReview,
  samplesDrawn: samplingHealth.samplesDrawn,
  httpRequests: samplingHealth.httpRequests,
  getEscalations: samplingHealth.getEscalations,
  circuitBreaks: samplingHealth.circuitBreaks
} as const;

export interface SamplingHealthUpsert {
  /**
   * REQUIRED, though the column is nullable.
   *
   * `sitemap_run_id` is null for the cross-run daily rollup the schema
   * anticipates, and `uq_sampling_health_site_run_window` includes it. Postgres
   * treats NULLs as distinct in a unique index, so `ON CONFLICT` can never
   * match a null-run row and this upsert would insert a duplicate on every call
   * instead of updating — silently, since an insert that was meant to be an
   * update looks exactly like a successful insert. Rather than leave that trap
   * open, the run-scoped path demands a run id, and the rollup will need its
   * own function that reconciles the null case deliberately.
   */
  readonly sitemapRunId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly patternsTotal?: number;
  readonly patternsLowConfidence?: number;
  readonly patternsExpanded?: number;
  readonly patternsBlocked?: number;
  readonly patternsNeedsReview?: number;
  readonly samplesDrawn?: number;
  readonly httpRequests?: number;
  readonly getEscalations?: number;
  readonly circuitBreaks?: number;
}

/**
 * Record or replace one window's health figures.
 *
 * `DO UPDATE` with absolute values rather than increments: a retried
 * finalisation must converge on the truth rather than double what it already
 * counted, and every figure here is derivable from the run's own rows, so the
 * recomputed value is authoritative.
 */
export async function upsertSamplingHealth(
  db: Database,
  scope: SiteScope,
  input: SamplingHealthUpsert
): Promise<SamplingHealthRow> {
  const values = {
    siteId: scope.siteId,
    sitemapRunId: input.sitemapRunId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    patternsTotal: input.patternsTotal ?? 0,
    patternsLowConfidence: input.patternsLowConfidence ?? 0,
    patternsExpanded: input.patternsExpanded ?? 0,
    patternsBlocked: input.patternsBlocked ?? 0,
    patternsNeedsReview: input.patternsNeedsReview ?? 0,
    samplesDrawn: input.samplesDrawn ?? 0,
    httpRequests: input.httpRequests ?? 0,
    getEscalations: input.getEscalations ?? 0,
    circuitBreaks: input.circuitBreaks ?? 0
  };

  const [row] = await internalDatabase(db)
    .insert(samplingHealth)
    .values(values)
    .onConflictDoUpdate({
      target: [
        samplingHealth.siteId,
        samplingHealth.sitemapRunId,
        samplingHealth.windowStart
      ],
      set: {
        windowEnd: values.windowEnd,
        patternsTotal: values.patternsTotal,
        patternsLowConfidence: values.patternsLowConfidence,
        patternsExpanded: values.patternsExpanded,
        patternsBlocked: values.patternsBlocked,
        patternsNeedsReview: values.patternsNeedsReview,
        samplesDrawn: values.samplesDrawn,
        httpRequests: values.httpRequests,
        getEscalations: values.getEscalations,
        circuitBreaks: values.circuitBreaks,
        updatedAt: sql`now()`
      }
    })
    .returning(COLUMNS);

  if (row === undefined) {
    throw new Error("sampling_health upsert returned no row");
  }

  return row;
}

/** The most recent windows for a site, newest first. */
export async function listSamplingHealth(
  db: Database,
  scope: SiteScope,
  limit = 30
): Promise<readonly SamplingHealthRow[]> {
  return internalDatabase(db)
    .select(COLUMNS)
    .from(samplingHealth)
    .where(eq(samplingHealth.siteId, scope.siteId))
    .orderBy(desc(samplingHealth.windowEnd))
    .limit(limit);
}

/** One run's health row, when it has been finalised. */
export async function findRunSamplingHealth(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<SamplingHealthRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(samplingHealth)
    .where(
      and(
        eq(samplingHealth.siteId, scope.siteId),
        eq(samplingHealth.sitemapRunId, sitemapRunId)
      )
    )
    .orderBy(desc(samplingHealth.windowEnd))
    .limit(1);

  return row;
}
