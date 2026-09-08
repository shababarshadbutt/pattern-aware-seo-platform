import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { isCheckViolation, pgConstraintName } from "../pg-errors.js";
import { auditSnapshot } from "../schema/observability.js";
import { pattern } from "../schema/pattern.js";
import type { OrganizationScope, SiteScope } from "../scope.js";
import { organizationSiteIds } from "./site.js";

/**
 * The immutable record of one published claim.
 *
 * Everything needed to answer "why do you say 13.8 million URLs are affected?"
 * — n, N, the interval, the confidence level, the estimator version, the
 * severity weights that were in force — is stored on the row rather than
 * recomputed at read time. Weights and thresholds are business decisions that
 * will be revised (ADR-0014), and a historical claim has to stay
 * reconstructible against the ones that actually produced it.
 */

export type EvidenceTier = "counted" | "estimated" | "blocked";
export type ConfidenceBandName = "confident" | "approximate" | "low";
export type SeverityClassName =
  | "gone"
  | "not_found"
  | "soft_not_found"
  | "server_error"
  | "redirect_chain"
  | "redirect_single"
  | "ok"
  | "blocked"
  | "unknown";

export interface AuditSnapshotRow {
  readonly id: string;
  readonly siteId: string;
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly sitemapRunId: string;
  readonly httpStatus: number;
  readonly evidenceTier: EvidenceTier;
  readonly observedCount: number;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly severityClass: SeverityClassName;
  /**
   * The weight in force when this claim was published.
   *
   * Selected, not just stored: the interface needs it to show impact as the
   * estimated quantity it is. Impact is `point_estimate × severity_weight`, so
   * its interval is `[ci_low × w, ci_high × w]` — derivable from this row
   * without persisting two more columns, and ADR-0008 forbids rendering an
   * estimate without its interval.
   */
  readonly severityWeight: number;
  /** The level the interval was computed at, e.g. 0.95. */
  readonly confidenceLevel: number;
  readonly impactScore: number;
  readonly estimatorVersion: string;
  readonly computedAt: Date;
}

const COLUMNS = {
  id: auditSnapshot.id,
  siteId: auditSnapshot.siteId,
  patternId: auditSnapshot.patternId,
  patternSampleId: auditSnapshot.patternSampleId,
  sitemapRunId: auditSnapshot.sitemapRunId,
  httpStatus: auditSnapshot.httpStatus,
  evidenceTier: auditSnapshot.evidenceTier,
  observedCount: auditSnapshot.observedCount,
  sampleSize: auditSnapshot.sampleSize,
  populationCount: auditSnapshot.populationCount,
  pointEstimate: auditSnapshot.pointEstimate,
  ciLow: auditSnapshot.ciLow,
  ciHigh: auditSnapshot.ciHigh,
  confidenceBand: auditSnapshot.confidenceBand,
  severityClass: auditSnapshot.severityClass,
  severityWeight: auditSnapshot.severityWeight,
  confidenceLevel: auditSnapshot.confidenceLevel,
  impactScore: auditSnapshot.impactScore,
  estimatorVersion: auditSnapshot.estimatorVersion,
  computedAt: auditSnapshot.computedAt
} as const;

export interface AuditSnapshotInsert {
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly sitemapRunId: string;
  readonly httpStatus: number;
  readonly evidenceTier: EvidenceTier;
  readonly observedCount: number;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceLevel: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly estimatorVersion: string;
  readonly severityClass: SeverityClassName;
  readonly severityWeight: number;
  readonly impactScore: number;
  readonly strata?: unknown;
}

/**
 * Raised when the database refuses a claim as statistically impossible.
 *
 * THIS IS THE SYSTEM'S MOST VALUABLE ALARM, not an inconvenience to catch and
 * retry. The constraints it reports are invariants the estimator cannot
 * legitimately violate: an interval that excludes its own point estimate, a
 * degenerate `[0,0]` from a partial sample, an impact score larger than the
 * estimate it weights, a refusal carrying damage. Every one of them means the
 * statistical core has regressed, and the correct response is to page someone
 * rather than to write the row a different way.
 *
 * The invariants live in the schema rather than in an assertion here precisely
 * so this is unwritable rather than merely alerted on — an application check
 * can be bypassed by the next code path that forgets it.
 */
export class ImpossibleClaimError extends Error {
  public override readonly name = "ImpossibleClaimError";

  public constructor(
    public readonly constraintName: string | undefined,
    cause: unknown
  ) {
    super(
      `audit_snapshot rejected a claim as impossible (${constraintName ?? "unknown constraint"}) — the estimator has produced a value it cannot legitimately produce`,
      { cause }
    );
  }
}

