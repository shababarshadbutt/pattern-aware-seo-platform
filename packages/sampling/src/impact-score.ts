import {
  classifyOutcome,
  isAbsenceOfEvidence,
  type ProbeOutcome,
  type SeverityClass,
  type SeverityTable,
  severityFor
} from "./severity.js";
import type { StratifiedEstimate } from "./stratified-estimate.js";

/**
 * What one finding about one pattern is worth paying attention to.
 *
 * The action plan defines this as `population × error probability × severity`,
 * and `population × error probability` is precisely the point estimate M3
 * already produces — so this is that estimate weighted, not a second
 * calculation of the same thing from different inputs. Deriving it twice is how
 * two numbers on the same screen come to disagree.
 */
export interface ImpactScoreInput {
  /** Which status class this finding is about. */
  readonly outcome: ProbeOutcome;
  /** M3's extrapolation for that class on this pattern. */
  readonly estimate: Pick<
    StratifiedEstimate,
    "pointEstimate" | "ciLow" | "ciHigh" | "populationCount" | "isCounted"
  >;
}

export interface ImpactScore {
  readonly severityClass: SeverityClass;
  readonly severity: number;
  /** Affected URLs, weighted. `pointEstimate × severity`. */
  readonly score: number;
  /** The same weighting applied to the interval, for display beside the score. */
  readonly scoreLow: number;
  readonly scoreHigh: number;
  /** Unweighted, so a reader can see what the weighting did. */
  readonly estimatedAffectedUrls: number;
  /**
   * True when this finding carries no evidence — the host refused us, or the
   * outcome could not be classified. Scored zero and flagged rather than
   * silently ranked last, because "we could not look" and "we looked and it is
   * fine" are different answers.
   */
  readonly isAbsenceOfEvidence: boolean;
}

export interface ImpactScoreOptions {
  readonly severityTable: SeverityTable;
  /**
   * Reserved multiplier for search-traffic weighting, from Google Search
   * Console. Must be in (0, 1] — it can only ever DE-weight.
   *
   * A deliberately inert hook: the action plan asks for the Impact Score now
   * and GSC integration in Phase 5, and wiring the shape in advance means that
   * arrives as one multiplication rather than a reshaping of every consumer.
   *
   * THE UPPER BOUND IS NOT ARBITRARY. `impact_score` is stored, and
   * `ck_audit_snapshot_impact_sane` requires it not to exceed the estimate it
   * weights, because the number is in URL units and a score larger than the
   * affected-URL count it derives from is not interpretable as anything. A
   * multiplier above one produces exactly that: 2.5 on a 100,000-URL estimate
   * gives 250,000, and the database rejects the row. The hook as originally
   * written could not actually have been used.
   *
   * De-weighting is the semantics that fits: this pattern has no search
   * traffic, rank it lower. If the product later wants traffic to AMPLIFY, the
   * score stops being URL-denominated and needs its own column plus a revised
   * constraint. That is an ADR decision, not a quiet relaxation of this bound.
   */
  readonly trafficMultiplier?: number;
}

/**
 * Score one finding.
 *
 * RANKS ON THE POINT ESTIMATE, never on a bound. Ranking on the upper bound
 * would put the least-understood patterns at the top — precisely inverting the
 * ordering, since a wide interval means thin evidence rather than a big
 * problem. The bounds are carried through so the interface can show the range
 * beside the score, which is the honest presentation.
 */
export function scoreImpact(
  input: ImpactScoreInput,
  options: ImpactScoreOptions
): ImpactScore {
  const severityClass = classifyOutcome(input.outcome);
  const absence = isAbsenceOfEvidence(severityClass);
  const severity = severityFor(severityClass, options.severityTable);
  const traffic = options.trafficMultiplier ?? 1;

  if (!Number.isFinite(traffic) || traffic <= 0 || traffic > 1) {
    throw new RangeError(
      `trafficMultiplier must be in (0, 1]; got ${traffic}. Above one the score exceeds the estimate it weights and audit_snapshot rejects the row.`
    );
  }

  const weight = severity * traffic;

  return {
    severityClass,
    severity,
    score: input.estimate.pointEstimate * weight,
    scoreLow: input.estimate.ciLow * weight,
    scoreHigh: input.estimate.ciHigh * weight,
    estimatedAffectedUrls: input.estimate.pointEstimate,
    isAbsenceOfEvidence: absence
  };
}

export interface PatternImpact {
  /** Sum of the per-finding scores. */
  readonly totalScore: number;
  readonly totalScoreLow: number;
  readonly totalScoreHigh: number;
  /** The single worst finding, or undefined when there are none that count. */
  readonly worstFinding: ImpactScore | undefined;
  readonly findings: readonly ImpactScore[];
  /** True when every finding was an absence of evidence rather than a defect. */
  readonly isUnmeasured: boolean;
}

/**
 * Roll several findings about one pattern into a single ranking number.
 *
 * SUMMED, not maxed. A URL has exactly one status, so the sets of URLs behind
 * each finding are disjoint and adding them double-counts nothing — a pattern
 * with 5,000 404s and 5,000 500s really does have 10,000 broken URLs, and
 * taking the maximum would report half the damage.
 *
 * `worstFinding` is carried separately because the total answers "how much is
 * wrong here" while the worst answers "what is wrong here", and a triage screen
 * needs both.
 */
export function scorePatternImpact(
  findings: readonly ImpactScoreInput[],
  options: ImpactScoreOptions
): PatternImpact {
  const scored = findings.map((finding) => scoreImpact(finding, options));
  const counted = scored.filter((finding) => !finding.isAbsenceOfEvidence);

  let totalScore = 0;
  let totalScoreLow = 0;
  let totalScoreHigh = 0;
  let worstFinding: ImpactScore | undefined;

  for (const finding of counted) {
    totalScore += finding.score;
    totalScoreLow += finding.scoreLow;
    totalScoreHigh += finding.scoreHigh;

    if (worstFinding === undefined || finding.score > worstFinding.score) {
      worstFinding = finding;
    }
  }

  return {
    totalScore,
    totalScoreLow,
    totalScoreHigh,
    worstFinding,
    findings: scored,
    // Nothing measurable came back. Distinguished from a score of zero, which
    // means "measured, and fine".
    isUnmeasured: scored.length > 0 && counted.length === 0
  };
}

/**
 * Order patterns for a triage queue: worst first.
 *
 * Ties break on the identifier, so the ordering is total. Without that, two equally-scored patterns could swap
 * places between page loads and a reader would think something had changed.
 */
export function compareByImpact(
  a: { readonly totalScore: number; readonly id: string },
  b: { readonly totalScore: number; readonly id: string }
): number {
  return b.totalScore - a.totalScore || a.id.localeCompare(b.id);
}
