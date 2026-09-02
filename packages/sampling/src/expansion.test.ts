import { describe, expect, it } from "vitest";

import { confidenceBandFor, relativeIntervalWidth } from "./confidence-band.js";
import { planExpansion } from "./expansion.js";
import { DEFAULT_SAMPLE_BUDGET } from "./sample-plan.js";
import {
  estimateStratified,
  type StratumObservation
} from "./stratified-estimate.js";

const BUDGET = DEFAULT_SAMPLE_BUDGET;

function expansionFor(
  strata: readonly StratumObservation[],
  alreadySampled?: number
) {
  const estimate = estimateStratified(strata);
  const sampled =
    alreadySampled ?? strata.reduce((sum, s) => sum + s.sampled, 0);

  return planExpansion(estimate, sampled);
}

describe("confidence bands", () => {
  it("calls a tight interval confident", () => {
    expect(
      confidenceBandFor({
        pointEstimate: 1_000,
        ciLow: 950,
        ciHigh: 1_050,
        populationCount: 40_000
      })
    ).toBe("confident");
  });

  it("calls a wide interval low", () => {
    expect(
      confidenceBandFor({
        pointEstimate: 1_000,
        ciLow: 200,
        ciHigh: 3_000,
        populationCount: 40_000
      })
    ).toBe("low");
  });

  /**
   * The zero-hit case needs its own rule, and getting it wrong matters more
   * than it looks: measured against a point estimate of zero, EVERY clean
   * pattern on the fleet would be classified LOW and would swamp the
   * "share of patterns stuck at LOW confidence" alert with healthy patterns.
   *
   * What the zero case actually asks is how tight the ceiling is, so the width
   * is measured against the population instead.
   */
  describe("when nothing was found", () => {
    it("is confident when the ceiling is tight", () => {
      // 400 probes finding nothing bounds the rate under 1% of the population.
      const estimate = estimateStratified([
        { label: "all", population: 40_000, sampled: 400, hits: 0 }
      ]);

      expect(estimate.pointEstimate).toBe(0);
      expect(confidenceBandFor(estimate)).toBe("confident");
    });

    it("is not confident when the ceiling is loose", () => {
      // 30 probes finding nothing leaves an 11% ceiling.
      const estimate = estimateStratified([
        { label: "all", population: 40_000, sampled: 30, hits: 0 }
      ]);

      expect(confidenceBandFor(estimate)).not.toBe("confident");
    });

    it("is confident about a clean census", () => {
      const estimate = estimateStratified([
        { label: "all", population: 40, sampled: 40, hits: 0 }
      ]);

      expect(relativeIntervalWidth(estimate)).toBe(0);
      expect(confidenceBandFor(estimate)).toBe("confident");
    });
  });

  it("treats any census as confident", () => {
    const estimate = estimateStratified([
      { label: "all", population: 200, sampled: 200, hits: 37 }
    ]);

    expect(confidenceBandFor(estimate)).toBe("confident");
  });
});

