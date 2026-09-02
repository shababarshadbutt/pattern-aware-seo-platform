import type { StratifiedEstimate } from "./stratified-estimate.js";

/**
 * How much an estimate can be relied on, in words rather than statistics.
 *
 * Deliberately computed here rather than in the UI, and consumed by BOTH the
 * adaptive expansion trigger and the interface. If they used separate
 * definitions the product would flag a pattern as too uncertain to act on while
 * the engine considered it settled — or, worse, the reverse.
 */
export type ConfidenceBand = "confident" | "approximate" | "low";

export interface ConfidenceThresholds {
  /** Interval width relative to the ESTIMATE, below which it is `confident`. */
  readonly approximateWidth: number;
  /** Interval width relative to the estimate, at or above which it is `low`. */
  readonly lowWidth: number;
  /**
   * The same two cuts for the zero-hit case, where width is measured against
   * the POPULATION instead.
   *
   * Necessarily different numbers, because they measure a different quantity.
   * "Give or take half the estimate" is a lot of RELATIVE error; "up to 11% of
   * the population might be broken and we would not know" is a lot of ABSOLUTE
   * error, and 11% is comfortably inside the 20% relative cut. Reusing the
   * relative thresholds here rated a pattern where thirty probes found nothing
   * — a ceiling of 4,539 possible broken URLs out of 40,000 — as `confident`.
   *
   * Calibrated against what the sample sizes actually produce at zero hits:
   * 400 probes leave a ceiling near 0.9%, 100 leave 3.7%, and 30 leave 11.3%.
   */
  readonly zeroHitApproximateWidth: number;
  readonly zeroHitLowWidth: number;
}

/** Matches CONFIDENCE_* in packages/shared config; passed in, never read here. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  approximateWidth: 0.2,
  lowWidth: 0.5,
  zeroHitApproximateWidth: 0.02,
  zeroHitLowWidth: 0.1
};

export interface BandInput {
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly populationCount: number;
  /** True when n = N. A census has nothing left to be uncertain about. */
  readonly isCounted?: boolean;
}

/**
 * Relative interval width — the number the bands are cut from.
 *
 * `(high - low) / point` for any ordinary estimate. The zero-hit case needs its
 * own rule, and getting it wrong matters more than it looks.
 *
 * When nothing was observed the point estimate is zero, so a ratio against it
 * is infinite and every clean pattern on the fleet would be classified as LOW
 * confidence. That is not merely pedantic: it would swamp the "share of
 * patterns stuck at LOW confidence" alert with healthy patterns and make the
 * signal useless. What the zero case is really asking is how tight the ceiling
 * is — "we saw no errors, and there are at most this many" — so the width is
 * measured against the population instead. A pattern where 400 probes found
 * nothing has an upper bound near 1% of its population and is genuinely
 * confident; one where 30 probes found nothing has a bound near 11% and is not.
 */
export function relativeIntervalWidth(estimate: BandInput): number {
  const width = Math.max(0, estimate.ciHigh - estimate.ciLow);

  if (estimate.pointEstimate > 0) {
    return width / estimate.pointEstimate;
  }

  if (width === 0) {
    // Nothing found, and nothing possible. A census of a clean pattern.
    return 0;
  }

  if (estimate.populationCount <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return width / estimate.populationCount;
}

/** Classify an estimate's precision. */
export function confidenceBandFor(
  estimate: BandInput,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): ConfidenceBand {
  if (estimate.isCounted === true) {
    return "confident";
  }

  const width = relativeIntervalWidth(estimate);

  // Which pair applies depends on what the width was measured against — see
  // the note on the zero-hit thresholds.
  const isZeroHit = estimate.pointEstimate <= 0;
  const approximateAt = isZeroHit
    ? thresholds.zeroHitApproximateWidth
    : thresholds.approximateWidth;
  const lowAt = isZeroHit ? thresholds.zeroHitLowWidth : thresholds.lowWidth;

  if (width < approximateAt) {
    return "confident";
  }

  if (width < lowAt) {
    return "approximate";
  }

  return "low";
}

/** Convenience for the common case of banding a stratified result. */
export function bandForEstimate(
  estimate: StratifiedEstimate,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS
): ConfidenceBand {
  return confidenceBandFor(
    {
      pointEstimate: estimate.pointEstimate,
      ciLow: estimate.ciLow,
      ciHigh: estimate.ciHigh,
      populationCount: estimate.populationCount,
      isCounted: estimate.isCounted
    },
    thresholds
  );
}
