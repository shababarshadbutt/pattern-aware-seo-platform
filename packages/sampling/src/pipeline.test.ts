import { describe, expect, it } from "vitest";

import { BoundedHashSample } from "./bounded-hash-sample.js";
import { confidenceBandFor } from "./confidence-band.js";
import { planExpansion } from "./expansion.js";
import { planFirstRound } from "./sample-plan.js";
import { stableHash } from "./stable-hash.js";
import { estimateStratified } from "./stratified-estimate.js";
import { groupByShape } from "./value-shape.js";

/**
 * The pieces working together, on the action plan's own worked example.
 *
 * Each module is tested against hand-computed values in isolation; this checks
 * that the composition tells a coherent story, because the failure mode this
 * package has to avoid is not a wrong formula — it is a plausible-looking
 * number nobody can trace back to evidence.
 */
describe("the sampling pipeline end to end", () => {
  /**
   * A 90-million-URL site with a 15% error rate on its dominant pattern: the
   * "13.8M URLs estimated affected" claim the observability requirements say
   * has to stay defensible.
   */
  it("produces a defensible claim about a 90M-URL pattern", () => {
    const population = 90_000_000;

    const plan = planFirstRound([{ label: "all", population }]);

    // 1% of 90M would be 900,000 requests, so the ceiling binds — that is the
    // entire premise of the product.
    expect(plan.sampleTotal).toBe(400);
    expect(plan.effectiveRate).toBeLessThan(0.0001);

    // 60 of 400 probes came back 404 — a 15% observed rate.
    const estimate = estimateStratified([
      { label: "all", population, sampled: 400, hits: 60 }
    ]);

    expect(estimate.pointEstimate).toBe(13_500_000);

    // The interval is what makes the claim honest rather than a bare number.
    // Wilson for 60/400 is [0.11835, 0.18831], so against 90M:
    expect(estimate.ciLow).toBeCloseTo(10_651_000, -4);
    expect(estimate.ciHigh).toBeCloseTo(16_948_000, -4);
    expect(estimate.ciLow).toBeLessThan(estimate.pointEstimate);
    expect(estimate.pointEstimate).toBeLessThan(estimate.ciHigh);

    /**
     * APPROXIMATE, not confident — and that is the honest answer, worth
     * knowing about the product rather than tuning away.
     *
     * The interval spans about 47% of the estimate, because 400 probes is what
     * the first-round cost ceiling allows. Reaching `confident` on a 15% rate
     * would take roughly 1,900 probes, so a mid-range error rate on a huge
     * pattern will never be better than approximate under the default budget.
     *
     * That is fine for what the number is for. "Somewhere around 13.5 million,
     * likely between 10.7 and 16.9 million" is entirely sufficient to rank this
     * pattern first for attention, which is the decision it feeds. Precision
     * beyond that would cost 1,500 more requests at somebody else's origin to
     * change nothing.
     */
    expect(confidenceBandFor(estimate)).toBe("approximate");

    // And no expansion: approximate is not `low`, so the estimate is already
    // good enough to act on and more probes would buy nothing.
    expect(planExpansion(estimate, 400).shouldExpand).toBe(false);
    expect(planExpansion(estimate, 400).reason).toBe("already_precise");
  });

  /**
   * The case stratification exists for, and the one a flat sample gets badly
   * wrong: a small broken family salted through a large healthy one.
   */
  it("finds a small broken family a flat sample would average away", () => {
    const urls = [
      // 9,000 healthy URLs of one shape...
      ...Array.from({ length: 90 }, (_, i) => `/nsn/niin-parts-${10_000 + i}`),
      // ...and 200 of a shorter id generation that 404s wholesale.
      ...Array.from({ length: 10 }, (_, i) => `/nsn/part-types-${i}`)
    ];

    const shapes = groupByShape(urls);

    expect(shapes.size).toBe(2);

    // Population per shape is COUNTED during ingestion, not estimated from the
    // sample — post-stratifying with sample-derived weights would collapse back
    // to the unstratified answer and buy nothing.
    const stratified = estimateStratified([
      { label: "/a/a-a-99999", population: 9_000, sampled: 90, hits: 0 },
      { label: "/a/a-a-9", population: 200, sampled: 10, hits: 10 }
    ]);

    const flat = estimateStratified([
      { label: "all", population: 9_200, sampled: 100, hits: 10 }
    ]);

    // The stratified answer is the right one: the 200 broken URLs, not 920.
    expect(stratified.pointEstimate).toBe(200);
    expect(flat.pointEstimate).toBe(920);
  });

  /**
   * The full loop: draw, estimate, decide, expand, re-estimate. The property
   * that matters is that the second round is a SUPERSET of the first, so the
   * two rounds can never disagree about the same URL.
   */
  it("expands into a superset and comes back tighter", () => {
    const population = 40_000;
    const urls = Array.from(
      { length: population },
      (_, index) => `/part/${100_000 + index}`
    );

    // Collect at the expanded ceiling, as ingestion does, so the expansion is
    // served from memory rather than by re-reading the sitemap.
    const collected = new BoundedHashSample(1_200);

    for (const [ordinal, url] of urls.entries()) {
      collected.offer(stableHash(url), 1, ordinal);
    }

    const candidates = collected.toSortedArray();

    // Round one: 30 probes, one hit. Thin evidence.
    const firstRound = candidates.slice(0, 30);
    const before = estimateStratified([
      { label: "all", population, sampled: firstRound.length, hits: 1 }
    ]);

    expect(confidenceBandFor(before)).toBe("low");

    const expansion = planExpansion(before, firstRound.length);

    expect(expansion.shouldExpand).toBe(true);
    expect(expansion.reason).toBe("interval_too_wide");

    // Round two is a prefix of the same hash ordering, so it contains round one.
    const secondRound = candidates.slice(
      0,
      firstRound.length + expansion.additionalTotal
    );

    expect(secondRound.slice(0, firstRound.length)).toEqual(firstRound);

    const after = estimateStratified([
      {
        label: "all",
        population,
        sampled: secondRound.length,
        hits: Math.round(secondRound.length / 30)
      }
    ]);

    expect(after.ciHigh - after.ciLow).toBeLessThan(
      before.ciHigh - before.ciLow
    );
  });

  /**
   * A pattern small enough to verify exhaustively should be COUNTED, and the
   * whole uncertainty apparatus should get out of the way.
   */
  it("counts a small pattern instead of estimating it", () => {
    const plan = planFirstRound([{ label: "all", population: 25 }]);

    // The floor exceeds the population, so everything gets probed.
    expect(plan.sampleTotal).toBe(25);

    const estimate = estimateStratified([
      { label: "all", population: 25, sampled: 25, hits: 4 }
    ]);

    expect(estimate.isCounted).toBe(true);
    expect(estimate.pointEstimate).toBe(4);
    expect(estimate.ciLow).toBe(4);
    expect(estimate.ciHigh).toBe(4);
    expect(confidenceBandFor(estimate)).toBe("confident");
    expect(planExpansion(estimate, 25).shouldExpand).toBe(false);
  });

  /**
   * Everything the evidence page needs to justify a published number, from one
   * estimate object. If a client challenges the claim, this is the answer.
   */
  it("carries its own provenance", () => {
    const estimate = estimateStratified([
      { label: "/a/99999", population: 30_000, sampled: 300, hits: 30 },
      { label: "/a/9999", population: 10_000, sampled: 100, hits: 1 }
    ]);

    expect(estimate.populationCount).toBe(40_000);
    expect(estimate.sampleSize).toBe(400);
    expect(estimate.observedCount).toBe(31);
    expect(estimate.confidenceLevel).toBe(0.95);
    expect(estimate.strata).toHaveLength(2);
    expect(estimate.unsampledStrata).toEqual([]);

    for (const stratum of estimate.strata) {
      expect(stratum.low).toBeLessThanOrEqual(stratum.estimatedUrls);
      expect(stratum.estimatedUrls).toBeLessThanOrEqual(stratum.high);
    }
  });
});
