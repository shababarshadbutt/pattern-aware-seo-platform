import { describe, expect, it } from "vitest";

import {
  estimateStratified,
  type StratumObservation
} from "./stratified-estimate.js";
import { InvalidProportionError, wilsonInterval } from "./wilson.js";

const one = (over: Partial<StratumObservation> = {}): StratumObservation => ({
  label: "all",
  population: 40_000,
  sampled: 400,
  hits: 8,
  ...over
});

describe("estimateStratified", () => {
  describe("with a single stratum", () => {
    /**
     * The unstratified case is just this with one stratum, so there is no
     * second code path — which is the point of routing both through here.
     */
    it("extrapolates the observed rate to the population", () => {
      const estimate = estimateStratified([one()]);

      // 8/400 = 2% of 40,000 = 800.
      expect(estimate.pointEstimate).toBe(800);
      expect(estimate.populationCount).toBe(40_000);
      expect(estimate.sampleSize).toBe(400);
      expect(estimate.observedCount).toBe(8);
    });

    it("matches the single-proportion interval scaled to the population", () => {
      const rate = wilsonInterval(8, 400, { population: 40_000 });
      const estimate = estimateStratified([one()]);

      expect(estimate.ciLow).toBe(Math.round(rate.low * 40_000));
      expect(estimate.ciHigh).toBe(Math.round(rate.high * 40_000));
    });

    /**
     * The headline defect, at the level the product actually publishes:
     * "we found no 404s" must not become "there are definitely no 404s".
     */
    it("never claims certainty from a partial sample that found nothing", () => {
      const estimate = estimateStratified([one({ hits: 0, sampled: 30 })]);

      expect(estimate.pointEstimate).toBe(0);
      expect(estimate.ciLow).toBe(0);
      expect(estimate.ciHigh).toBeGreaterThan(0);
      expect(estimate.isCounted).toBe(false);
    });

    it("collapses to an exact count when the whole population was probed", () => {
      const estimate = estimateStratified([
        one({ population: 250, sampled: 250, hits: 9 })
      ]);

      expect(estimate.pointEstimate).toBe(9);
      expect(estimate.ciLow).toBe(9);
      expect(estimate.ciHigh).toBe(9);
      expect(estimate.isCounted).toBe(true);
    });
  });

  describe("weighting by real population", () => {
    /**
     * The reason stratification exists at all. A small family that is entirely
     * broken must carry its own weight rather than being averaged into a large
     * healthy one.
     *
     * Flat: 20 hits in 400 over 40,000 URLs would read as 2,000.
     * Weighted: the broken 1,000-URL family contributes ~1,000 on its own, and
     * the healthy 39,000 contributes ~0.
     */
    it("lets a small broken family carry its own weight", () => {
      const estimate = estimateStratified([
        { label: "healthy", population: 39_000, sampled: 380, hits: 0 },
        { label: "broken", population: 1_000, sampled: 20, hits: 20 }
      ]);

      expect(estimate.pointEstimate).toBe(1_000);

      const broken = estimate.strata.find((s) => s.label === "broken");

      expect(broken?.estimatedUrls).toBe(1_000);
      expect(broken?.rate.point).toBe(1);
    });

    it("sums the per-stratum extrapolations", () => {
      const estimate = estimateStratified([
        { label: "a", population: 10_000, sampled: 100, hits: 10 },
        { label: "b", population: 20_000, sampled: 200, hits: 4 },
        { label: "c", population: 5_000, sampled: 50, hits: 0 }
      ]);

      // 10% of 10,000 + 2% of 20,000 + 0% of 5,000 = 1,000 + 400 + 0.
      expect(estimate.pointEstimate).toBe(1_400);
      expect(estimate.populationCount).toBe(35_000);
      expect(estimate.sampleSize).toBe(350);
      expect(estimate.observedCount).toBe(14);
    });

    /**
     * ADR-0001's second layer: the total's interval is the SUM of the
     * per-stratum bounds, not a single normal half-width. Conservative by
     * construction, and the direction to err in when a client reads the number.
     */
    it("builds the total interval by summing per-stratum bounds", () => {
      const strata: StratumObservation[] = [
        { label: "a", population: 10_000, sampled: 100, hits: 10 },
        { label: "b", population: 20_000, sampled: 200, hits: 4 }
      ];

      const estimate = estimateStratified(strata);
      const expectedLow = strata.reduce(
        (sum, s) =>
          sum +
          s.population *
            wilsonInterval(s.hits, s.sampled, { population: s.population }).low,
        0
      );

      expect(estimate.ciLow).toBe(Math.round(expectedLow));
    });
  });

  describe("unsampled strata", () => {
    /**
     * Nothing probed means nothing known, so the stratum contributes its whole
     * population to the upper bound. That is honest but very wide — which is
     * exactly why the allocator gives every reportable stratum a floor, and why
     * this is surfaced rather than hidden.
     */
    it("contributes the full population to the upper bound", () => {
      const estimate = estimateStratified([
        { label: "seen", population: 10_000, sampled: 100, hits: 0 },
        { label: "unseen", population: 3_000, sampled: 0, hits: 0 }
      ]);

      expect(estimate.unsampledStrata).toEqual(["unseen"]);
      expect(estimate.ciHigh).toBeGreaterThanOrEqual(3_000);
    });

    /**
     * Deliberately NOT folded in at the overall observed rate. Doing so would
     * dress an assumption up as a measurement.
     */
    it("contributes nothing to the point estimate", () => {
      const estimate = estimateStratified([
        { label: "seen", population: 10_000, sampled: 100, hits: 50 },
        { label: "unseen", population: 10_000, sampled: 0, hits: 0 }
      ]);

      // 50% of the seen 10,000, and nothing invented for the unseen half.
      expect(estimate.pointEstimate).toBe(5_000);
    });

    it("is never counted", () => {
      const estimate = estimateStratified([
        { label: "seen", population: 10, sampled: 10, hits: 1 },
        { label: "unseen", population: 5, sampled: 0, hits: 0 }
      ]);

      expect(estimate.isCounted).toBe(false);
    });
  });

  describe("invariants the database also enforces", () => {
    /**
     * `audit_snapshot` has CHECK constraints for all of these. An estimator
     * that violated one would produce a row Postgres refuses, surfacing as a
     * failed insert far from the cause — so they are asserted here too.
     */
    it("keeps the point estimate inside its own interval", () => {
      const cases: StratumObservation[][] = [
        [one({ hits: 0 })],
        [one({ hits: 400 })],
        [one({ hits: 1, sampled: 1, population: 1 })],
        [
          { label: "a", population: 3, sampled: 3, hits: 3 },
          { label: "b", population: 1_000_000, sampled: 30, hits: 1 }
        ]
      ];

      for (const strata of cases) {
        const estimate = estimateStratified(strata);

        expect(estimate.ciLow).toBeLessThanOrEqual(estimate.pointEstimate);
        expect(estimate.pointEstimate).toBeLessThanOrEqual(estimate.ciHigh);
      }
    });

    it("keeps the interval inside the population", () => {
      const estimate = estimateStratified([one({ hits: 399 })]);

      expect(estimate.ciLow).toBeGreaterThanOrEqual(0);
      expect(estimate.ciHigh).toBeLessThanOrEqual(estimate.populationCount);
    });

    /**
     * The degenerate-interval CHECK, mirrored. A non-exhaustive sample may
     * never produce ci_low === ci_high.
     */
    it("never produces a zero-width interval from a partial sample", () => {
      for (const hits of [0, 1, 200, 399, 400]) {
        const estimate = estimateStratified([one({ hits })]);

        expect(estimate.sampleSize).toBeLessThan(estimate.populationCount);
        expect(estimate.ciHigh).toBeGreaterThan(estimate.ciLow);
      }
    });

    it("rejects a stratum sampled beyond its population", () => {
      expect(() =>
        estimateStratified([
          { label: "x", population: 10, sampled: 20, hits: 1 }
        ])
      ).toThrow(InvalidProportionError);
    });
  });

  it("handles an empty pattern without dividing by zero", () => {
    const estimate = estimateStratified([]);

    expect(estimate.pointEstimate).toBe(0);
    expect(estimate.populationCount).toBe(0);
    expect(estimate.isCounted).toBe(false);
  });
});
