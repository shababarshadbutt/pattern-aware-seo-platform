/**
 * Confidence intervals for a proportion, done the way this product needs them.
 *
 * The legacy engine uses a normal approximation — `1.96 * sqrt(variance)` — and
 * it fails in exactly the case that matters most. With zero observed hits the
 * variance is zero, so the half-width is zero, and the interval collapses to
 * `[0, 0]`: the system reports CERTAINTY that a 40,000-URL pattern has no
 * errors, on the strength of thirty probes. That is not a rounding problem, it
 * is the product asserting something it cannot know, and it is the single most
 * damaging defect Phase 0 found.
 *
 * The Wilson score interval does not degenerate there. At zero hits it gives
 * `[0, z²/(n + z²)]` — a real upper bound that shrinks as the sample grows,
 * which is the honest statement: "we saw none, and there are at most this
 * many". See ADR-0001.
 */

/** Two-sided z for a confidence level. */
const Z_BY_LEVEL = new Map<number, number>([
  [0.9, 1.6448536269514722],
  [0.95, 1.959963984540054],
  [0.99, 2.5758293035489004]
]);

export const DEFAULT_CONFIDENCE_LEVEL = 0.95;

/** Thrown when an interval is asked for on impossible inputs. */
export class InvalidProportionError extends Error {
  public override readonly name = "InvalidProportionError";
}

export function zForConfidenceLevel(level: number): number {
  const z = Z_BY_LEVEL.get(level);

  if (z === undefined) {
    throw new InvalidProportionError(
      `No z value for confidence level ${level}; supported: ${[...Z_BY_LEVEL.keys()].join(", ")}`
    );
  }

  return z;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface ProportionEstimate extends Interval {
  /** The observed proportion, `hits / sampled`. Not the interval's midpoint. */
  readonly point: number;
}

export interface WilsonOptions {
  readonly confidenceLevel?: number;
  /**
   * Population size, when the sample is a meaningful fraction of it.
   *
   * Omit for an effectively infinite population. Supplying it applies the
   * finite-population correction, which is what makes "we checked all 40 of
   * them" produce a point rather than a range.
   */
  readonly population?: number;
}

/**
 * Wilson score interval for `hits` successes in `sampled` trials, with an
 * optional finite-population correction.
 *
 * The FPC shrinks each bound's distance FROM THE OBSERVED PROPORTION by
 * `sqrt(1 - n/N)`. Two properties follow, and both matter:
 *
 *   - at `n = N` the factor is zero and the interval collapses onto `p̂`, which
 *     is correct — that population was counted, not estimated, and claiming
 *     uncertainty about a census would be as wrong as claiming certainty about
 *     a sample;
 *   - at `n << N` the factor is ~1 and the interval is essentially uncorrected,
 *     which is also correct: sampling 400 of 40 million tells you nothing more
 *     than sampling 400 of infinity.
 *
 * Shrinking toward `p̂` rather than toward the Wilson centre is deliberate. The
 * centre is pulled away from `p̂` by design (that is what fixes the degenerate
 * case), and collapsing a census onto anything other than the value actually
 * observed would be indefensible.
 */
export function wilsonInterval(
  hits: number,
  sampled: number,
  options: WilsonOptions = {}
): ProportionEstimate {
  if (!Number.isFinite(hits) || !Number.isFinite(sampled) || hits < 0) {
    throw new InvalidProportionError(
      `hits and sampled must be non-negative finite numbers, got ${hits}/${sampled}`
    );
  }

  if (hits > sampled) {
    throw new InvalidProportionError(
      `hits (${hits}) cannot exceed sampled (${sampled})`
    );
  }

  // Nothing was probed, so nothing is known: the proportion is somewhere in
  // [0, 1]. Reporting a narrower interval here would be inventing information.
  if (sampled <= 0) {
    return { point: 0, low: 0, high: 1 };
  }

  const z = zForConfidenceLevel(
    options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL
  );
  const point = hits / sampled;

  const zSquaredOverN = (z * z) / sampled;
  const denominator = 1 + zSquaredOverN;
  const centre = (point + zSquaredOverN / 2) / denominator;
  const halfWidth =
    (z / denominator) *
    Math.sqrt(
      (point * (1 - point)) / sampled + (z * z) / (4 * sampled * sampled)
    );

  let low = centre - halfWidth;
  let high = centre + halfWidth;

  const population = options.population;

  if (population !== undefined) {
    if (population < sampled) {
      throw new InvalidProportionError(
        `population (${population}) cannot be smaller than sampled (${sampled})`
      );
    }

    const shrink = Math.sqrt(Math.max(0, 1 - sampled / population));

    low = point - (point - low) * shrink;
    high = point + (high - point) * shrink;
  }

  /**
   * Clamped so the interval always contains the observed proportion.
   *
   * Not cosmetic: at p̂ = 1 the upper bound computes to one float-epsilon below
   * one, and `audit_snapshot` has a CHECK constraint requiring
   * `ci_low <= point_estimate <= ci_high`. Without this the estimator would
   * produce a row the database correctly refuses, and the failure would surface
   * as a rejected insert somewhere far from here.
   */
  return {
    point,
    low: Math.min(clampProportion(low), point),
    high: Math.max(clampProportion(high), point)
  };
}

function clampProportion(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}
