import { type ConfidenceBand, confidenceBandFor } from "./confidence-band.js";
import { ESTIMATOR_VERSION } from "./estimator-version.js";
import {
  type ExpansionOptions,
  type ExpansionPlan,
  planExpansion
} from "./expansion.js";
import {
  estimateStratified,
  type StratifiedEstimateOptions,
  type StratumObservation
} from "./stratified-estimate.js";

/**
 * One measurement, as everything that publishes a claim must express it.
 *
 * THE COMPOSITION IS THE POINT, NOT THE ARITHMETIC. `estimateStratified` and
 * `confidenceBandFor` were already shared; what was not shared was the order
 * they go in and the rule that turns their output into an evidence tier. That
 * three-step composition lived inside the pipeline's `buildSnapshot`, which was
 * fine while the pipeline was the only thing measuring anything.
 *
 * It is not any more. The sample-plan tool answers "what would you conclude
 * from n of N with h hits?", and the only honest answer is the one the pipeline
 * would reach for the same numbers. A tool that recomposed these three steps
 * itself would be a second source of truth — correct on the day it was written
 * and free to drift every day after, while looking authoritative because it
 * calls the same underlying functions.
 *
 * NOTE WHAT THIS FUNCTION DOES NOT TAKE: a `ConfidenceThresholds`. That is
 * deliberate and structural rather than a convention to remember. The four
 * `CONFIDENCE_*` environment variables are validated at startup and applied by
 * nothing — `/settings` badges them NOT ENFORCED for exactly that reason —
 * because `confidenceBandFor` falls back to `DEFAULT_CONFIDENCE_THRESHOLDS`. A
 * caller that threaded the configured values in would produce a band the
 * pipeline does not use, while the Settings screen went on truthfully saying
 * those numbers do nothing. There is no parameter here through which that can
 * happen.
 */

export interface Measurement {
  /**
   * `counted` only when the sample covered the population. The `audit_snapshot`
   * CHECK constraint enforces the same rule, so this is the application
   * agreeing with the schema rather than the schema catching the application.
   */
  readonly evidenceTier: "counted" | "estimated";
  readonly observedCount: number;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceLevel: number;
  readonly confidenceBand: ConfidenceBand;
  /** Which version of the estimator produced this. Stamped on every claim. */
  readonly estimatorVersion: string;
}

/**
 * Measure a proportion across one or more strata, and say how much to trust it.
 *
 * The single composition every published claim goes through: Wilson with
 * finite-population correction per stratum, conservative combination across
 * them, then the band and the tier.
 */
export function measureProportion(
  observations: readonly StratumObservation[],
  options?: StratifiedEstimateOptions
): Measurement {
  const estimate = estimateStratified(observations, options);

  return {
    evidenceTier: estimate.isCounted ? "counted" : "estimated",
    observedCount: estimate.observedCount,
    sampleSize: estimate.sampleSize,
    populationCount: estimate.populationCount,
    pointEstimate: estimate.pointEstimate,
    ciLow: estimate.ciLow,
    ciHigh: estimate.ciHigh,
    confidenceLevel: estimate.confidenceLevel,
    confidenceBand: confidenceBandFor({
      pointEstimate: estimate.pointEstimate,
      ciLow: estimate.ciLow,
      ciHigh: estimate.ciHigh,
      populationCount: estimate.populationCount,
      isCounted: estimate.isCounted
    }),
    estimatorVersion: ESTIMATOR_VERSION
  };
}

/**
 * Whether a second, larger draw would narrow the interval — from observations
 * rather than from a caller-built estimate.
 *
 * THIS EXISTS BECAUSE THE ALTERNATIVE PRODUCED A CONFIDENT LIE. `planExpansion`
 * takes a `StratifiedEstimate`, and a caller holding only a `Measurement` has
 * to construct one to ask the question. The tool route did exactly that, filled
 * `strata` and `unsampledStrata` with empty arrays because a `Measurement` does
 * not carry them, and got back `already_precise` for a sample whose own band
 * was `low` — the screen reported "a second round would not change the answer
 * materially" directly beneath an interval spanning 11% of the population.
 *
 * Nothing failed. Every type checked, every test passed, and the two panels
 * contradicted each other on a rendered page. So the fix is not a rule about
 * building the estimate correctly: it is removing the opportunity. A caller
 * passes what it actually has — the observations — and the estimate is built
 * here, once, the same way {@link measureProportion} builds it.
 */
export function planExpansionFor(
  observations: readonly StratumObservation[],
  alreadySampled: number,
  options?: ExpansionOptions & StratifiedEstimateOptions
): ExpansionPlan {
  const estimate = estimateStratified(
    observations,
    options?.confidenceLevel === undefined
      ? undefined
      : { confidenceLevel: options.confidenceLevel }
  );

  return planExpansion(estimate, alreadySampled, options);
}