/**
 * Write one pattern's published claim.
 *
 * Translates a CHECK violation into {@link ImpossibleClaimError} rather than
 * letting a raw SQLSTATE escape, so the failure names what actually went wrong
 * instead of arriving as an opaque driver error four layers up.
 */
/**
 * Coerce the numeric columns the driver hands back as strings.
 *
 * `impact_score`, `severity_weight` and `confidence_level` are all `numeric`,
 * and node-postgres returns numerics as strings rather than guessing at a
 * precision-losing float. The row type promises numbers, so the conversion
 * happens here, once, instead of at each of the places that read them — one of
 * which would eventually compare a string to a number and silently sort "9"
 * above "10".
 */
function toRow(raw: RawSnapshotRow): AuditSnapshotRow {
  return {
    ...raw,
    impactScore: Number(raw.impactScore),
    severityWeight: Number(raw.severityWeight),
    confidenceLevel: Number(raw.confidenceLevel)
  };
}

type RawSnapshotRow = Omit<
  AuditSnapshotRow,
  "impactScore" | "severityWeight" | "confidenceLevel"
> & {
  readonly impactScore: string;
  readonly severityWeight: string;
  readonly confidenceLevel: string;
};

export async function insertAuditSnapshot(
  db: Database,
  scope: SiteScope,
  input: AuditSnapshotInsert
): Promise<AuditSnapshotRow> {
  try {
    const [row] = await internalDatabase(db)
      .insert(auditSnapshot)
      .values({
        siteId: scope.siteId,
        patternId: input.patternId,
        patternSampleId: input.patternSampleId,
        sitemapRunId: input.sitemapRunId,
        httpStatus: input.httpStatus,
        evidenceTier: input.evidenceTier,
        observedCount: input.observedCount,
        sampleSize: input.sampleSize,
        populationCount: input.populationCount,
        pointEstimate: input.pointEstimate,
        ciLow: input.ciLow,
        ciHigh: input.ciHigh,
        // numeric columns take a string: the driver will not silently round a
        // float into a fixed-precision column.
        confidenceLevel: input.confidenceLevel.toFixed(3),
        confidenceBand: input.confidenceBand,
        estimatorVersion: input.estimatorVersion,
        severityClass: input.severityClass,
        severityWeight: input.severityWeight.toFixed(3),
        // numeric, so a string: see the column comment and migration 0006. The
        // score is fractional by construction and must not be rounded.
        impactScore: input.impactScore.toFixed(3),
        ...(input.strata === undefined ? {} : { strata: input.strata })
      })
      .returning(COLUMNS);

    if (row === undefined) {
      throw new Error("audit_snapshot insert returned no row");
    }

    return toRow(row);
  } catch (error) {
    if (isCheckViolation(error)) {
      throw new ImpossibleClaimError(pgConstraintName(error), error);
    }

    throw error;
  }
}

/**
 * A single pattern's published claims, most recently computed first.
 *
 * The pattern-detail screen's question is "what does this ONE pattern's
 * evidence say," not "rank the whole site" — `listSnapshotsByImpact` answers
 * the latter and does not take a pattern filter, so a second, narrower query
 * is worth having rather than fetching the site's top findings and filtering
 * in the API layer, which would silently stop working once a site has more
 * findings than that list's page size.
 */
export async function findSnapshotsByPattern(
  db: Database,
  scope: SiteScope,
  patternId: string,
  options: { readonly limit?: number } = {}
): Promise<readonly AuditSnapshotRow[]> {
  const rows = await internalDatabase(db)
    .select(COLUMNS)
    .from(auditSnapshot)
    .where(
      and(
        eq(auditSnapshot.siteId, scope.siteId),
        eq(auditSnapshot.patternId, patternId)
      )
    )
    .orderBy(desc(auditSnapshot.computedAt))
    .limit(options.limit ?? 20);

  return rows.map(toRow);
}

/**
 * One of a site's own findings, carrying the pattern it describes.
 *
 * A site's findings list can say "this site" because the screen names it, but
 * it cannot say "this pattern" — a row reading only `404, ~5,600` is not
 * actionable, and the pattern id it links on is a UUID no reader recognises.
 * So the template travels, the same way {@link OrganizationSnapshotRow} sends
 * it for the fleet list; the site name does not, because the screen is the
 * site.
 */
export interface SiteSnapshotRow extends AuditSnapshotRow {
  readonly patternTemplate: string;
}

