import { describe, expect, it } from "vitest";

import {
  ALL_TOOLS,
  countLaunchable,
  filterSections,
  TOOL_SECTIONS
} from "./tools-catalog";

/**
 * The guard that earns the catalogue its place as data.
 *
 * The Stitch Tools screen draws nine utility cards, all of them "Operational".
 * Seven of those cannot exist in this product — a live URL fetch, a robots.txt
 * test, a headless render diff — and the failure mode a nine-card grid invites
 * is the one that has recurred through every milestone since M7: a label that
 * asserts a guarantee the code does not make (CODING_STANDARDS section 1.9).
 *
 * So the rule is structural rather than a review habit. A card that cannot be
 * launched must name the missing capability in words, and a card that CAN be
 * launched must point at a route. The pair is what stops the grid drifting in
 * either direction — a tool going dark without explanation, or an aspirational
 * card quietly acquiring a link to a page that does not exist.
 */

/** Every route the catalogue is allowed to launch into. */
const ROUTES_THAT_EXIST = ["/tools", "/settings"];

describe("the tool catalogue", () => {
  it("matches the design's three sections of three cards", () => {
    expect(TOOL_SECTIONS).toHaveLength(3);

    for (const section of TOOL_SECTIONS) {
      expect(section.tools).toHaveLength(3);
    }
  });

  it("gives every tool a unique id", () => {
    const ids = ALL_TOOLS.map((tool) => tool.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * THE LOAD-BEARING ONE. Confirmed by deleting `unavailableReason` from the
   * live URL inspector: this fails and names it, where nothing else in the
   * suite notices — the card still renders, still says "Unavailable", and
   * simply stops saying why.
   */
  it("makes every unavailable tool state the missing capability", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.availability !== "unavailable") {
        continue;
      }

      expect(
        tool.unavailableReason,
        `${tool.id} is unavailable and does not say why. A dark card with no reason is five broken rail links rebuilt at card scale (ADR-0028).`
      ).toBeDefined();

      // Long enough to be an explanation rather than a shrug.
      expect(tool.unavailableReason?.length ?? 0).toBeGreaterThan(40);
      expect(tool.href).toBeUndefined();
    }
  });

  it("points every launchable tool at a route that exists", () => {
    for (const tool of ALL_TOOLS) {
      if (tool.availability === "unavailable") {
        continue;
      }

      expect(tool.href, `${tool.id} is launchable with no href`).toBeDefined();
      expect(
        ROUTES_THAT_EXIST.some((route) => tool.href?.startsWith(route)),
        `${tool.id} launches into ${tool.href}, which is not one of this app's routes — DESIGN.md section 9 bans a control that navigates somewhere that 404s.`
      ).toBe(true);
      expect(tool.unavailableReason).toBeUndefined();
    }
  });

  /**
   * The header's meta row prints this figure. It must count what a reader can
   * actually run, not the size of the grid — "9 Utilities Available" over a
   * screen with two is exactly the claim this test exists to prevent.
   */
  it("counts only the tools a reader can launch", () => {
    expect(countLaunchable()).toBe(
      ALL_TOOLS.filter((tool) => tool.availability !== "unavailable").length
    );
    expect(countLaunchable()).toBeLessThan(ALL_TOOLS.length);
  });

  it("keeps the platform's central refusal in the catalogue", () => {
    const inspector = ALL_TOOLS.find((tool) => tool.id === "url-inspector");

    expect(inspector?.availability).toBe("unavailable");
    expect(inspector?.unavailableReason).toMatch(/outbound HTTP/i);
  });
});

describe("filterSections", () => {
  it("returns every section when unfiltered", () => {
    expect(filterSections(undefined, undefined)).toHaveLength(
      TOOL_SECTIONS.length
    );
    expect(filterSections("all", "")).toHaveLength(TOOL_SECTIONS.length);
  });

  it("narrows to one category", () => {
    const filtered = filterSections("live", undefined);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("live");
  });

  it("searches names, descriptions and tags", () => {
    expect(filterSections("all", "wilson")).toHaveLength(1);
    expect(filterSections("all", "robots")).toHaveLength(1);

    const byTag = filterSections("all", "prefix trie");

    expect(byTag[0]?.tools.map((tool) => tool.id)).toEqual(["extractor"]);
  });

  it("drops a section that loses every tool rather than rendering it empty", () => {
    for (const section of filterSections("all", "wilson")) {
      expect(section.tools.length).toBeGreaterThan(0);
    }
  });

  it("returns nothing for a term that matches nothing", () => {
    expect(filterSections("all", "zzzz-no-such-tool")).toHaveLength(0);
  });
});
