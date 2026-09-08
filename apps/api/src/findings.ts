import type {
  AuditSnapshotRow,
  ConfidenceBandName,
  EvidenceTier
} from "@pattern-aware/database";
import { isAbsenceOfEvidence } from "@pattern-aware/sampling";

/**
 * Impact, as the estimated quantity it is.
 *
 * `impact_score` is `point_estimate × severity_weight`, so its interval is the
 * estimate's interval under the same weighting — exactly what `scoreImpact`
 * computes as `scoreLow`/`scoreHigh`. Derived here rather than persisted:
 * every input is already on the row, so two more columns would add a migration
 * and a second place for the same number to drift (ADR-0024).
 *
 * Sending it matters because ADR-0008 forbids rendering an estimate without
 * its interval, and impact was being rendered as a bare figure.
 *
 * Lives in its own module because two routes need it now — the per-pattern
 * evidence screen and the fleet-wide issues list. `schemas.ts` had already
 * been documenting it as `findings.ts` while it sat inside `routes/patterns.ts`
 * and no such file existed; moving it here makes that reference true rather
 * than editing the comment to describe the wrong place accurately.
 */
export function withImpactBounds<T extends AuditSnapshotRow>(
  snapshot: T
): T & {
  readonly impactLow: number;
  readonly impactHigh: number;
} {
  return {
    ...snapshot,
    impactLow: snapshot.ciLow * snapshot.severityWeight,
    impactHigh: snapshot.ciHigh * snapshot.severityWeight
  };
}

/**
 * One pattern's findings rolled into a single, still-estimated impact figure.
 *
 * SHAPED AS A MEASUREMENT, DELIBERATELY. The field names are exactly those of
 * `auditSnapshotSummary` — `impactScore`, `impactLow`, `impactHigh`,
 * `evidenceTier`, `confidenceBand`, `sampleSize`, `populationCount` — so the
 * web's existing `impactFromSnapshot` adapter renders this with no second code
 * path, and `lib/adr-0008-guard.test.ts` already forbids a screen formatting
 * these names itself. A rollup with its own field names would have been a
 * sampled figure the guard could not see.
 *
 * SUMMED, not maxed — the rule `scorePatternImpact` documents and the reason it
 * exists: a URL has exactly one status, so the URL sets behind each finding are
 * disjoint and adding them double-counts nothing. A pattern with 5,000 gone
 * URLs and 5,000 server errors really does have 10,000 broken URLs, and taking
 * the maximum would report half the damage.
 *
 * WHY THIS IS NOT `scorePatternImpact`, which computes this exact shape and is
 * the obvious reuse. That function takes a probe outcome plus a fresh
 * `StratifiedEstimate` and derives the weight from the severity table IN FORCE
 * NOW. These are stored claims that already carry the weight that was in force
 * WHEN THEY WERE PUBLISHED, deliberately, because weights are business
 * decisions that get revised and a historical claim has to stay reconstructible
 * against the ones that produced it (ADR-0014). Re-scoring here would silently
 * restate old findings under new weights. Reaching that function at all would
 * also mean rebuilding a `StratifiedEstimate` these rows do not carry — no
 * per-stratum breakdown, no `isSoft404` — which is the invent-the-missing-part
 * defect ADR-0035 records, where the invented part decides the answer.
 *
 * So the arithmetic is repeated and the CLASSIFICATION is shared:
 * `isAbsenceOfEvidence` is a pure function of the severity class with nothing to
 * invent. `test/pattern-rollup.test.ts` asserts this agrees with
 * `scorePatternImpact` wherever the stored weights match the current table, so
 * the two cannot drift apart unnoticed.
 */
export interface PatternImpactRollup {
  readonly evidenceTier: EvidenceTier;
  /**
   * URLs estimated affected, summed across the pattern's findings.
   *
   * Carried ALONGSIDE the weighted impact rather than instead of it, because
   * they answer different questions and diverge whenever a severity weight is
   * not 1.0: a pattern with 400 estimated 500s scores 320 at the ratified
   * weight of 0.8. "How many URLs are affected" is the reader's question;
   * "how should I rank this against other patterns" is the queue's.
   *
   * Same disjointness argument as the impact sum — a URL has exactly one
   * status, so the sets behind each finding do not overlap.
   */
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  /** Probes that came back as one of the counted outcomes. */
  readonly observedCount: number;
  readonly confidenceLevel: number;
  readonly impactScore: number;
  readonly impactLow: number;
  readonly impactHigh: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly sampleSize: number;
  readonly populationCount: number;
  /** Findings that carry damage. An absence of evidence is not one. */
  readonly countedFindings: number;
}

/** Widest first: a sum is only as precise as its least precise part. */
const BAND_ORDER: readonly ConfidenceBandName[] = [
  "low",
  "approximate",
  "confident"
];

