import { and, desc, eq, gt, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { patternSample } from "../schema/sampling.js";
import type { SiteScope } from "../scope.js";

/**
 * The record of one draw.
 *
 * Stores what the draw was, not what it found: K, the threshold hash the heap
 * settled on, and the population at the moment of drawing. That last one is the
 * denominator the estimate used, kept here rather than read back from
 * `pattern.population_count` because a later run moves that number, and an
 * estimate has to stay reconstructible against the N it was actually computed
 * from.
 */

export interface PatternSampleRow {
  readonly id: string;
  readonly siteId: string;
  readonly patternId: string;
  readonly sitemapRunId: string;
  readonly round: number;
  readonly method: "min_heap_by_hash";
  readonly kRequested: number;
  readonly kThresholdHash: number;
  readonly sampleSize: number;
  readonly populationAtDraw: number;
  readonly stratumCount: number;
  readonly drawnAt: Date;
}

const COLUMNS = {
  id: patternSample.id,
  siteId: patternSample.siteId,
  patternId: patternSample.patternId,
  sitemapRunId: patternSample.sitemapRunId,
  round: patternSample.round,
  method: patternSample.method,
  kRequested: patternSample.kRequested,
  kThresholdHash: patternSample.kThresholdHash,
  sampleSize: patternSample.sampleSize,
  populationAtDraw: patternSample.populationAtDraw,
  stratumCount: patternSample.stratumCount,
  drawnAt: patternSample.drawnAt
} as const;

export interface RecordSampleInput {
  readonly patternId: string;
  readonly sitemapRunId: string;
  readonly round?: number;
  readonly kRequested: number;
  readonly kThresholdHash: number;
  readonly sampleSize: number;
  readonly populationAtDraw: number;
  readonly stratumCount?: number;
}

/**
 * Record a draw, or return the one already recorded for that round.
 *
 * Idempotent on `(pattern, round)` so a retried sample job does not create a
 * second draw for the same round — which would leave two `pattern_sample` rows
 * competing to be the denominator of one pattern's estimate.
 */
export async function recordPatternSample(
  db: Database,
  scope: SiteScope,
  input: RecordSampleInput
): Promise<PatternSampleRow> {
  const round = input.round ?? 1;

  const [inserted] = await internalDatabase(db)
    .insert(patternSample)
    .values({
      siteId: scope.siteId,
      patternId: input.patternId,
      sitemapRunId: input.sitemapRunId,
      round,
      kRequested: input.kRequested,
      kThresholdHash: input.kThresholdHash,
      sampleSize: input.sampleSize,
      populationAtDraw: input.populationAtDraw,
      stratumCount: input.stratumCount ?? 1
    })
    .onConflictDoNothing({
      target: [
        patternSample.siteId,
        patternSample.patternId,
        patternSample.round
      ]
    })
    .returning(COLUMNS);

  if (inserted !== undefined) {
    return inserted;
  }

  const existing = await findPatternSample(db, scope, input.patternId, round);

  if (existing === undefined) {
    /**
     * The insert conflicted, so a row exists — but it is not visible in this
     * scope, which means the caller is holding a scope for a different site
     * than the pattern belongs to. Returning undefined would let that surface
     * later as a confusing missing-sample error somewhere downstream.
     */
    throw new Error(
      `pattern_sample for pattern ${input.patternId} round ${round} conflicted on insert but is not visible in scope ${scope.siteId}`
    );
  }

  return existing;
}

/** One specific round's draw. */
export async function findPatternSample(
  db: Database,
  scope: SiteScope,
  patternId: string,
  round: number
): Promise<PatternSampleRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(patternSample)
    .where(
      and(
        eq(patternSample.siteId, scope.siteId),
        eq(patternSample.patternId, patternId),
        eq(patternSample.round, round)
      )
    )
    .limit(1);

  return row;
}

/** The most recent draw for a pattern, whichever round it was. */
export async function latestPatternSample(
  db: Database,
  scope: SiteScope,
  patternId: string
): Promise<PatternSampleRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(patternSample)
    .where(
      and(
        eq(patternSample.siteId, scope.siteId),
        eq(patternSample.patternId, patternId)
      )
    )
    .orderBy(desc(patternSample.round))
    .limit(1);

  return row;
}

/**
 * One draw by its own id.
 *
 * The estimate stage is handed a `patternSampleId` on its job and must read
 * exactly that draw — not the latest. A pattern that has since been expanded
 * has two draws, and estimating the round-1 observations against the round-2
 * denominator would produce a number that belongs to neither.
 */
export async function findPatternSampleById(
  db: Database,
  scope: SiteScope,
  patternSampleId: string
): Promise<PatternSampleRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(patternSample)
    .where(
      and(
        eq(patternSample.siteId, scope.siteId),
        eq(patternSample.id, patternSampleId)
      )
    )
    .limit(1);

  return row;
}

/**
 * How many of a run's patterns needed more than one draw.
 *
 * The figure exists because an expansion is a statement about the SAMPLE PLAN,
 * not about the site: a pattern reaching round 2 is one whose first-round
 * budget was set too low to reach an actionable interval, and a site whose
 * patterns keep needing a second draw is telling you the sizing heuristic is
 * wrong. That signal is invisible unless it is counted — which is why
 * `sampling_health` has a column for it — and it is the operational counterpart
 * to M3's recorded tuning observation about `firstRoundSampleSize`.
 *
 * `count(distinct pattern_id)` rather than `count(*)`: a pattern expanded twice
 * is one expanded pattern, and counting draws would report a single stubborn
 * pattern as a fleet-wide budgeting problem.
 *
 * THIS RETURNS ZERO TODAY, AND THAT ZERO IS CORRECT. `recordPatternSample` has
 * exactly one pipeline caller (`stages/ingest.ts`), which passes no `round`, so
 * every draw is round 1; `packages/sampling`'s expansion planner has no caller
 * in `packages/pipeline` and `PIPELINE_STAGES` has no expansion stage. What
 * this query changes is that the zero becomes MEASURED rather than merely
 * unwritten, and it starts reporting real numbers the day adaptive expansion is
 * wired. Do not "fix" it by making it count something else.
 *
 * KNOWN COST: no index is keyed on `sitemap_run_id` here, so this is a
 * partition scan filtered by run — bounded by patterns per run, the same order
 * as `countPatternsByStatus`, and never by population.
 */
export async function countExpandedPatterns(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<number> {
  const [row] = await internalDatabase(db)
    .select({
      count: sql<string>`count(distinct ${patternSample.patternId})::bigint`
    })
    .from(patternSample)
    .where(
      and(
        eq(patternSample.siteId, scope.siteId),
        eq(patternSample.sitemapRunId, sitemapRunId),
        gt(patternSample.round, 1)
      )
    );

  return Number(row?.count ?? 0);
}
