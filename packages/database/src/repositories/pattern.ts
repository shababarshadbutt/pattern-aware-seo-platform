import { and, asc, desc, eq, sql } from "drizzle-orm";

import { chunkRows } from "../chunk.js";
import { type Database, internalDatabase } from "../client.js";
import { auditSnapshot } from "../schema/observability.js";
import { pattern } from "../schema/pattern.js";
import type { SiteScope } from "../scope.js";

/**
 * `siteId, sitemapRunId, template, segmentCount, populationCount, fileCount` —
 * one bind parameter each. See `chunk.ts`.
 */
const COLUMNS_PER_ROW = 6;

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
 *
 * CHUNKED, AND THE CHUNKS SHARE ONE TRANSACTION — not two independent
 * decisions. `runIngest`'s `IngestAlreadyAggregatedError` guard treats "any
 * pattern row exists for this run" as proof aggregation already completed
 * (see the comment there), which was true when this was one `INSERT`
 * statement. Splitting a large site's patterns into several statements
 * without a shared transaction would let a crash between chunk 2 and chunk 3
 * leave a partial aggregation that the guard would then mistake for a
 * complete one on retry — silently reintroducing the exact durability bug
 * fixed at M6, just one layer down. Wrapping every chunk in one transaction
 * keeps "some pattern rows exist" and "aggregation completed" the same fact.
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

  const values = patterns.map((p) => ({
    siteId: scope.siteId,
    sitemapRunId,
    template: p.template,
    segmentCount: p.segmentCount,
    populationCount: p.populationCount,
    fileCount: p.fileCount
  }));

  const chunks = chunkRows(values, COLUMNS_PER_ROW);
  const conn = internalDatabase(db);

  const written = await conn.transaction(async (tx) => {
    let count = 0;

    for (const chunk of chunks) {
      const rows = await tx
        .insert(pattern)
        .values(chunk)
        .onConflictDoUpdate({
          target: [pattern.siteId, pattern.sitemapRunId, pattern.template],
          set: {
            populationCount: sql`${pattern.populationCount} + excluded.population_count`,
            fileCount: sql`${pattern.fileCount} + excluded.file_count`,
            updatedAt: sql`now()`
          }
        })
        .returning({ id: pattern.id });

      count += rows.length;
    }

    return count;
  });

  return written;
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
  limit = 100,
  /**
   * Ascending gives the SMALLEST patterns, which is a different question and
   * not answerable by reading the tail of the descending list — that is the
   * smallest of the top N, not the smallest of the run. Optional and defaulted
   * so both existing callers are untouched.
   */
  order: "asc" | "desc" = "desc"
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
    .orderBy(
      order === "asc"
        ? asc(pattern.populationCount)
        : desc(pattern.populationCount)
    )
    .limit(limit);
}

/** How the pattern explorer orders a page. */
export type PatternSort = "population" | "impact";

export interface PatternRankRow extends PatternRow {
  /** Published findings about this pattern. COUNTED — a row count, not a volume. */
  readonly findingCount: number;
  /**
   * Summed `impact_score` across this pattern's findings.
   *
   * FOR ORDERING AND VERIFICATION ONLY — NOT FOR DISPLAY. The figure a screen
   * shows comes from `rollUpPatternImpact` in `apps/api/src/findings.ts`, which
   * carries the interval with it; this one is a bare point value, and rendering
   * it would be a sampled figure without its bounds, which ADR-0008 forbids.
   * It exists because paging has to happen in SQL (see below), and because a
   * test needs it to prove the SQL sum and the rollup agree. The API does not
   * put it on the wire, and `lib/adr-0008-guard.test.ts` lists the name so a
   * screen reading it fails the build anyway.
   */
  readonly rankScore: number;
}

