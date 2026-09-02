/**
 * How many URLs to probe, and how to spread them across a pattern's strata.
 *
 * The bounds are ported from the legacy engine, which arrived at them against
 * real client sites and documented why each one exists. They are cost controls
 * on somebody else's production web server as much as statistical choices, so
 * they are kept rather than re-derived.
 */
export interface SampleBudget {
  /**
   * Nominal share of a population to probe.
   *
   * Only ever a starting point: the floor and ceilings below almost always
   * bind, which is why the REAL rate (`sampleSize / population`) is what gets
   * reported rather than this number.
   */
  readonly sampleRate: number;
  /**
   * Statistical floor. Below roughly thirty observations a proportion carries
   * an interval so wide it says nothing, so small patterns are sampled at far
   * more than the nominal rate — correctly. Clamped to the population when that
   * is smaller.
   */
  readonly minSample: number;
  /** Cost ceiling for the first round. At 25 req/s, 400 probes is ~16 seconds. */
  readonly maxFirstRound: number;
  /**
   * Ceiling including any expansion. Past roughly 1,200 probes the cheap option
   * has stopped being cheap and a full verification is the honest advice.
   */
  readonly maxExpanded: number;
  /**
   * An expansion may add at most this multiple of the first round.
   *
   * Without it, "how much room is left under the ceiling" is the only limit,
   * and on a small pattern that means expanding to the entire population. The
   * legacy integration test caught exactly that — a 200-URL pattern triaged at
   * 200/200. A triage that probes everything is not a triage.
   */
  readonly maxExpansionFactor: number;
  /**
   * And regardless of the above, never touch more than this fraction of the
   * population. Past about a quarter, pay a little more and get an exact answer.
   */
  readonly maxPopulationFraction: number;
  /**
   * Floor per stratum, so a small sub-family is never described from one or two
   * observations. This is what keeps `unsampledStrata` empty.
   */
  readonly minPerStratum: number;
}

export const DEFAULT_SAMPLE_BUDGET: SampleBudget = {
  sampleRate: 0.01,
  minSample: 30,
  maxFirstRound: 400,
  maxExpanded: 1_200,
  maxExpansionFactor: 3,
  maxPopulationFraction: 0.25,
  minPerStratum: 5
};

/**
 * How many URLs the first round should probe.
 *
 * `min(population, max(min(minSample, population), min(maxFirstRound, rate·N)))`
 * — the floor wins on small patterns, the ceiling on large ones, and the
 * nominal rate only ever applies in between.
 */
export function firstRoundSampleSize(
  population: number,
  budget: SampleBudget = DEFAULT_SAMPLE_BUDGET
): number {
  if (population <= 0) {
    return 0;
  }

  const nominal = Math.round(population * budget.sampleRate);
  const floor = Math.min(budget.minSample, population);
  const ceiling = Math.min(budget.maxFirstRound, Math.max(nominal, 0));

  return Math.min(population, Math.max(floor, ceiling));
}

/**
 * Spread a budget across strata: proportional to population, with a floor per
 * stratum, then trimmed back from the largest allocations so the floors survive.
 *
 * Ported from the legacy allocator. The trim order is the substance of it —
 * taking from the largest first is what stops a floor being clawed back off a
 * small stratum, which would leave that sub-family described by one or two
 * probes or by none at all.
 */
export function allocateAcrossStrata(
  populations: readonly number[],
  budget: number,
  minPerStratum: number
): readonly number[] {
  const total = populations.reduce((sum, value) => sum + value, 0);

  if (total === 0 || populations.length === 0) {
    return populations.map(() => 0);
  }

  const allocation = populations.map((population) =>
    Math.min(
      population,
      Math.max(
        Math.min(minPerStratum, population),
        Math.round((population / total) * budget)
      )
    )
  );

  let assigned = allocation.reduce((sum, value) => sum + value, 0);

  // Over budget: take from the largest allocations, never below a floor.
  while (assigned > budget) {
    let bestIndex = -1;
    let bestValue = -1;

    for (let index = 0; index < allocation.length; index += 1) {
      const floor = Math.min(minPerStratum, populations[index] ?? 0);
      const current = allocation[index] ?? 0;

      if (current > floor && current > bestValue) {
        bestValue = current;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      /**
       * Everything is already at its floor and the floors alone exceed the
       * budget. Going over is the right outcome: describing every stratum
       * matters more than hitting an arbitrary total, and the alternative is
       * silently leaving sub-families unsampled.
       */
      break;
    }

    allocation[bestIndex] = (allocation[bestIndex] ?? 0) - 1;
    assigned -= 1;
  }

  // Under budget with room left: give the remainder out, largest first.
  const order = populations
    .map((population, index) => ({ population, index }))
    .sort((a, b) => b.population - a.population);

  let cursor = 0;
  const guard = order.length * 1_000;

  while (assigned < budget && cursor < guard) {
    const entry = order[cursor % order.length];

    if (entry === undefined) {
      break;
    }

    const current = allocation[entry.index] ?? 0;

    if (current < (populations[entry.index] ?? 0)) {
      allocation[entry.index] = current + 1;
      assigned += 1;
    } else if (
      order.every(
        (item) =>
          (allocation[item.index] ?? 0) >= (populations[item.index] ?? 0)
      )
    ) {
      // Every stratum is fully sampled; there is nothing left to spend on.
      break;
    }

    cursor += 1;
  }

  return allocation;
}

export interface StratumPlan {
  readonly label: string;
  readonly population: number;
  /** How many of this stratum's URLs to probe. */
  readonly sampleSize: number;
}

export interface SamplePlan {
  readonly populationTotal: number;
  readonly sampleTotal: number;
  /** `sampleTotal / populationTotal` — the rate to report, not the nominal one. */
  readonly effectiveRate: number;
  readonly strata: readonly StratumPlan[];
}

/** Plan a pattern's first round across its strata. */
export function planFirstRound(
  strata: readonly { readonly label: string; readonly population: number }[],
  budget: SampleBudget = DEFAULT_SAMPLE_BUDGET
): SamplePlan {
  const populationTotal = strata.reduce(
    (sum, stratum) => sum + stratum.population,
    0
  );

  if (populationTotal === 0) {
    return {
      populationTotal: 0,
      sampleTotal: 0,
      effectiveRate: 0,
      strata: strata.map((stratum) => ({ ...stratum, sampleSize: 0 }))
    };
  }

  const total = firstRoundSampleSize(populationTotal, budget);
  const allocation = allocateAcrossStrata(
    strata.map((stratum) => stratum.population),
    total,
    budget.minPerStratum
  );

  const planned = strata.map((stratum, index) => ({
    label: stratum.label,
    population: stratum.population,
    sampleSize: allocation[index] ?? 0
  }));

  const sampleTotal = planned.reduce(
    (sum, stratum) => sum + stratum.sampleSize,
    0
  );

  return {
    populationTotal,
    sampleTotal,
    effectiveRate: sampleTotal / populationTotal,
    strata: planned
  };
}