describe("planExpansion", () => {
  describe("when not to expand", () => {
    it("leaves a precise estimate alone", () => {
      const plan = expansionFor([
        { label: "all", population: 40_000, sampled: 400, hits: 80 }
      ]);

      expect(plan.shouldExpand).toBe(false);
      expect(plan.reason).toBe("already_precise");
    });

    it("leaves a census alone", () => {
      const plan = expansionFor([
        { label: "all", population: 250, sampled: 250, hits: 9 }
      ]);

      expect(plan.shouldExpand).toBe(false);
      expect(plan.reason).toBe("already_precise");
    });

    /**
     * Zero hits is the cheap, useful signal this layer exists to deliver. With
     * a tight enough ceiling a clean pattern is FINISHED, not suspicious — the
     * legacy engine expands on any hit at all, which spends budget confirming
     * what is already known.
     */
    it("leaves a confidently clean pattern alone", () => {
      const plan = expansionFor([
        { label: "all", population: 40_000, sampled: 400, hits: 0 }
      ]);

      expect(plan.shouldExpand).toBe(false);
    });

    it("stops at the expanded ceiling", () => {
      const plan = expansionFor(
        [{ label: "all", population: 40_000_000, sampled: 1_200, hits: 3 }],
        BUDGET.maxExpanded
      );

      expect(plan.shouldExpand).toBe(false);
      expect(plan.reason).toBe("at_expansion_ceiling");
    });

    /**
     * The bound the legacy integration test caught the hard way: without it, a
     * 200-URL pattern gets "expanded" to 200/200. A triage that probes
     * everything is a full verification wearing the wrong label.
     */
    it("stops before triaging a whole small population", () => {
      const plan = expansionFor([
        { label: "all", population: 200, sampled: 50, hits: 1 }
      ]);

      expect(plan.additionalTotal).toBeLessThanOrEqual(
        Math.floor(200 * BUDGET.maxPopulationFraction) - 50
      );
    });
  });

  describe("when to expand", () => {
    /**
     * THE behavioural difference from the legacy trigger. Legacy expands when
     * an observed hit rate crosses 10%; this expands when the INTERVAL is too
     * wide to act on. A 2% rate measured across 30 probes is imprecise and
     * legacy leaves it alone.
     */
    it("expands a wide interval regardless of hit rate", () => {
      const plan = expansionFor([
        { label: "all", population: 40_000, sampled: 30, hits: 1 }
      ]);

      expect(plan.shouldExpand).toBe(true);
      expect(plan.reason).toBe("interval_too_wide");
      expect(plan.additionalTotal).toBeGreaterThan(0);
    });

    it("respects the expansion factor", () => {
      const plan = expansionFor([
        { label: "all", population: 40_000, sampled: 30, hits: 1 }
      ]);

      // At most (factor - 1) times what round one cost.
      expect(plan.additionalTotal).toBeLessThanOrEqual(
        30 * (BUDGET.maxExpansionFactor - 1)
      );
    });

    it("never exceeds the expanded ceiling in total", () => {
      const plan = expansionFor([
        { label: "all", population: 40_000_000, sampled: 400, hits: 4 }
      ]);

      expect(400 + plan.additionalTotal).toBeLessThanOrEqual(
        BUDGET.maxExpanded
      );
    });

    /**
     * An unsampled stratum contributes its ENTIRE population to the upper
     * bound, so it is where the most uncertainty is and the first place extra
     * probes should go.
     */
    it("prioritises strata nothing is known about", () => {
      const plan = expansionFor([
        { label: "seen", population: 30_000, sampled: 300, hits: 6 },
        { label: "unseen", population: 10_000, sampled: 0, hits: 0 }
      ]);

      expect(plan.shouldExpand).toBe(true);
      expect(plan.reason).toBe("unsampled_strata");
      expect(plan.strata.map((s) => s.label)).toEqual(["unseen"]);
    });

    it("targets the imprecise stratum, not the settled one", () => {
      const plan = expansionFor([
        { label: "settled", population: 30_000, sampled: 300, hits: 60 },
        { label: "thin", population: 10_000, sampled: 8, hits: 1 }
      ]);

      expect(plan.shouldExpand).toBe(true);
      expect(plan.strata.map((s) => s.label)).toContain("thin");
    });

    it("does not ask for more than a stratum contains", () => {
      const plan = expansionFor([
        { label: "tiny", population: 40, sampled: 30, hits: 1 }
      ]);

      expect(30 + plan.additionalTotal).toBeLessThanOrEqual(40);
    });
  });

  /**
   * The property that makes expansion worth doing at all: looking harder has to
   * actually narrow the interval, or the budget is being spent for nothing.
   */
  it("produces a narrower interval after expanding", () => {
    const before = estimateStratified([
      { label: "all", population: 40_000, sampled: 30, hits: 1 }
    ]);
    const plan = planExpansion(before, 30);

    expect(plan.shouldExpand).toBe(true);

    // Same underlying rate, more probes.
    const expandedSample = 30 + plan.additionalTotal;
    const after = estimateStratified([
      {
        label: "all",
        population: 40_000,
        sampled: expandedSample,
        hits: Math.round(expandedSample / 30)
      }
    ]);

    expect(after.ciHigh - after.ciLow).toBeLessThan(
      before.ciHigh - before.ciLow
    );
  });
});
