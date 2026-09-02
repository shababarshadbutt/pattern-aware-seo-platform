import { describe, expect, it } from "vitest";

import {
  InvalidProportionError,
  wilsonInterval,
  zForConfidenceLevel
} from "./wilson.js";

/**
 * Hand-computed expectations throughout.
 *
 * The whole risk in this package is code that looks right and is subtly wrong,
 * so nothing here is checked against another part of the implementation. Where
 * a number appears, the arithmetic that produced it is in the comment above it.
 */
describe("wilsonInterval", () => {
  describe("the defect this replaces", () => {
    /**
     * THE test. Phase 0 found the legacy estimator computes
     * `1.96 * sqrt(variance)`, and with zero observed hits the variance is
     * zero — so the interval collapses to [0, 0] and the product asserts that a
     * 40,000-URL pattern definitely has no errors, on thirty probes.
     *
     * Wilson at zero hits gives [0, z²/(n + z²)]. For n = 30, z = 1.959964:
     *   z²          = 3.8414588
     *   uncorrected = 3.8414588 / (30 + 3.8414588) = 0.1135310
     * then the finite-population correction against N = 40,000:
     *   shrink      = sqrt(1 - 30/40000) = 0.9996249
     *   upper       = 0.1135310 * 0.9996249 = 0.1134884
     * which is about 4,539 URLs — the honest statement being "we saw none, and
     * there are at most this many".
     */
    it("returns a non-zero upper bound for zero hits in a partial sample", () => {
      const estimate = wilsonInterval(0, 30, { population: 40_000 });

      expect(estimate.point).toBe(0);
      expect(estimate.low).toBe(0);
      expect(estimate.high).toBeCloseTo(0.11352, 4);

      // What the interface would print, and what the legacy engine reports as 0.
      expect(Math.round(estimate.high * 40_000)).toBe(4539);
    });

    /** The bound has to tighten as evidence accumulates, or it says nothing. */
    it("tightens the zero-hit ceiling as the sample grows", () => {
      const widths = [30, 100, 400, 1_200].map(
        (n) => wilsonInterval(0, n, { population: 40_000 }).high
      );

      for (let index = 1; index < widths.length; index += 1) {
        expect(widths[index]).toBeLessThan(widths[index - 1] ?? 1);
      }

      // 400 probes finding nothing bounds the error rate under 1%.
      expect(widths[2]).toBeLessThan(0.01);
    });

    /**
     * ...but a census SHOULD collapse. Zero errors found in all 40 of 40 is not
     * an estimate, it is a count, and claiming uncertainty about it would be as
     * wrong as the legacy engine claiming certainty about a sample.
     */
    it("collapses to an exact value when the sample is the population", () => {
      const estimate = wilsonInterval(0, 40, { population: 40 });

      expect(estimate.point).toBe(0);
      expect(estimate.low).toBe(0);
      expect(estimate.high).toBe(0);
    });

    it("collapses onto the observed rate for any census", () => {
      const estimate = wilsonInterval(7, 40, { population: 40 });

      expect(estimate.point).toBeCloseTo(0.175, 10);
      expect(estimate.low).toBeCloseTo(0.175, 10);
      expect(estimate.high).toBeCloseTo(0.175, 10);
    });
  });

  describe("known values", () => {
    /**
     * The review's own worked example: one error in twenty probes.
     *
     * p̂ = 0.05, n = 20, z = 1.959964, z² = 3.841459
     *   z²/n       = 0.192073
     *   denominator = 1.192073
     *   centre     = (0.05 + 0.096036) / 1.192073 = 0.122506
     *   halfWidth  = (1.959964 / 1.192073) * sqrt(0.05*0.95/20 + 3.841459/1600)
     * Published Wilson bounds for 1/20 at 95% are [0.0089, 0.2361].
     */
    it("matches published bounds for 1 hit in 20", () => {
      const estimate = wilsonInterval(1, 20);

      expect(estimate.point).toBe(0.05);
      expect(estimate.low).toBeCloseTo(0.00891, 4);
      expect(estimate.high).toBeCloseTo(0.23611, 4);
    });

    /** Published Wilson bounds for 5/50 at 95% are [0.0435, 0.2154]. */
    it("matches published bounds for 5 hits in 50", () => {
      const estimate = wilsonInterval(5, 50);

      expect(estimate.low).toBeCloseTo(0.04348, 4);
      expect(estimate.high).toBeCloseTo(0.21358, 4);
    });

    /** Symmetric case: 10/20 should straddle 0.5. Published [0.2993, 0.7007]. */
    it("is symmetric at one half", () => {
      const estimate = wilsonInterval(10, 20);

      expect(estimate.point).toBe(0.5);
      expect(estimate.low).toBeCloseTo(0.2993, 4);
      expect(estimate.high).toBeCloseTo(0.7007, 4);
      expect(estimate.low + estimate.high).toBeCloseTo(1, 10);
    });

    /**
     * The other end of the range the review calls out. All twenty came back
     * bad: the lower bound must be well under 1, not pinned at it.
     */
    it("does not degenerate at a proportion of one either", () => {
      const estimate = wilsonInterval(20, 20);

      expect(estimate.point).toBe(1);
      expect(estimate.high).toBe(1);
      expect(estimate.low).toBeCloseTo(0.83887, 4);
    });
  });

  describe("the finite-population correction", () => {
    it("barely moves the interval when the sample is a tiny fraction", () => {
      const corrected = wilsonInterval(4, 400, { population: 40_000_000 });
      const uncorrected = wilsonInterval(4, 400);

      expect(corrected.low).toBeCloseTo(uncorrected.low, 5);
      expect(corrected.high).toBeCloseTo(uncorrected.high, 5);
    });

    /**
     * Sampling 30 of 200 is a very different statement from 30 of 40 million,
     * which the legacy review noted the engine treated as equally informative.
     * Half the population sampled should visibly narrow the interval.
     */
    it("narrows the interval as the sample covers more of the population", () => {
      const wide = wilsonInterval(3, 100, { population: 1_000_000 });
      const narrow = wilsonInterval(3, 100, { population: 200 });

      expect(narrow.high - narrow.low).toBeLessThan(wide.high - wide.low);
    });

    /**
     * Exact arithmetic, since this is the part ADR-0001 specifies precisely:
     * each bound's distance from p̂ shrinks by sqrt(1 - n/N).
     *   uncorrected for 3/100 -> [0.010256, 0.084232] around p̂ = 0.03
     *   n/N = 100/400 -> shrink = sqrt(0.75) = 0.8660254
     *   low  = 0.03 - (0.03 - 0.010256) * 0.8660254
     *   high = 0.03 + (0.084232 - 0.03) * 0.8660254
     */
    it("shrinks each bound's distance from the observed rate", () => {
      const base = wilsonInterval(3, 100);
      const corrected = wilsonInterval(3, 100, { population: 400 });
      const shrink = Math.sqrt(1 - 100 / 400);

      expect(corrected.low).toBeCloseTo(0.03 - (0.03 - base.low) * shrink, 10);
      expect(corrected.high).toBeCloseTo(
        0.03 + (base.high - 0.03) * shrink,
        10
      );
    });

    it("rejects a population smaller than the sample", () => {
      expect(() => wilsonInterval(1, 100, { population: 50 })).toThrow(
        InvalidProportionError
      );
    });
  });

  describe("invariants", () => {
    it("always contains the observed proportion", () => {
      for (const sampled of [1, 5, 30, 100, 400, 1_200]) {
        for (let hits = 0; hits <= sampled; hits += Math.max(1, sampled / 7)) {
          const rounded = Math.min(sampled, Math.round(hits));
          const estimate = wilsonInterval(rounded, sampled, {
            population: sampled * 100
          });

          expect(estimate.low).toBeLessThanOrEqual(estimate.point);
          expect(estimate.point).toBeLessThanOrEqual(estimate.high);
        }
      }
    });

    it("stays inside [0, 1]", () => {
      for (const [hits, sampled] of [
        [0, 1],
        [1, 1],
        [0, 3],
        [3, 3],
        [1, 1_200],
        [1_199, 1_200]
      ] as const) {
        const estimate = wilsonInterval(hits, sampled);

        expect(estimate.low).toBeGreaterThanOrEqual(0);
        expect(estimate.high).toBeLessThanOrEqual(1);
      }
    });

    it("narrows monotonically as the sample grows at a fixed rate", () => {
      let previous = Number.POSITIVE_INFINITY;

      for (const sampled of [20, 50, 100, 400, 1_000]) {
        const estimate = wilsonInterval(Math.round(sampled * 0.1), sampled);
        const width = estimate.high - estimate.low;

        expect(width).toBeLessThan(previous);
        previous = width;
      }
    });

    it("widens as the confidence level rises", () => {
      const ninety = wilsonInterval(5, 100, { confidenceLevel: 0.9 });
      const ninetyFive = wilsonInterval(5, 100, { confidenceLevel: 0.95 });
      const ninetyNine = wilsonInterval(5, 100, { confidenceLevel: 0.99 });

      expect(ninetyFive.high - ninetyFive.low).toBeGreaterThan(
        ninety.high - ninety.low
      );
      expect(ninetyNine.high - ninetyNine.low).toBeGreaterThan(
        ninetyFive.high - ninetyFive.low
      );
    });
  });

  describe("edge cases", () => {
    /**
     * Nothing probed means nothing known. Returning a narrower interval here
     * would be inventing information — the same class of error as [0, 0].
     */
    it("reports total ignorance for an empty sample", () => {
      const estimate = wilsonInterval(0, 0);

      expect(estimate.low).toBe(0);
      expect(estimate.high).toBe(1);
    });

    it("rejects more hits than trials", () => {
      expect(() => wilsonInterval(5, 3)).toThrow(InvalidProportionError);
    });

    it("rejects negative and non-finite inputs", () => {
      expect(() => wilsonInterval(-1, 10)).toThrow(InvalidProportionError);
      expect(() => wilsonInterval(1, Number.NaN)).toThrow(
        InvalidProportionError
      );
    });
  });

  describe("zForConfidenceLevel", () => {
    it("returns the standard two-sided values", () => {
      expect(zForConfidenceLevel(0.9)).toBeCloseTo(1.6449, 4);
      expect(zForConfidenceLevel(0.95)).toBeCloseTo(1.96, 4);
      expect(zForConfidenceLevel(0.99)).toBeCloseTo(2.5758, 4);
    });

    // Silently substituting 1.96 for an unsupported level would publish an
    // interval labelled with a confidence it does not have.
    it("refuses an unsupported level rather than guessing", () => {
      expect(() => zForConfidenceLevel(0.975)).toThrow(InvalidProportionError);
    });
  });
});
