import { describe, expect, it } from "vitest";

import { FOOTER_ITEMS, NAV_ITEMS } from "./nav-rail";

/**
 * The rail says "Analyses", and every item points at a route that exists.
 *
 * TWO RULES, BOTH PREVIOUSLY LEARNED THE HARD WAY.
 *
 * The label first. Stitch calls this item "Crawls"; ADR-0027 kept the design's
 * word at the owner's direction and recorded the tension in a comment, and
 * ADR-0039 resolved it — this platform collapses a sitemap into patterns and
 * probes a statistical sample of each, and "crawl" is the one word that
 * describes the thing it deliberately does not do. A comment is not enforcement:
 * the rail is the most-read text in the app and the easiest place for crawler
 * language to drift back in during an unrelated restyle.
 *
 * Then the hrefs. `match` prefixes and item links have both been dormant 404s
 * before — Overview's `match` listed `/sites`, a page that does not exist —
 * which is the same class of latent lie the `SOON` marker exists to fix.
 */

/** Words that describe requesting every URL, which this product never does. */
const CRAWLER_WORDS = ["crawl", "crawls", "crawler", "crawled", "spider"];

describe("the navigation rail", () => {
  it("finds items to check, so a passing result is not vacuous", () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(3);
    expect(FOOTER_ITEMS.length).toBeGreaterThan(0);
  });

  it("names the run history Analyses, not Crawls", () => {
    const runs = NAV_ITEMS.find((item) => item.href === "/runs");

    expect(runs?.label).toBe("Analyses");
  });

  it("carries no crawler language in any label", () => {
    for (const item of [...NAV_ITEMS, ...FOOTER_ITEMS]) {
      const words = item.label.toLowerCase().split(/[^a-z]+/);

      for (const word of CRAWLER_WORDS) {
        expect(
          words,
          `the rail item "${item.label}" uses crawler language. This platform samples patterns rather than requesting every URL (ADR-0039); rename it rather than teaching the reader the wrong model.`
        ).not.toContain(word);
      }
    }
  });

  it("keeps Analyses and Analytics as separate, distinguishable items", () => {
    /**
     * The cost of the rename, asserted rather than hoped over. The two sit next
     * to each other and lead to different screens — a run's sampling passes,
     * and per-site estimator health. If one is ever dropped or repointed, this
     * fails rather than leaving two near-identical words both going nowhere in
     * particular.
     */
    const analyses = NAV_ITEMS.find((item) => item.label === "Analyses");
    const analytics = NAV_ITEMS.find((item) => item.label === "Analytics");

    expect(analyses?.href).toBe("/runs");
    expect(analytics?.href).toBe("/analytics");
  });

  it("never links an item at a route that does not exist", () => {
    /**
     * Every `href` and every `match` prefix must be a real page. An item with no
     * screen renders disabled with a marker instead — a rail item that
     * navigates nowhere is a worse lie than one that says plainly it is not
     * built.
     */
    const routed = [...NAV_ITEMS, ...FOOTER_ITEMS].filter(
      (item) => item.href !== undefined
    );

    for (const item of routed) {
      expect(item.href?.startsWith("/")).toBe(true);

      for (const prefix of item.match ?? []) {
        expect(
          prefix.startsWith("/"),
          `the match prefix "${prefix}" on "${item.label}" is not a route`
        ).toBe(true);
      }
    }
  });
});
