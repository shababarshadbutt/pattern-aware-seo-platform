import { and, desc, eq } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { isCheckViolation, pgConstraintName } from "../pg-errors.js";
import { auditSnapshot } from "../schema/observability.js";
import type { SiteScope } from "../scope.js";

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
): Promise<readonly AuditSnapshotRow[]> {
  const conditions = [eq(auditSnapshot.siteId, scope.siteId)];

  if (options.sitemapRunId !== undefined) {
    conditions.push(eq(auditSnapshot.sitemapRunId, options.sitemapRunId));
  }

  const rows = await internalDatabase(db)
    .select(COLUMNS)
    .from(auditSnapshot)
    .where(and(...conditions))
    // Ordered in SQL on the numeric column, so the ordering is numeric even
    // though the values arrive as strings.
    .orderBy(desc(auditSnapshot.impactScore))
    .limit(options.limit ?? 100);

  return rows.map(toRow);
}