export interface ListPatternsRankedOptions {
  readonly sort?: PatternSort | undefined;
  readonly status?: PatternStatus | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * One page of a run's patterns, ranked for triage.
 *
 * Separate from {@link listPatternsByPopulation} rather than a widening of it:
 * that function has three callers happy with positional arguments, and this one
 * needs a sort mode, a status filter and an offset. One query serves both sort
 * orders so the explorer's toggle cannot become two divergent code paths.
 *
 * RANKED AND PAGED IN SQL, NOT IN THE ROUTE. Summing a pattern's findings in
 * application code would mean ranking whatever page happened to be fetched —
 * the same defect `countPatternsByDepth` avoids, and the one that made a
 * paginated table describe itself as a census. Ordering here is what makes
 * `offset` mean anything.
 *
 * LEFT JOIN, so a pattern with no published finding still appears. This is the
 * load-bearing choice: `blocked`, `needs_review` and `unsampled` patterns have
 * no `audit_snapshot` row at all, and an inner join would silently drop exactly
 * the patterns a triage screen exists to surface — a run full of hosts refusing
 * us would render as an empty, healthy-looking table.
 *
 * Ties break on `id`, so the order is total. Without that, two patterns of equal
 * rank could swap between page loads, and a reader would think something had
 * changed — the same rule `compareByImpact` documents, and
 * `apps/api/test/pattern-explorer.test.ts` asserts this ordering agrees with
 * that function rather than trusting that it does.
 */
export async function listPatternsRanked(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  options: ListPatternsRankedOptions = {}
): Promise<readonly PatternRankRow[]> {
  const conditions = [
    eq(pattern.siteId, scope.siteId),
    eq(pattern.sitemapRunId, sitemapRunId)
  ];

  if (options.status !== undefined) {
    conditions.push(eq(pattern.status, options.status));
  }

  /**
   * Summed as `numeric`, then coerced at this boundary.
   *
   * `impact_score` is numeric (ADR-0020 — the score is fractional by
   * construction), and node-postgres returns numerics as strings rather than
   * risking a precision-losing float. Typed as the string it actually is so the
   * conversion below is visible instead of an arithmetic bug waiting to happen.
   */
  const rankScore = sql<string>`coalesce(sum(${auditSnapshot.impactScore}), 0)`;

  const rows = await internalDatabase(db)
    .select({
      ...COLUMNS,
      findingCount: sql<number>`count(${auditSnapshot.id})::int`,
      rankScore
    })
    .from(pattern)
    /**
     * Joined on BOTH key columns, per ADR-0010.
     *
     * `pattern` and `audit_snapshot` are both partitioned by `site_id` with a
     * composite primary key, so pairing the site id is what prunes the join to
     * one partition — and it is the pairing the post-M3 hardening pass added
     * FKs for, after finding a row could carry one site's `site_id` while
     * pointing at another site's parent.
     */
    .leftJoin(
      auditSnapshot,
      and(
        eq(auditSnapshot.siteId, pattern.siteId),
        eq(auditSnapshot.patternId, pattern.id)
      )
    )
    .where(and(...conditions))
    /**
     * Every selected column is grouped explicitly rather than relying on
     * Postgres's functional-dependency rule for a primary key. That rule is
     * real, but `pattern`'s primary key lives on a PARTITIONED table, and
     * depending on the planner recognising it there would make this query's
     * validity a property of the partitioning rather than of the SQL.
     */
    .groupBy(
      pattern.siteId,
      pattern.id,
      pattern.sitemapRunId,
      pattern.template,
      pattern.segmentCount,
      pattern.populationCount,
      pattern.fileCount,
      pattern.status,
      pattern.statusReason,
      pattern.createdAt,
      pattern.updatedAt
    )
    .orderBy(
      options.sort === "impact"
        ? sql`${rankScore} desc, ${pattern.id} asc`
        : sql`${pattern.populationCount} desc, ${pattern.id} asc`
    )
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  // Only `rankScore` needs coercing: `population_count` is declared
  // `bigint({ mode: "number" })`, so the driver already hands it back as a
  // number, while a summed `numeric` arrives as a string.
  return rows.map((row) => ({
    ...row,
    rankScore: Number(row.rankScore)
  }));
}

/**
 * How many patterns a run has, under the same filter the page uses.
 *
 * Takes the status filter because a filtered table whose footer counts the
 * unfiltered set describes a different collection from the rows above it —
 * DESIGN.md's rule that a filter must reach the totals as well as the rows.
 */
export async function countPatterns(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  options: { readonly status?: PatternStatus | undefined } = {}
): Promise<number> {
  const conditions = [
    eq(pattern.siteId, scope.siteId),
    eq(pattern.sitemapRunId, sitemapRunId)
  ];

  if (options.status !== undefined) {
    conditions.push(eq(pattern.status, options.status));
  }

  const [row] = await internalDatabase(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(pattern)
    .where(and(...conditions));

  return row?.count ?? 0;
}

export interface PatternDepthCount {
  /** Path segments in the template — NOT clicks from a root document. */
  readonly segmentCount: number;
  readonly count: number;
  readonly populationCount: number;
}

/**
 * Pattern and URL counts bucketed by path depth.
 *
 * PATH DEPTH, NOT LINK DEPTH, and the distinction is the whole reason this
 * comment exists. `segment_count` is how many segments a pattern's template
 * has — `/catalog/{slug}` is two. It is not "clicks from the home page", which
 * would need a link graph this platform does not build and has no table for.
 * A screen rendering this must say which one it is, or a reader will assume the
 * crawler metric it resembles.
 *
 * Grouped in SQL rather than bucketed from a page of patterns, because the
 * pattern list any route returns is capped and a distribution built from a
 * truncated list is wrong in a way nothing would report. No index on
 * `segment_count` — this is a partition scan, bounded by a run's pattern count
 * rather than its URL count, which is the difference between thousands and
 * tens of millions.
 */
export async function countPatternsByDepth(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<readonly PatternDepthCount[]> {
  const rows = await internalDatabase(db)
    .select({
      segmentCount: pattern.segmentCount,
      count: sql<number>`count(*)::int`,
      // Summed as bigint for the same reason countPatternsByStatus does it: a
      // fleet-scale total overflows int4, and node-postgres returns int8 as a
      // string rather than losing precision.
      populationCount: sql<string>`coalesce(sum(${pattern.populationCount}), 0)::bigint`
    })
    .from(pattern)
    .where(
      and(
        eq(pattern.siteId, scope.siteId),
        eq(pattern.sitemapRunId, sitemapRunId)
      )
    )
    .groupBy(pattern.segmentCount)
    .orderBy(asc(pattern.segmentCount));

  // Coerced here, at the repository boundary, rather than typed as a number and
  // hoped for — the same correction countPatternsByStatus carries.
  return rows.map((row) => ({
    segmentCount: row.segmentCount,
    count: row.count,
    populationCount: Number(row.populationCount)
  }));
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

/**
 * Move a pattern to a known health state.
 *
 * The reason is stored alongside, machine-readable, because three of the five
 * statuses are absences of measurement rather than measurements: `blocked`,
 * `needs_review` and `unsampled` all mean "no number here", and which one it is
 * decides what the interface may show. A status without its reason would leave
 * whoever reads it guessing which.
 */
export async function setPatternStatus(
  db: Database,
  scope: SiteScope,
  patternId: string,
  status: PatternStatus,
  statusReason?: string
): Promise<void> {
  await internalDatabase(db)
    .update(pattern)
    .set({
      status,
      // Cleared on a clean measurement so a pattern that was blocked and later
      // measured does not keep a reason that reads as a live warning.
      statusReason: status === "measured" ? null : (statusReason ?? null),
      updatedAt: sql`now()`
    })
    .where(and(eq(pattern.siteId, scope.siteId), eq(pattern.id, patternId)));
}
