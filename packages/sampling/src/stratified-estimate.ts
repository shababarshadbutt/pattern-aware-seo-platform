import {
  DEFAULT_CONFIDENCE_LEVEL,
  InvalidProportionError,
  type ProportionEstimate,
  wilsonInterval
} from "./wilson.js";

/**
 * What was observed in one stratum — one sub-family of a pattern's URLs.
 *
 * `population` must be COUNTED, not estimated. That is the whole reason the
 * ingestion pass tallies per-shape counts: post-stratifying with weights taken
 * from the sample itself would algebraically collapse back to the unstratified
 * estimate, buying nothing. Real weights are what let a small broken family
 * carry its own size instead of being averaged away.
 */
export interface StratumObservation {
  readonly label: string;
  /** N_h — counted during ingestion. */
  readonly population: number;
  /** n_h — how many of this stratum's URLs were probed. */
  readonly sampled: number;
  /** How many of those came back matching the status being estimated. */
  readonly hits: number;
}

export interface StratumEstimate {
  readonly label: string;
  readonly population: number;
  readonly sampled: number;
  readonly hits: number;
  /** The proportion and its interval within this stratum. */
  readonly rate: ProportionEstimate;
  /** Extrapolated URL counts: `population * rate`. */
  readonly estimatedUrls: number;
  readonly low: number;
  readonly high: number;
  /** True when nothing from this stratum was probed. */
  readonly isUnsampled: boolean;
}

export interface StratifiedEstimate {
  /** Σ N_h · p̂_h, rounded. */
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceLevel: number;
  /** Σ N_h across every stratum. The denominator any rate is against. */
  readonly populationCount: number;
  /** Σ n_h. */
  readonly sampleSize: number;
  /** Σ hits_h. */
  readonly observedCount: number;
  readonly strata: readonly StratumEstimate[];
  /**
   * Strata that were never probed, if any.
   *
   * Each contributes `[0, N_h]` to the interval, because nothing is known about
   * it — which is honest but widens the result a lot. A non-empty list here is
   * a planning failure, not a statistical one: the allocator is supposed to
   * give every reportable stratum a floor. Surfaced rather than hidden so the
   * caller can say so instead of quietly publishing a vague number.
   */
  readonly unsampledStrata: readonly string[];
  /**
   * True when every stratum was probed exhaustively.
   *
   * This is the `counted` evidence tier: the interval has collapsed onto the
   * point estimate because there is nothing left to be uncertain about.
   */
  readonly isCounted: boolean;
}

export interface StratifiedEstimateOptions {
  readonly confidenceLevel?: number;
}

/**
 * Extrapolate a stratified sample to the whole population, with an interval.
 *
 * TWO LAYERS, for the reason ADR-0001 sets out: the Wilson interval is defined
 * for a SINGLE proportion, so "use Wilson" does not by itself say what to do
 * with a stratified total.
 *
 *   1. Per stratum, a Wilson interval on `hits_h / n_h` with the
 *      finite-population correction against `N_h`.
 *   2. For the total, the usual point estimate `Σ N_h · p̂_h`, but the interval
 *      built as `[Σ N_h · low_h, Σ N_h · high_h]` rather than from a single
 *      normal half-width.
 *
 * Summing bounds treats the strata as if their errors line up, which they
 * generally do not, so the result is a bound rather than a tight interval — it
 * is wider than a variance-combined one. That is the right direction to err
 * when the number is going in front of a client, and it is the only form that
 * is verifiable by hand in a test. If that conservatism ever costs a real
 * decision, the alternative is a variance-combined interval with a per-stratum
 * continuity correction, and it needs its own ADR.
 *
 * The unstratified case is just this with one stratum, so there is no second
 * code path to keep in agreement.
 */