/**
 * Roll a pattern's stored findings up, or report that there is nothing to roll.
 *
 * Returns `undefined` when the pattern has no published finding at all, which
 * is NOT the same as a total of zero. Three states a caller must keep apart:
 * nothing published (this `undefined` — the pattern was never sampled, or its
 * sample produced no claim), published but every finding an absence of evidence
 * (`evidenceTier: "blocked"` — a host refused us), and measured with no damage
 * (a real total of zero). Collapsing the first two into a zero reports a WAF as
 * a clean bill of health.
 */
export function rollUpPatternImpact(
  findings: readonly AuditSnapshotRow[]
): PatternImpactRollup | undefined {
  const first = findings[0];

  if (first === undefined) {
    return undefined;
  }

  /**
   * Every finding about one pattern comes from the same draw, so these are the
   * same on all of them — `sample_size` is the pattern's probe count and
   * `population_count` is its population at draw. Taken from the first rather
   * than summed: adding them would multiply one sample by the number of status
   * codes it happened to produce.
   */
  const { sampleSize, populationCount } = first;

  /**
   * Findings that constitute a MEASUREMENT — anything that is not an absence of
   * evidence. A 200 is a measurement; a host refusing us is not.
   */
  const measured = findings.filter(
    (finding) => !isAbsenceOfEvidence(finding.severityClass)
  );

  /**
   * Findings that carry DAMAGE, which is a narrower set — `ok` is excluded.
   *
   * THE DISTINCTION IS LOAD-BEARING AND WAS A REAL DEFECT. `ok` contributes
   * nothing to impact anyway, because its ratified weight is 0, so folding it
   * into one set looked harmless. It is not harmless for the AFFECTED sum,
   * which is unweighted: a pattern with 5,000 estimated 404s and 4,000
   * estimated healthy URLs would have reported "affected ~9,000". Caught by
   * screenshotting a real pattern whose 18 URLs all return 200 and reading
   * "Affected 18" in a triage column.
   *
   * Kept separate from `measured` rather than replacing it, because a pattern
   * whose only finding is `ok` is measured and fine — collapsing the two would
   * send it down the no-measurement path and report a working pattern as
   * unmeasured, which is the opposite error.
   */
  const counted = measured.filter((finding) => finding.severityClass !== "ok");

  if (measured.length === 0) {
    return {
      evidenceTier: "blocked",
      pointEstimate: 0,
      ciLow: 0,
      ciHigh: 0,
      observedCount: 0,
      confidenceLevel: first.confidenceLevel,
      impactScore: 0,
      impactLow: 0,
      impactHigh: 0,
      confidenceBand: "low",
      sampleSize,
      populationCount,
      countedFindings: 0
    };
  }

  let pointEstimate = 0;
  let ciLow = 0;
  let ciHigh = 0;
  let observedCount = 0;
  let impactScore = 0;
  let impactLow = 0;
  let impactHigh = 0;

  for (const finding of counted) {
    pointEstimate += finding.pointEstimate;
    ciLow += finding.ciLow;
    ciHigh += finding.ciHigh;
    observedCount += finding.observedCount;
    impactScore += finding.impactScore;
    // The weighting `withImpactBounds` applies per finding, summed. Each bound
    // takes its OWN finding's stored weight, so a rollup across findings of
    // differing severity stays correct.
    impactLow += finding.ciLow * finding.severityWeight;
    impactHigh += finding.ciHigh * finding.severityWeight;
  }

  /**
   * `counted` only if EVERY contributing finding was counted. One estimated
   * part makes the sum estimated, and a sum presented as counted would drop the
   * interval that part carries — ADR-0008's exact failure.
   */
  const evidenceTier: EvidenceTier = measured.every(
    (finding) => finding.evidenceTier === "counted"
  )
    ? "counted"
    : "estimated";

  /** The widest band any contributing finding carried, for the reason above. */
  const confidenceBand = measured.reduce<ConfidenceBandName>(
    (widest, finding) =>
      BAND_ORDER.indexOf(finding.confidenceBand) < BAND_ORDER.indexOf(widest)
        ? finding.confidenceBand
        : widest,
    "confident"
  );

  return {
    evidenceTier,
    pointEstimate,
    /*
     * Clamped to the population. Summing per-finding upper bounds is the
     * conservative choice `estimateStratified` also makes, but several wide
     * intervals can add up past N — and "affected: more URLs than exist" is a
     * figure no reader can act on.
     */
    ciLow: Math.min(ciLow, populationCount),
    ciHigh: Math.min(ciHigh, populationCount),
    observedCount,
    confidenceLevel: first.confidenceLevel,
    impactScore,
    impactLow,
    impactHigh,
    confidenceBand,
    sampleSize,
    populationCount,
    countedFindings: counted.length
  };
}