/**
 * A site's findings, worst first.
 *
 * Ranked on `impact_score`, which is derived from the POINT estimate and never
 * from a bound — ranking on an upper bound would float the least-understood
 * patterns to the top, since a wide interval means thin evidence rather than a
 * big problem.
 */
export async function listSnapshotsByImpact(
  db: Database,
  scope: SiteScope,
  options: { readonly sitemapRunId?: string; readonly limit?: number } = {}
): Promise<readonly SiteSnapshotRow[]> {
  const conditions = [eq(auditSnapshot.siteId, scope.siteId)];

  if (options.sitemapRunId !== undefined) {
    conditions.push(eq(auditSnapshot.sitemapRunId, options.sitemapRunId));
  }

  const rows = await internalDatabase(db)
    .select({ ...COLUMNS, patternTemplate: pattern.template })
    .from(auditSnapshot)
    /**
     * Joined on BOTH key columns, as the fleet query is.
     *
     * `pattern` is partitioned by `site_id` with a composite primary key
     * (ADR-0010), so pairing the site id is what keeps the join inside one
     * partition — and it is the same pairing the post-M3 hardening pass added
     * FKs for, after finding a row could carry one site's `site_id` while
     * pointing at another site's parent.
     */
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, auditSnapshot.siteId),
        eq(pattern.id, auditSnapshot.patternId)
      )
    )
    .where(and(...conditions))
    /**
     * `NULLS LAST`, to match the index — not for semantics.
     *
     * Ordered in SQL on the numeric column, so the ordering is numeric even
     * though the values arrive as strings.
     *
     * `impact_score` is NOT NULL, so the null placement cannot change a
     * result. It is spelled out because `idx_audit_snapshot_site_impact` is
     * `(site_id, impact_score DESC NULLS LAST)` while a bare `ORDER BY ... DESC`
     * means DESC NULLS FIRST — a mismatch that stops the index satisfying the
     * ordering. `EXPLAIN` confirms the difference on a single site: with it,
     * a plain `Index Scan` the `LIMIT` can stop early; without it, an
     * `Index Scan` plus a `Sort` of every matching row.
     */
    .orderBy(sql`${auditSnapshot.impactScore} desc nulls last`)
    .limit(options.limit ?? 100);

  return rows.map((row) => ({
    ...toRow(row),
    patternTemplate: row.patternTemplate
  }));
}

/**
 * Every published claim about each of several patterns, in one round trip.
 *
 * The pattern explorer needs each row's findings to roll them into a total, and
 * doing that with {@link findSnapshotsByPattern} per row would issue one query
 * per pattern on the page. Bounded by the caller's page size rather than by a
 * `limit` of its own: a page of patterns has a few findings each, and silently
 * truncating would under-report a total that is supposed to be the SUM of a
 * pattern's findings.
 *
 * Returns early on an empty list rather than issuing `pattern_id = ANY('{}')`,
 * which scans a partition to find nothing.
 *
 * NOT ORDERED — the caller groups these by pattern and hands each group to
 * `scorePatternImpact`, which does not care about order.
 */
export async function listSnapshotsByPatterns(
  db: Database,
  scope: SiteScope,
  patternIds: readonly string[]
): Promise<readonly AuditSnapshotRow[]> {
  if (patternIds.length === 0) {
    return [];
  }

  const rows = await internalDatabase(db)
    .select(COLUMNS)
    .from(auditSnapshot)
    .where(
      and(
        eq(auditSnapshot.siteId, scope.siteId),
        inArray(auditSnapshot.patternId, [...patternIds])
      )
    );

  return rows.map(toRow);
}

/**
 * One finding, carrying the labels a cross-site list needs to be readable.
 *
 * A site's own findings list can say "this pattern" because the screen already
 * names the site and the pattern. A fleet-wide list cannot: a row that says
 * only `404, ~5,600` is unattributable, so the site name and pattern template
 * travel with it.
 */
export interface OrganizationSnapshotRow extends AuditSnapshotRow {
  readonly siteName: string;
  readonly patternTemplate: string;
}

