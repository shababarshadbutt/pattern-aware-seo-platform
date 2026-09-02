import { and, desc, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { pattern } from "../schema/pattern.js";
import type { SiteScope } from "../scope.js";

export type PatternStatus =
  | "unsampled"
  | "sampling"
  | "measured"
  | "blocked"
  | "needs_review";

export interface PatternRow {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string;
  readonly template: string;
  readonly segmentCount: number;
  readonly populationCount: number;
  readonly fileCount: number;
  readonly status: PatternStatus;
  readonly statusReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = {
  id: pattern.id,
  siteId: pattern.siteId,
  sitemapRunId: pattern.sitemapRunId,
  template: pattern.template,
  segmentCount: pattern.segmentCount,
  populationCount: pattern.populationCount,
  fileCount: pattern.fileCount,
  status: pattern.status,
  statusReason: pattern.statusReason,
  createdAt: pattern.createdAt,
  updatedAt: pattern.updatedAt
} as const;

export interface PatternUpsert {
  readonly template: string;
  readonly segmentCount: number;
  readonly populationCount: number;
  readonly fileCount: number;
}

/**
 * Merge a batch of patterns into a run, adding to any counts already recorded.
 *
 * ADDITIVE ON CONFLICT, deliberately. The streaming parse emits per-file
 * contributions, and a run that crashed partway through has already written
 * some of them. On resume the remaining files are parsed and their counts must
 * accumulate onto what survived — an overwriting upsert would silently discard
 * everything the first attempt recorded, and the result would look like a clean
 * run with a smaller population rather than like a bug.
 *
 * This is the same merge property the min-heap relies on (ADR-0002), applied to
 * counts: partial work is combinable, so resuming is exact rather than
 * approximate.
 *
 * Batch rather than row-at-a-time because a large site produces thousands of
 * patterns and a round trip each would dominate the parse.
 */
export async function upsertPatterns(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  patterns: readonly PatternUpsert[]
): Promise<number> {
  if (patterns.length === 0) {
    return 0;
  }

  const rows = await internalDatabase(db)
    .insert(pattern)
    .values(
      patterns.map((p) => ({
        siteId: scope.siteId,
        sitemapRunId,
        template: p.template,
        segmentCount: p.segmentCount,
        populationCount: p.populationCount,
        fileCount: p.fileCount
      }))
    )
    .onConflictDoUpdate({
      target: [pattern.siteId, pattern.sitemapRunId, pattern.template],
      set: {
        populationCount: sql`${pattern.populationCount} + excluded.population_count`,
        fileCount: sql`${pattern.fileCount} + excluded.file_count`,
        updatedAt: sql`now()`
      }
    })
    .returning({ id: pattern.id });

  return rows.length;
}

/**
 * A run's patterns, largest population first.
 *
 * Population order rather than alphabetical because it is the first term of the
 * impact score: a 1% error rate on 40 million URLs matters more than a 90% rate
 * on twelve, and the screens that read this are all answering "what should I
 * look at first?"
 */
export async function listPatternsByPopulation(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  limit = 100
): Promise<readonly PatternRow[]> {
  return internalDatabase(db)
    .select(COLUMNS)
    .from(pattern)
    .where(
      and(
        eq(pattern.siteId, scope.siteId),
        eq(pattern.sitemapRunId, sitemapRunId)
      )
    )
    .orderBy(desc(pattern.populationCount))
    .limit(limit);
}

/** One pattern, scoped. */
export async function findPatternById(
  db: Database,
  scope: SiteScope,
  patternId: string
): Promise<PatternRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(pattern)
    .where(and(eq(pattern.siteId, scope.siteId), eq(pattern.id, patternId)))
    .limit(1);

  return row;
}

export interface PatternStatusCount {
  readonly status: PatternStatus;
  readonly count: number;
  readonly populationCount: number;
}

/**
 * Pattern and URL counts per status for a run.
 *
 * Returns population alongside the row count because the two tell different
 * stories and both matter: twelve blocked patterns is unremarkable unless they
 * happen to hold nine million URLs.
 */
export async function countPatternsByStatus(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<readonly PatternStatusCount[]> {
  const rows = await internalDatabase(db)
    .select({
      status: pattern.status,
      count: sql<number>`count(*)::int`,
      // Summed as bigint because a fleet-scale total overflows int4, and
      // node-postgres hands int8 back as a STRING to avoid losing precision.
      populationCount: sql<string>`coalesce(sum(${pattern.populationCount}), 0)::bigint`
    })
    .from(pattern)
    .where(
      and(
        eq(pattern.siteId, scope.siteId),
        eq(pattern.sitemapRunId, sitemapRunId)
      )
    )
    .groupBy(pattern.status);

  /**
   * Normalised here rather than typed as `number` and hoped for.
   *
   * Declaring the column `sql<number>` made the exported type a lie: callers
   * got a string at runtime, so arithmetic on it silently concatenated and
   * comparisons silently failed. A URL population fits comfortably inside
   * Number.MAX_SAFE_INTEGER even summed across a fleet, so converting at the
   * repository boundary is safe and keeps the contract honest.
   */
  return rows.map((row) => ({
    status: row.status,
    count: row.count,
    populationCount: Number(row.populationCount)
  }));
}
