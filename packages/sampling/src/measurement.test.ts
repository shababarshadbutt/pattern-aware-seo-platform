import { describe, expect, it } from "vitest";

import { ESTIMATOR_VERSION } from "./estimator-version.js";
import { measureProportion, planExpansionFor } from "./measurement.js";

/**
 * The COMPOSITION, not the arithmetic.
 *
 * `wilson.test.ts` and `stratified-estimate.test.ts` already validate the
 * interval against published reference values. What is untested until here is
 * the order the three steps go in and the rule that turns them into an evidence
 * tier — which is exactly what the pipeline and the sample-plan tool now share,
 * and therefore exactly what would drift if it were duplicated.
 */

describe("measureProportion", () => {
  it("reports a zero-hit sample as a bounded absence, never as certainty", () => {
    /**
     * THE DEFECT THIS PRODUCT EXISTS TO REFUTE. Thirty probes found nothing in
     * a population of three thousand. The legacy engine reported [0, 0] — a
     * claim of certainty from a 1% sample. The honest answer is a point
     * estimate of zero with an upper bound well above it, and a band saying the
     * remainder is unaccounted for.
     */
    const measurement = measureProportion([
      { label: "all", population: 3_000, sampled: 30, hits: 0 }
    ]);

    expect(measurement.pointEstimate).toBe(0);
    expect(measurement.ciLow).toBe(0);
    expect(measurement.ciHigh).toBeGreaterThan(0);
    expect(measurement.evidenceTier).toBe("estimated");
    expect(measurement.confidenceBand).toBe("low");
  });

  it("calls the same zero-hit sample confident when the sample is large enough", () => {
    /**
     * Same zero hits, different band — which is the whole reason the zero-hit
     * threshold pair exists (ADR-0013). Measuring width against the point
     * estimate is meaningless at zero, so the zero-hit cuts measure it against
     * the population: 400 probes leave a ceiling near 0.9%, 30 leave 11.3%.
     */
    const measurement = measureProportion([
      { label: "all", population: 40_000, sampled: 400, hits: 0 }
    ]);

    expect(measurement.pointEstimate).toBe(0);
    expect(measurement.ciHigh).toBeGreaterThan(0);
    expect(measurement.confidenceBand).toBe("confident");
  });

  it("collapses onto the observation when the sample IS the population", () => {
    /**
     * A census. The finite-population correction shrinks toward the observed
     * proportion, so at n = N there is nothing left to be uncertain about and
     * the tier flips to `counted`. The `audit_snapshot` CHECK constraint
     * enforces the same rule, which is why the tier rule belongs in the shared
     * composition rather than at each call site.
     */
    const measurement = measureProportion([
      { label: "all", population: 40, sampled: 40, hits: 6 }
    ]);

    expect(measurement.evidenceTier).toBe("counted");
    expect(measurement.pointEstimate).toBe(6);
    expect(measurement.ciLow).toBe(6);
    expect(measurement.ciHigh).toBe(6);
    expect(measurement.confidenceBand).toBe("confident");
  });

  it("extrapolates an ordinary sample and keeps the point inside its interval", () => {
    const measurement = measureProportion([
      { label: "all", population: 90_000_000, sampled: 400, hits: 60 }
    ]);

    // 60/400 = 15% of ninety million.
    expect(measurement.pointEstimate).toBe(13_500_000);
    expect(measurement.evidenceTier).toBe("estimated");
    expect(measurement.observedCount).toBe(60);
    expect(measurement.sampleSize).toBe(400);
    expect(measurement.populationCount).toBe(90_000_000);

    // The invariant the database also enforces.
    expect(measurement.ciLow).toBeLessThan(measurement.pointEstimate);
    expect(measurement.ciHigh).toBeGreaterThan(measurement.pointEstimate);
  });

  it("stamps every measurement with the estimator version", () => {
    // Written to `audit_snapshot.estimator_version` on every published claim,
    // so a number can be traced to the code that produced it.
    expect(
      measureProportion([
        { label: "all", population: 100, sampled: 10, hits: 1 }
      ]).estimatorVersion
    ).toBe(ESTIMATOR_VERSION);
  });
});

describe("planExpansionFor", () => {
  it("agrees with the band on a sample that is too wide to act on", () => {
    /**
     * THE REGRESSION. `planExpansion` takes a `StratifiedEstimate`; a caller
     * holding only a `Measurement` had to build one, and the empty `strata` it
     * was forced to invent turned the answer inside out — `already_precise`
     * for a sample whose own band was `low`. The screen printed "a second round
     * would not change the answer materially" directly under an interval
     * covering 11% of the population.
     *
     * Nothing failed: the types were satisfied and the suite was green. So the
     * assertion that matters is not that the number is right, it is that the
     * two answers CANNOT disagree — a `low` band and "already precise" are a
     * contradiction on the same screen no matter which one is correct.
     */
    const observations = [
      { label: "all", population: 3_000, sampled: 30, hits: 0 }
    ];

    expect(measureProportion(observations).confidenceBand).toBe("low");

    const plan = planExpansionFor(observations, 30);

    expect(plan.shouldExpand).toBe(true);
    expect(plan.reason).toBe("interval_too_wide");
    expect(plan.additionalTotal).toBeGreaterThan(0);
  });

  it("declines to expand a sample that is already precise enough", () => {
    // The other half, so the test above is not just asserting "always expand".
    const observations = [
      { label: "all", population: 40_000, sampled: 400, hits: 0 }
    ];

    expect(measureProportion(observations).confidenceBand).toBe("confident");
    expect(planExpansionFor(observations, 400).shouldExpand).toBe(false);
  });
});