/**
 * Every site's findings in one organization, worst first.
 *
 * The fleet-level counterpart to {@link listSnapshotsByImpact}, and it inherits
 * that function's ranking rule rather than restating it: `impact_score` is
 * derived from the POINT estimate, never from a bound, because ranking on an
 * upper bound floats the least-understood patterns to the top — a wide interval
 * means thin evidence, not a big problem.
 *
 * CROSS-SITE, WITHIN ONE ORGANIZATION, AND THAT DISTINCTION IS THE WHOLE POINT
 * (ADR-0028). The site ids come from `organizationSiteIds`, which can only
 * return sites belonging to the caller's own `OrganizationScope` — so the query
 * cannot reach another tenant's rows even if its predicate were wrong. This is
 * not the cross-ORGANIZATION fleet auto-attach the action plan leaves open, and
 * must not become it: nothing here accepts an organization id from a caller.
 *
 * Returns early on an organization with no sites rather than issuing
 * `site_id = ANY('{}')`, which scans every partition to find nothing.
 */
export async function listOrganizationSnapshotsByImpact(
  db: Database,
  scope: OrganizationScope,
  options: { readonly limit?: number } = {}
): Promise<readonly OrganizationSnapshotRow[]> {
  const siteNames = await organizationSiteIds(db, scope);

  if (siteNames.size === 0) {
    return [];
  }

  const rows = await internalDatabase(db)
    .select({ ...COLUMNS, patternTemplate: pattern.template })
    .from(auditSnapshot)
    /**
     * Joined on BOTH key columns, not just `pattern_id`.
     *
     * `pattern` is partitioned by `site_id` with a composite primary key
     * (ADR-0010), so pairing the site id is what lets the join prune to one
     * partition — and it is the same pairing the post-M3 hardening added FKs
     * for, after finding a row could carry one site's `site_id` while pointing
     * at another site's parent.
     */
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, auditSnapshot.siteId),
        eq(pattern.id, auditSnapshot.patternId)
      )
    )
    .where(inArray(auditSnapshot.siteId, [...siteNames.keys()]))
    /**
     * Matches the index's null placement, as above.
     *
     * KNOWN LIMIT AT FLEET SCALE, measured rather than assumed. Partition
     * pruning works — `EXPLAIN` touches only the named sites' partitions — but
     * `site_id = ANY(...)` is served by BITMAP index scans, and a bitmap scan
     * never preserves index order, so this plan sorts the matched rows instead
     * of merging pre-ordered ones. The ordering is free only when `site_id` is
     * a single constant.
     *
     * Fine at present scale and correct at any scale. The fix when a fleet
     * makes it matter is top-k per site — one index-ordered `LIMIT n` query
     * per partition, merged in application code — which is a different shape,
     * not a tweak, and is not worth its round trips for the handful of sites
     * that exist today. See ADR-0028.
     */
    .orderBy(sql`${auditSnapshot.impactScore} desc nulls last`)
    .limit(options.limit ?? 100);

  return rows.map((row) => ({
    ...toRow(row),
    patternTemplate: row.patternTemplate,
    // Non-null by construction: the id came from this very map.
    siteName: siteNames.get(row.siteId) ?? row.siteId
  }));
}

export interface SiteSeverityCount {
  readonly siteId: string;
  readonly severityClass: SeverityClassName;
  readonly count: number;
}

/**
 * Findings per site per severity class, for the fleet portfolio.
 *
 * COUNTS OF FINDINGS, NOT SUMS OF THEIR VOLUMES, and the distinction is the
 * reason this is safe to put in a KPI card. Each `audit_snapshot` row is a
 * published finding — a counted thing — while the number of URLs it covers is
 * an ESTIMATE carrying an interval. Adding those volumes up across a fleet
 * would manufacture a precise-looking total out of uncertain parts, which
 * DESIGN.md bans outright; counting the rows does not.
 *
 * Grouped in SQL rather than tallied from `listOrganizationSnapshotsByImpact`.
 * That query is capped at a limit, so counting its result would report the
 * severity mix of the top hundred findings while labelling it the fleet's —
 * the same class of error as a paginated table describing itself as a census.
 *
 * Cross-site within one organization via `organizationSiteIds`, exactly as its
 * neighbours (ADR-0028); the ids can only be this caller's own.
 */
export async function countOrganizationSnapshotsBySeverity(
  db: Database,
  scope: OrganizationScope
): Promise<readonly SiteSeverityCount[]> {
  const siteNames = await organizationSiteIds(db, scope);

  if (siteNames.size === 0) {
    return [];
  }

  const rows = await internalDatabase(db)
    .select({
      siteId: auditSnapshot.siteId,
      severityClass: auditSnapshot.severityClass,
      count: sql<number>`count(*)::int`
    })
    .from(auditSnapshot)
    .where(inArray(auditSnapshot.siteId, [...siteNames.keys()]))
    .groupBy(auditSnapshot.siteId, auditSnapshot.severityClass);

  return rows;
}
