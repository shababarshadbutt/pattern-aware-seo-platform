import {
  type ConfidenceThresholds,
  confidenceBandFor,
  DEFAULT_CONFIDENCE_THRESHOLDS,
  relativeIntervalWidth
} from "./confidence-band.js";
import {
  allocateAcrossStrata,
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "./sample-plan.js";
import type {
  StratifiedEstimate,
  StratumEstimate
} from "./stratified-estimate.js";

export interface ExpansionStratum {
  readonly label: string;
  /** Additional URLs to probe in this stratum. */
  readonly additionalSampleSize: number;
}

export interface ExpansionPlan {
  readonly shouldExpand: boolean;
  /** Why, in a form worth putting in a log or on screen. */
  readonly reason: ExpansionReason;
  readonly additionalTotal: number;
  readonly strata: readonly ExpansionStratum[];
}

export type ExpansionReason =
  | "interval_too_wide"
  | "unsampled_strata"
  | "already_precise"
  | "at_expansion_ceiling"
  | "at_population_ceiling"
  | "nothing_left_to_sample";

export interface ExpansionOptions {
  readonly budget?: SampleBudget;
  readonly confidence?: ConfidenceThresholds;
}

/**
 * Decide whether to look harder, and where.
 *
 * THE TRIGGER IS THE INTERVAL, NOT THE HIT RATE. The legacy engine expands when
 * a stratum's observed hit rate crosses 10%, or when any hit at all shows up on
 * a thin sample. Both are proxies for the thing that actually matters — whether
 * the estimate is precise enough to act on — and they get it wrong in both
 * directions. A pattern with a 30% error rate measured across 400 probes is
 * already tight and does not need more; a pattern with a 2% rate measured
 * across 30 does, and the legacy rule leaves it alone.
 *
 * So the question asked here is simply: is the interval too wide to act on? It
 * uses the SAME threshold the interface uses to print "too uncertain to act on"
 * (ADR-0001, and the shared CONFIDENCE_* config), so the engine can never
 * consider a pattern settled while the screen calls it uncertain.
 *
 * A stratum with zero hits is deliberately NOT expanded on that basis alone.
 * Zero is the cheap, useful signal this layer exists to deliver, and Wilson
 * gives it a real upper bound rather than a false [0, 0] — so a clean pattern
 * with a tight enough ceiling is finished, not suspicious.
 *
 * Effort goes where there is most left to learn: unsampled strata first,
 * because they contribute their entire population to the interval, then the
 * rest in proportion to how much of each is still unprobed.
 */
export function planExpansion(
  estimate: StratifiedEstimate,
  alreadySampled: number,
  options: ExpansionOptions = {}
): ExpansionPlan {
  const budget = options.budget ?? DEFAULT_SAMPLE_BUDGET;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE_THRESHOLDS;

  const none = (reason: ExpansionReason): ExpansionPlan => ({
    shouldExpand: false,
    reason,
    additionalTotal: 0,
    strata: []
  });

  if (estimate.isCounted) {
    return none("already_precise");
  }

  const hasUnsampled = estimate.unsampledStrata.length > 0;
  const band = confidenceBandFor(
    {
      pointEstimate: estimate.pointEstimate,
      ciLow: estimate.ciLow,
      ciHigh: estimate.ciHigh,
      populationCount: estimate.populationCount,
      isCounted: estimate.isCounted
    },
    confidence
  );

  if (!hasUnsampled && band !== "low") {
    return none("already_precise");
  }

  // Three independent ceilings, all of which must hold. Ported wholesale,
  // because each one exists to stop a different way of accidentally turning a
  // cheap triage into a full verification.
  const absoluteRoom = budget.maxExpanded - alreadySampled;
  const relativeRoom = Math.round(
    alreadySampled * (budget.maxExpansionFactor - 1)
  );
  const populationRoom =
    Math.floor(estimate.populationCount * budget.maxPopulationFraction) -
    alreadySampled;

  if (absoluteRoom <= 0) {
    return none("at_expansion_ceiling");
  }

  if (populationRoom <= 0) {
    return none("at_population_ceiling");
  }

  const room = Math.min(absoluteRoom, relativeRoom, populationRoom);

  if (room <= 0) {
    return none("at_expansion_ceiling");
  }

  /**
   * Headroom per stratum: how much of it remains unprobed. An unsampled
   * stratum is weighted by its whole population, which is what pulls the first
   * probes toward the parts of the pattern nothing is known about.
   */
  const targets = selectTargets(estimate, confidence);

  if (targets.length === 0) {
    return none("already_precise");
  }

  const headroom = targets.map((stratum) =>
    Math.max(0, stratum.population - stratum.sampled)
  );
  const totalHeadroom = headroom.reduce((sum, value) => sum + value, 0);

  if (totalHeadroom === 0) {
    return none("nothing_left_to_sample");
  }

  const additional = allocateAcrossStrata(
    headroom,
    Math.min(room, totalHeadroom),
    // No per-stratum floor here: these strata already have a sample, and this
    // is about topping up where it helps rather than guaranteeing coverage.
    0
  );

  const strata = targets
    .map((stratum, index) => ({
      label: stratum.label,
      additionalSampleSize: additional[index] ?? 0
    }))
    .filter((stratum) => stratum.additionalSampleSize > 0);

  const additionalTotal = strata.reduce(
    (sum, stratum) => sum + stratum.additionalSampleSize,
    0
  );

  if (additionalTotal === 0) {
    return none("nothing_left_to_sample");
  }

  return {
    shouldExpand: true,
    reason: hasUnsampled ? "unsampled_strata" : "interval_too_wide",
    additionalTotal,
    strata
  };
}

/**
 * Which strata are worth more probes.
 *
 * Unsampled ones always, since they contribute their entire population to the
 * interval. Otherwise the ones whose own interval is too wide — a stratum
 * already measured tightly gains nothing from more probes, and spending budget
 * there is budget not spent where the uncertainty actually is.
 */
function selectTargets(
  estimate: StratifiedEstimate,
  confidence: ConfidenceThresholds
): readonly StratumEstimate[] {
  const unsampled = estimate.strata.filter((stratum) => stratum.isUnsampled);

  if (unsampled.length > 0) {
    return unsampled;
  }

  const imprecise = estimate.strata.filter((stratum) => {
    if (stratum.sampled >= stratum.population) {
      return false;
    }

    return (
      relativeIntervalWidth({
        pointEstimate: stratum.estimatedUrls,
        ciLow: stratum.low,
        ciHigh: stratum.high,
        populationCount: stratum.population
      }) >= confidence.lowWidth
    );
  });

  // If no single stratum is individually imprecise but the total still is, the
  // width is coming from the aggregate, so top up everything with room left.
  return imprecise.length > 0
    ? imprecise
    : estimate.strata.filter((stratum) => stratum.sampled < stratum.population);
}
