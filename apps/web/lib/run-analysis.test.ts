import { describe, expect, it } from "vitest";
import type { ObservationTally, PatternDepthCount, RunPoint } from "./api";
import {
  averageDepth,
  coverageFraction,
  depthBuckets,
  explorerFooter,
  formatCoverage,
  formatTrend,
  outcomeSlices,
  pageWindow,
  runStatusSlices,
  trendPercent
} from "./run-analysis";

const depth = (
  segmentCount: number,
  count: number,
  populationCount: number
): PatternDepthCount => ({ segmentCount, count, populationCount });

describe("depthBuckets", () => {
  it("keeps empty buckets so a gap in the distribution is visible", () => {
    /**
     * The query returns only depths that exist. Without the empty buckets, a
     * run with patterns at depths 1 and 4 draws two adjacent bars and implies
     * they are neighbours — the chart would show a shape the data does not
     * have.
     */
    const buckets = depthBuckets([depth(1, 2, 100), depth(4, 1, 50)]);

    expect(buckets.map((bucket) => bucket.label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6+"
    ]);
    expect(buckets[1]?.patterns).toBe(0);
    expect(buckets[2]?.patterns).toBe(0);
    expect(buckets[3]?.patterns).toBe(1);
  });

  it("folds everything at or beyond the cap into the final bucket", () => {
    const buckets = depthBuckets([
      depth(6, 1, 10),
      depth(7, 2, 20),
      depth(12, 3, 30)
    ]);
    const last = buckets.at(-1);

    expect(last?.label).toBe("6+");
    expect(last?.patterns).toBe(6);
    expect(last?.urls).toBe(60);
  });

  it("returns all-zero buckets for a run with no patterns", () => {
    const buckets = depthBuckets([]);

    expect(buckets).toHaveLength(6);
    expect(buckets.every((bucket) => bucket.patterns === 0)).toBe(true);
  });
});

describe("averageDepth", () => {
  it("weights by URLs, not by pattern count", () => {
    /**
     * One pattern holding four million URLs at depth 2 describes the site far
     * more than forty patterns holding one URL each at depth 6. An unweighted
     * mean says the opposite, which is the wrong answer stated confidently.
     */
    const weighted = averageDepth([depth(2, 1, 4_000_000), depth(6, 40, 40)]);

    expect(weighted).toBeCloseTo(2.00004, 4);
    expect(weighted).toBeLessThan(3);
  });

  it("is undefined when nothing was counted, rather than zero", () => {
    // Depth zero is a claim; "no patterns" is an absence. They must not render
    // the same.
    expect(averageDepth([])).toBeUndefined();
    expect(averageDepth([depth(3, 0, 0)])).toBeUndefined();
  });
});

describe("trendPercent", () => {
  it("computes a signed change against the previous run", () => {
    expect(trendPercent(1_020, 1_000)).toBeCloseTo(2, 5);
    expect(trendPercent(900, 1_000)).toBeCloseTo(-10, 5);
  });

  it("gives no trend for a first run", () => {
    expect(trendPercent(1_000, undefined)).toBeUndefined();
  });

  it("gives no trend when the previous run found nothing", () => {
    /*
     * Dividing by zero would render an infinite increase for a site that
     * simply had no data before. "No comparison" is the honest answer.
     */
    expect(trendPercent(1_000, 0)).toBeUndefined();
  });

  it("formats direction and magnitude, never a bare number", () => {
    expect(formatTrend(2.44)).toBe("↑2.4%");
    expect(formatTrend(-10)).toBe("↓10%");
    expect(formatTrend(0)).toBe("↑0%");
  });
});

describe("pageWindow", () => {
  it("describes the first page", () => {
    expect(pageWindow(0, 50, 98)).toEqual({
      from: 1,
      to: 50,
      hasPrevious: false,
      hasNext: true
    });
  });

  it("clamps the last page to the total", () => {
    expect(pageWindow(50, 50, 98)).toEqual({
      from: 51,
      to: 98,
      hasPrevious: true,
      hasNext: false
    });
  });

  it("reports zero rather than the 1-0 naive arithmetic gives", () => {
    expect(pageWindow(0, 50, 0)).toMatchObject({ from: 0, to: 0 });
  });
});

describe("explorerFooter", () => {
  it("says the rows are SAMPLED, not a window onto every URL", () => {
    /**
     * THE POINT OF THIS FUNCTION. The design reads "SHOWING 1-4 OF 145,892",
     * which describes a census. These rows are probes — one per URL the sampler
     * drew — and a footer phrased that way would present a sample as a complete
     * listing, which is the single claim this product must never make.
     */
    const footer = explorerFooter(pageWindow(0, 50, 98), 98);

    expect(footer).toContain("sampled URLs");
    expect(footer).toContain("1–50");
    expect(footer).toContain("98");
  });

  it("says nothing matched rather than showing an empty range", () => {
    expect(explorerFooter(pageWindow(0, 50, 0), 0)).toBe(
      "No sampled URLs match this filter."
    );
  });
});

