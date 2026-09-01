import { describe, expect, it } from "vitest";

import {
  type AccumulatedPattern,
  PatternAccumulator
} from "./pattern-accumulator.js";
import { parseLoc } from "./url-path.js";

const BASE = "https://example.test";
const CAPACITY = 1_200;

function accumulator(): PatternAccumulator {
  return new PatternAccumulator({ sampleCapacity: CAPACITY });
}

/** Feed URLs in as if they were one sitemap file. */
function feed(
  acc: PatternAccumulator,
  urls: readonly string[],
  fileId = 1
): void {
  urls.forEach((url, ordinal) => {
    const parsed = parseLoc(url, BASE, "example.test");

    if (parsed.kind === "matched") {
      acc.observe(parsed.segments, fileId, ordinal, url);
    }
  });
}

function templates(patterns: readonly AccumulatedPattern[]): readonly string[] {
  return patterns.map((p) => p.template);
}

function find(
  patterns: readonly AccumulatedPattern[],
  template: string
): AccumulatedPattern {
  const found = patterns.find((p) => p.template === template);

  if (!found) {
    throw new Error(
      `no pattern ${template}; got ${templates(patterns).join(", ")}`
    );
  }

  return found;
}

describe("PatternAccumulator", () => {
  it("collapses a high-cardinality position into {param}", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 500 }, (_, i) => `${BASE}/product/${i}`)
    );

    const { patterns } = acc.result();

    expect(templates(patterns)).toEqual(["/product/{param}"]);
    expect(patterns[0]?.populationCount).toBe(500);
  });

  it("leaves a low-cardinality position literal", () => {
    const acc = accumulator();

    // Three sections, many pages each: position 0 repeats, position 1 varies.
    for (const section of ["news", "blog", "docs"]) {
      feed(
        acc,
        Array.from({ length: 200 }, (_, i) => `${BASE}/${section}/${i}`)
      );
    }

    expect([...templates(acc.result().patterns)].sort()).toEqual([
      "/blog/{param}",
      "/docs/{param}",
      "/news/{param}"
    ]);
  });

  /**
   * The reason this implementation uses a trie instead of the legacy algorithm.
   *
   * Legacy keeps one counter per path position, shared by every URL on the
   * site. With enough distinct top-level sections, position 0 crosses the
   * 100-distinct threshold and every URL collapses to `/{param}/...` — one
   * giant pattern where there should be hundreds, while the run reports
   * success.
   *
   * Deciding per trie node decouples the shapes: three hundred `section-N`
   * siblings collapse because they are interchangeable, and `shop` keeps its
   * name because its subtree looks nothing like theirs. See ADR-0012.
   */
  it("does not let one path shape over-collapse another", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 300 }, (_, i) => `${BASE}/section-${i}/index`)
    );

    for (const category of ["tools", "parts"]) {
      feed(
        acc,
        Array.from({ length: 300 }, (_, i) => `${BASE}/shop/${category}/${i}`)
      );
    }

    const found = templates(acc.result().patterns);

    expect(found).toContain("/shop/tools/{param}");
    expect(found).toContain("/shop/parts/{param}");
    // The three-segment family kept its literal prefix.
    expect(found).not.toContain("/{param}/{param}/{param}");
  });

  it("records which files a pattern's URLs came from", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 40 }, (_, i) => `${BASE}/p/${i}`),
      7
    );
    feed(
      acc,
      Array.from({ length: 60 }, (_, i) => `${BASE}/p/${100 + i}`),
      9
    );

    const pattern = find(acc.result().patterns, "/p/{param}");

    expect(pattern.populationCount).toBe(100);
    expect([...pattern.perFileCounts.entries()].sort()).toEqual([
      [7, 40],
      [9, 60]
    ]);
  });

  it("caps retained candidates while still counting the whole population", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 5_000 }, (_, i) => `${BASE}/x/${i}`)
    );

    const pattern = find(acc.result().patterns, "/x/{param}");

    expect(pattern.populationCount).toBe(5_000);
    expect(pattern.sampleCandidates).toHaveLength(CAPACITY);

    // Every retained candidate sits at or below the recorded threshold — the
    // property that makes the superset guarantee checkable downstream.
    for (const candidate of pattern.sampleCandidates) {
      expect(candidate.hash).toBeLessThanOrEqual(pattern.sampleThreshold);
    }
  });

  it("emits counts, the file index, and candidates from the same pass", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 900 }, (_, i) => `${BASE}/a/${i}`),
      3
    );

    const pattern = find(acc.result().patterns, "/a/{param}");

    // The three things legacy needs three separate full scans to produce.
    expect(pattern.populationCount).toBe(900);
    expect(pattern.perFileCounts.get(3)).toBe(900);
    expect(pattern.sampleCandidates.length).toBeGreaterThan(0);
  });

  it("orders patterns by population, largest first", () => {
    const acc = accumulator();

    feed(
      acc,
      Array.from({ length: 60 }, (_, i) => `${BASE}/small/${i}`)
    );
    feed(
      acc,
      Array.from({ length: 900 }, (_, i) => `${BASE}/big/${i}`)
    );
    feed(
      acc,
      Array.from({ length: 300 }, (_, i) => `${BASE}/mid/${i}`)
    );

    expect(acc.result().patterns.map((p) => p.populationCount)).toEqual([
      900, 300, 60
    ]);
  });

  /**
   * A slot with only a handful of values is left literal rather than
   * parameterised, and that is the intended behaviour.
   *
   * The legacy engine parameterises after three observations, which is how
   * `/about`, `/contact` and `/terms` end up merged into a single `/{param}`
   * holding thousands of unrelated pages. Requiring thirty observations before
   * the ratio rule may fire — the same floor the sampling maths uses, because
   * below it a proportion says nothing — costs nothing real: a pattern this
   * small is verified exhaustively anyway, since the minimum sample already
   * exceeds its population.
   */
  it("leaves a slot with too few observations literal", () => {
    const acc = accumulator();

    feed(acc, [
      `${BASE}/about`,
      `${BASE}/contact`,
      `${BASE}/terms`,
      `${BASE}/privacy`
    ]);

    expect([...templates(acc.result().patterns)].sort()).toEqual([
      "/about",
      "/contact",
      "/privacy",
      "/terms"
    ]);
  });

  describe("rebuilding when a position flips late", () => {
    /**
     * Parameterization is discovered mid-stream, so templates built from a
     * literal value have to be rebuilt once that position turns variable.
     * Getting this wrong leaves the same pattern split across several template
     * strings, and every population count is then too small.
     */
    it("merges templates built before the flip", () => {
      const acc = accumulator();

      feed(
        acc,
        Array.from({ length: 400 }, (_, i) => `${BASE}/item/${i}`)
      );

      const { patterns } = acc.result();

      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.template).toBe("/item/{param}");
      // Nothing stranded under a pre-flip template.
      expect(patterns[0]?.populationCount).toBe(400);
    });

    /**
     * The strongest statement available about the rebuild: the answer does not
     * depend on when the flip happened. A stream ordered so the flip comes
     * early must produce exactly what one ordered so it comes late produces.
     */
    it("produces the same result regardless of when the flip occurs", () => {
      const urls = Array.from({ length: 600 }, (_, i) => `${BASE}/thing/${i}`);

      const forward = accumulator();
      const reversed = accumulator();

      feed(forward, urls);
      feed(reversed, [...urls].reverse());

      const a = find(forward.result().patterns, "/thing/{param}");
      const b = find(reversed.result().patterns, "/thing/{param}");

      expect(a.populationCount).toBe(b.populationCount);
      // Sample selection is by hash, so reversing the input must not change it
      // — except for the ordinals, which really are different positions.
      expect(a.sampleCandidates.map((c) => c.hash)).toEqual(
        b.sampleCandidates.map((c) => c.hash)
      );
    });
  });

  describe("merging partial passes", () => {
    /**
     * THE property the parallel parse and crash-resume both depend on: files
     * split across workers, then merged, must equal one sequential pass. If
     * this drifts, a resumed run silently reports different numbers from an
     * uninterrupted one.
     */
    it("equals a single pass over the same URLs", () => {
      const first = Array.from({ length: 700 }, (_, i) => `${BASE}/n/${i}`);
      const second = Array.from(
        { length: 700 },
        (_, i) => `${BASE}/n/${1_000 + i}`
      );

      const whole = accumulator();

      feed(whole, first, 1);
      feed(whole, second, 2);

      const partA = accumulator();
      const partB = accumulator();

      feed(partA, first, 1);
      feed(partB, second, 2);
      partA.merge(partB);

      const merged = find(partA.result().patterns, "/n/{param}");
      const single = find(whole.result().patterns, "/n/{param}");

      expect(merged.populationCount).toBe(single.populationCount);
      expect([...merged.perFileCounts.entries()].sort()).toEqual(
        [...single.perFileCounts.entries()].sort()
      );
      expect(merged.sampleCandidates).toEqual(single.sampleCandidates);
      expect(merged.sampleThreshold).toBe(single.sampleThreshold);
    });

    /**
     * A harder case: neither half sees enough URLs alone to parameterise, but
     * together they cross the threshold. The merged model has to re-evaluate
     * and rebuild, or the result is two literal patterns where one variable
     * pattern belongs.
     */
    /**
     * Neither half sees enough URLs on its own to call the slot variable, but
     * together they do. The merge has to re-decide and rebuild — otherwise two
     * workers' shares of one pattern stay under forty separate literal
     * templates.
     */
    it("re-parameterises on evidence only visible after merging", () => {
      const partA = accumulator();
      const partB = accumulator();

      feed(
        partA,
        Array.from({ length: 20 }, (_, i) => `${BASE}/z/a${i}`),
        1
      );
      feed(
        partB,
        Array.from({ length: 20 }, (_, i) => `${BASE}/z/b${i}`),
        2
      );

      // Twenty distinct values each: below the thirty-observation floor, so
      // each half alone correctly declines to parameterise.
      expect(templates(partA.result().patterns)).toHaveLength(20);

      partA.merge(partB);

      const { patterns } = partA.result();

      expect(templates(patterns)).toEqual(["/z/{param}"]);
      expect(patterns[0]?.populationCount).toBe(40);
    });

    it("keeps the total URL count across a merge", () => {
      const partA = accumulator();
      const partB = accumulator();

      feed(
        partA,
        Array.from({ length: 120 }, (_, i) => `${BASE}/q/${i}`),
        1
      );
      feed(
        partB,
        Array.from({ length: 80 }, (_, i) => `${BASE}/r/${i}`),
        2
      );
      partA.merge(partB);

      expect(partA.result().totalUrls).toBe(200);
    });
  });

  describe("memory accounting", () => {
    it("grows with patterns, not with URLs", () => {
      const fewUrls = accumulator();
      const manyUrls = accumulator();

      feed(
        fewUrls,
        Array.from({ length: 2_000 }, (_, i) => `${BASE}/m/${i}`)
      );
      feed(
        manyUrls,
        Array.from({ length: 60_000 }, (_, i) => `${BASE}/m/${i}`)
      );

      // Thirty times the URLs, same single pattern, so the retained state is
      // capped by the sample capacity rather than by the population.
      expect(manyUrls.estimatedBytes()).toBeLessThan(
        fewUrls.estimatedBytes() * 2
      );
    });
  });
});
