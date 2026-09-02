import { describe, expect, it } from "vitest";

import {
  allocateAcrossStrata,
  DEFAULT_SAMPLE_BUDGET,
  firstRoundSampleSize,
  planFirstRound
} from "./sample-plan.js";

const BUDGET = DEFAULT_SAMPLE_BUDGET;

describe("firstRoundSampleSize", () => {
  /**
   * The floor is the whole reason a small pattern is not sampled at 1%: three
   * probes out of 300 would carry an interval so wide it says nothing.
   */
  it("applies the statistical floor to small patterns", () => {
    expect(firstRoundSampleSize(300, BUDGET)).toBe(30);
    expect(firstRoundSampleSize(1_000, BUDGET)).toBe(30);
  });

  it("samples the whole population when it is under the floor", () => {
    expect(firstRoundSampleSize(12, BUDGET)).toBe(12);
    expect(firstRoundSampleSize(1, BUDGET)).toBe(1);
  });

  it("uses the nominal rate in the middle of the range", () => {
    // 1% of 10,000 is 100, which is above the floor and below the ceiling.
    expect(firstRoundSampleSize(10_000, BUDGET)).toBe(100);
  });

  /**
   * The ceiling is a cost control on somebody else's web server, not a
   * statistical choice: 1% of 40 million would be 400,000 requests.
   */
  it("caps large patterns at the first-round ceiling", () => {
    expect(firstRoundSampleSize(40_000_000, BUDGET)).toBe(400);
    expect(firstRoundSampleSize(90_000_000, BUDGET)).toBe(400);
  });

  it("returns nothing for an empty pattern", () => {
    expect(firstRoundSampleSize(0, BUDGET)).toBe(0);
  });
});

describe("allocateAcrossStrata", () => {
  it("splits proportionally when every stratum is large", () => {
    expect(allocateAcrossStrata([8_000, 2_000], 100, 5)).toEqual([80, 20]);
  });

  /**
   * The floor is what stops a small sub-family being described from one or two
   * probes — or from none, which would make it an unsampled stratum and blow
   * the interval open.
   */
  it("gives a tiny stratum its floor rather than its proportional share", () => {
    // A strict 1% split would give the 50-URL stratum zero.
    const allocation = allocateAcrossStrata([500_000, 50], 100, 5);

    expect(allocation[1]).toBeGreaterThanOrEqual(5);
  });

  /**
   * And the floor must SURVIVE the trim back to budget. Taking from the
   * largest first is the substance of the legacy allocator — clawing back off
   * the small stratum instead would undo the floor it was just given.
   */
  it("takes from the largest when trimming to budget", () => {
    const allocation = allocateAcrossStrata([10_000, 40, 40], 30, 5);

    expect(allocation.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30);
    expect(allocation[1]).toBeGreaterThanOrEqual(5);
    expect(allocation[2]).toBeGreaterThanOrEqual(5);
  });

  it("never allocates more than a stratum contains", () => {
    const populations = [3, 7, 1_000];
    const allocation = allocateAcrossStrata(populations, 400, 5);

    for (const [index, count] of allocation.entries()) {
      expect(count).toBeLessThanOrEqual(populations[index] ?? 0);
    }
  });

  /**
   * When the floors alone exceed the budget, going over is the right outcome:
   * describing every stratum matters more than an arbitrary total, and the
   * alternative is silently leaving sub-families unsampled.
   */
  it("keeps every floor even when they exceed the budget", () => {
    const allocation = allocateAcrossStrata([100, 100, 100, 100], 10, 5);

    for (const count of allocation) {
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  it("handles an empty or zero-population input", () => {
    expect(allocateAcrossStrata([], 100, 5)).toEqual([]);
    expect(allocateAcrossStrata([0, 0], 100, 5)).toEqual([0, 0]);
  });

  it("does not spin when every stratum is already full", () => {
    expect(allocateAcrossStrata([2, 3], 400, 5)).toEqual([2, 3]);
  });
});

describe("planFirstRound", () => {
  it("reports the effective rate, not the nominal one", () => {
    // The floor binds here, so the real rate is 30/300 = 10%, not 1%.
    const plan = planFirstRound([{ label: "all", population: 300 }], BUDGET);

    expect(plan.sampleTotal).toBe(30);
    expect(plan.effectiveRate).toBeCloseTo(0.1, 10);
  });

  it("spreads a budget across strata", () => {
    const plan = planFirstRound(
      [
        { label: "big", population: 900_000 },
        { label: "small", population: 100_000 }
      ],
      BUDGET
    );

    expect(plan.populationTotal).toBe(1_000_000);
    expect(plan.sampleTotal).toBeLessThanOrEqual(BUDGET.maxFirstRound);

    const big = plan.strata.find((s) => s.label === "big");
    const small = plan.strata.find((s) => s.label === "small");

    expect(big?.sampleSize).toBeGreaterThan(small?.sampleSize ?? 0);
    expect(small?.sampleSize).toBeGreaterThanOrEqual(BUDGET.minPerStratum);
  });

  it("plans nothing for an empty pattern", () => {
    const plan = planFirstRound([{ label: "all", population: 0 }], BUDGET);

    expect(plan.sampleTotal).toBe(0);
    expect(plan.effectiveRate).toBe(0);
  });
});