export function estimateStratified(
  observations: readonly StratumObservation[],
  options: StratifiedEstimateOptions = {}
): StratifiedEstimate {
  const confidenceLevel = options.confidenceLevel ?? DEFAULT_CONFIDENCE_LEVEL;

  let pointEstimate = 0;
  let ciLow = 0;
  let ciHigh = 0;
  let populationCount = 0;
  let sampleSize = 0;
  let observedCount = 0;
  let everyStratumCounted = true;

  const strata: StratumEstimate[] = [];
  const unsampledStrata: string[] = [];

  for (const observation of observations) {
    if (observation.population < 0 || observation.sampled < 0) {
      throw new InvalidProportionError(
        `Stratum ${observation.label} has negative counts`
      );
    }

    if (observation.sampled > observation.population) {
      throw new InvalidProportionError(
        `Stratum ${observation.label} sampled ${observation.sampled} of a population of ${observation.population}`
      );
    }

    /**
     * `hits` is validated HERE, before anything is aggregated.
     *
     * `wilsonInterval` enforces `0 <= hits <= sampled` itself, but the
     * unsampled shortcut below returns before reaching it — so an impossible
     * observation like `{ sampled: 0, hits: 1 }` would slip past, inflate
     * `observedCount`, and produce an estimate whose parts do not add up. The
     * database's `ck_audit_snapshot_counts_sane` would then reject the row far
     * from the cause.
     */
    if (!Number.isFinite(observation.hits) || observation.hits < 0) {
      throw new InvalidProportionError(
        `Stratum ${observation.label} has ${observation.hits} hits, which is not a non-negative finite number`
      );
    }

    if (observation.hits > observation.sampled) {
      throw new InvalidProportionError(
        `Stratum ${observation.label} recorded ${observation.hits} hits from ${observation.sampled} probes`
      );
    }

    populationCount += observation.population;
    sampleSize += observation.sampled;
    observedCount += observation.hits;

    const isUnsampled = observation.sampled === 0 && observation.population > 0;

    if (isUnsampled) {
      unsampledStrata.push(observation.label);
      everyStratumCounted = false;

      // Nothing was probed here, so the rate is anywhere in [0, 1] and the
      // contribution is the whole stratum. Deliberately not folded in at the
      // overall observed rate: that would look like evidence.
      strata.push({
        label: observation.label,
        population: observation.population,
        sampled: 0,
        hits: 0,
        rate: { point: 0, low: 0, high: 1 },
        estimatedUrls: 0,
        low: 0,
        high: observation.population,
        isUnsampled: true
      });

      ciHigh += observation.population;

      continue;
    }

    if (observation.sampled < observation.population) {
      everyStratumCounted = false;
    }

    const rate = wilsonInterval(observation.hits, observation.sampled, {
      confidenceLevel,
      population: observation.population
    });

    const estimatedUrls = observation.population * rate.point;
    const low = observation.population * rate.low;
    const high = observation.population * rate.high;

    pointEstimate += estimatedUrls;
    ciLow += low;
    ciHigh += high;

    strata.push({
      label: observation.label,
      population: observation.population,
      sampled: observation.sampled,
      hits: observation.hits,
      rate,
      estimatedUrls: Math.round(estimatedUrls),
      low: Math.round(low),
      high: Math.round(high),
      isUnsampled: false
    });
  }

  const rounded = {
    pointEstimate: Math.round(pointEstimate),
    ciLow: Math.round(ciLow),
    ciHigh: Math.round(ciHigh)
  };

  return {
    // Rounding is applied last and then re-clamped, because rounding three
    // numbers independently can otherwise put the point estimate a whole URL
    // outside its own interval — which the database rejects, correctly.
    pointEstimate: rounded.pointEstimate,
    ciLow: Math.min(rounded.ciLow, rounded.pointEstimate),
    ciHigh: Math.max(rounded.ciHigh, rounded.pointEstimate),
    confidenceLevel,
    populationCount,
    sampleSize,
    observedCount,
    strata,
    unsampledStrata,
    isCounted: everyStratumCounted && populationCount > 0
  };
}