describe("bar heights", () => {
  /**
   * The height rule lives in `BarChart`, but the property it protects is a
   * product one and is asserted here so it is not only a comment: a bucket
   * with nothing in it must draw nothing.
   *
   * The first version floored EVERY bar at 2%, which gave empty depth
   * buckets a visible hairline — the chart said there were patterns at
   * depths that had none. Caught by a screenshot, not by a test.
   */
  const height = (value: number, max: number): number =>
    value === 0 || max === 0 ? 0 : Math.max(2, Math.round((value / max) * 100));

  it("draws nothing for an empty bucket", () => {
    expect(height(0, 40)).toBe(0);
  });

  it("keeps a tiny non-zero bucket visible", () => {
    // One in nine million is not nothing, and must not render as nothing.
    expect(height(1, 9_000_000)).toBe(2);
  });

  it("fills the column for the largest bucket", () => {
    expect(height(40, 40)).toBe(100);
  });
});

describe("outcomeSlices", () => {
  const tally = (
    httpStatus: number | null,
    count: number,
    isSoft404 = false
  ): ObservationTally => ({ httpStatus, isSoft404, count });

  it("keeps a soft 404 separate from a real 200", () => {
    /**
     * THE DISTINCTION THE WHOLE ESCALATION EXISTS FOR. A 200 that says
     * "not found" is broken in the way that matters, and a ring folding it in
     * with real successes would report a site as fine while a fifth of its
     * sample was a soft 404.
     */
    const slices = outcomeSlices([tally(200, 80), tally(200, 17, true)]);

    expect(slices).toHaveLength(2);
    expect(slices.map((slice) => slice.label)).toContain("200");
    expect(slices.map((slice) => slice.label)).toContain("200 soft 404");
  });

  it("labels a missing status as no response, not as a server error", () => {
    // A timeout or refused connection means the server never answered, so
    // there is nothing to classify. Calling it 5xx reports a site defect
    // where there may be none.
    const [slice] = outcomeSlices([tally(null, 4)]);

    expect(slice?.label).toBe("no response");
    expect(slice?.httpStatus).toBeNull();
  });

  it("orders by volume so the largest outcome leads", () => {
    const slices = outcomeSlices([
      tally(500, 4),
      tally(200, 109),
      tally(404, 57)
    ]);

    expect(slices.map((slice) => slice.value)).toEqual([109, 57, 4]);
  });
});

describe("coverageFraction", () => {
  it("expresses requests as a share of the population", () => {
    expect(coverageFraction(373, 22_898)).toBeCloseTo(0.0163, 4);
  });

  it("is undefined when there is no population to cover", () => {
    /*
     * A run that discovered nothing has no coverage to express. Zero percent
     * would read as a failure to probe rather than as nothing to probe.
     */
    expect(coverageFraction(0, 0)).toBeUndefined();
  });
});

describe("formatCoverage", () => {
  it("keeps precision as the share gets smaller", () => {
    /**
     * "0.0%" for a large site audited with a few hundred requests would erase
     * exactly the achievement the figure exists to show — the whole product
     * argument is that this number is small.
     */
    expect(formatCoverage(0.0163)).toBe("1.6%");
    expect(formatCoverage(0.0004)).toBe("0.04%");
    expect(formatCoverage(0.0004)).not.toBe("0%");
  });

  it("rounds a large share, where a decimal adds nothing", () => {
    expect(formatCoverage(0.42)).toBe("42%");
  });
});

describe("sparkline geometry", () => {
  /**
   * The two divide-by-zero traps in `Sparkline`, asserted here because both
   * are ordinary cases rather than edge cases: a first run has one point, and
   * a site whose URL count has not changed has a flat series. A naive
   * `(value - min) / (max - min)` is 0/0 on every point of the second.
   */
  const y = (value: number, min: number, max: number, height = 32): number =>
    max - min === 0
      ? height / 2
      : height - ((value - min) / (max - min)) * height;

  it("centres a flat series instead of producing NaN", () => {
    expect(y(5_726, 5_726, 5_726)).toBe(16);
    expect(Number.isNaN(y(5_726, 5_726, 5_726))).toBe(false);
  });

  it("puts the largest value at the top and the smallest at the bottom", () => {
    expect(y(100, 0, 100)).toBe(0);
    expect(y(0, 0, 100)).toBe(32);
  });
});

describe("runStatusSlices", () => {
  const run = (status: RunPoint["status"], id: string): RunPoint => ({
    id,
    startedAt: "2026-09-05T00:00:00.000Z",
    totalUrls: 10,
    totalPatterns: 2,
    status
  });

  it("omits a status with no runs rather than reporting a zero", () => {
    /**
     * ZERO DRAWS NOTHING, one layer up from the charts. A slice list carrying
     * `{ failed: 0 }` would put "0 failed" in a legend — inviting the reader to
     * worry about a category that does not exist — even in a donut that
     * correctly declined to draw the arc.
     */
    const slices = runStatusSlices([
      run("complete", "a"),
      run("complete", "b")
    ]);

    expect(slices).toEqual([{ label: "complete", value: 2 }]);
    expect(slices.map((slice) => slice.label)).not.toContain("failed");
  });

  it("orders deterministically when two statuses tie", () => {
    // Otherwise a stable page appears to shuffle between renders.
    const first = runStatusSlices([run("failed", "a"), run("complete", "b")]);
    const second = runStatusSlices([run("complete", "b"), run("failed", "a")]);

    expect(first).toEqual(second);
    expect(first[0]?.label).toBe("complete");
  });

  it("returns nothing for a site with no runs", () => {
    expect(runStatusSlices([])).toEqual([]);
  });
});
