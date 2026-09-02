/**
 * The statistical core.
 *
 * Everything here is pure and synchronous. That is deliberate: this is the part
 * of the system where a wrong-but-plausible answer is most expensive and least
 * likely to be caught by review, so every decision it makes must be testable
 * against a hand-computed value without a database, a network, or a sitemap.
 */
export {
  BoundedHashSample,
  type SampleCandidate
} from "./bounded-hash-sample.js";
export {
  type BandInput,
  bandForEstimate,
  type ConfidenceBand,
  type ConfidenceThresholds,
  confidenceBandFor,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  relativeIntervalWidth
} from "./confidence-band.js";
export { ESTIMATOR_VERSION } from "./estimator-version.js";
export {
  type ExpansionOptions,
  type ExpansionPlan,
  type ExpansionReason,
  type ExpansionStratum,
  planExpansion
} from "./expansion.js";
export {
  allocateAcrossStrata,
  DEFAULT_SAMPLE_BUDGET,
  firstRoundSampleSize,
  planFirstRound,
  type SampleBudget,
  type SamplePlan,
  type StratumPlan
} from "./sample-plan.js";
export { compareSampleKeys, stableHash } from "./stable-hash.js";
export {
  estimateStratified,
  type StratifiedEstimate,
  type StratifiedEstimateOptions,
  type StratumEstimate,
  type StratumObservation
} from "./stratified-estimate.js";
export {
  groupByShape,
  pathShape,
  valueShape
} from "./value-shape.js";
export {
  DEFAULT_CONFIDENCE_LEVEL,
  type Interval,
  InvalidProportionError,
  type ProportionEstimate,
  type WilsonOptions,
  wilsonInterval,
  zForConfidenceLevel
} from "./wilson.js";
