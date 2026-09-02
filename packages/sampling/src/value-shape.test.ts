import { describe, expect, it } from "vitest";

import { groupByShape, pathShape, valueShape } from "./value-shape.js";

describe("valueShape", () => {
  it("collapses letter runs to a single a", () => {
    expect(valueShape("product")).toBe("a");
    expect(valueShape("PRODUCT")).toBe("a");
  });

  /**
   * Digit run LENGTH is preserved where letter run length is not, and the
   * asymmetry is the whole point: length is what separates one id generation
   * from another, and those are frequently different CMS templates where one
   * migrated and the other did not.
   */
  it("preserves digit run length", () => {
    expect(valueShape("12191")).toBe("99999");
    expect(valueShape("6492")).toBe("9999");
    expect(valueShape("12191")).not.toBe(valueShape("6492"));
  });

  it("keeps separators verbatim", () => {
    expect(valueShape("/nsn/niin-parts-12191")).toBe("/a/a-a-99999");
    // A different separator usually means a different generator.
    expect(valueShape("/nsn/niin_parts_12191")).toBe("/a/a_a_99999");
  });

  /**
   * The cap bounds the histogram on pathological ids. Without it a site with
   * 40-digit identifiers would produce a distinct stratum per length.
   */
  it("caps very long digit runs", () => {
    expect(valueShape("1".repeat(12))).toBe("9".repeat(12));
    expect(valueShape("1".repeat(40))).toBe("9".repeat(12));
    expect(valueShape("1".repeat(40))).toBe(valueShape("1".repeat(99)));
  });

  it("handles mixed runs", () => {
    expect(valueShape("abc123def")).toBe("a999a");
    expect(valueShape("2026-09-02")).toBe("9999-99-99");
  });

  it("returns an empty shape for an empty value", () => {
    expect(valueShape("")).toBe("");
  });
});

describe("pathShape", () => {
  it("shapes a path", () => {
    expect(pathShape("/product/12345")).toBe("/a/99999");
  });

  /**
   * The query is excluded, matching how patterns are derived from path segments
   * alone. Including it would explode one paginated shape into one per page.
   */
  it("ignores the query string", () => {
    expect(pathShape("/search?q=widget&page=3")).toBe("/a");
    expect(pathShape("/search?q=other")).toBe(pathShape("/search?q=widget"));
  });
});

describe("groupByShape", () => {
  /**
   * The real case from the legacy engine's own notes: one pattern holding
   * several id generations, where a sample of each shape answers for that
   * shape. This is what makes a small broken family visible instead of averaged
   * away — the reason the estimator takes strata at all.
   */
  it("separates id generations within one pattern", () => {
    const counts = groupByShape([
      "/nsn/niin-parts-12191",
      "/nsn/niin-parts-12192",
      "/nsn/niin-parts-12193",
      "/nsn/niin-parts-6492",
      "/nsn/part-types-88"
    ]);

    expect(counts.get("/a/a-a-99999")).toBe(3);
    expect(counts.get("/a/a-a-9999")).toBe(1);
    expect(counts.get("/a/a-a-99")).toBe(1);
  });

  it("orders by size, largest first", () => {
    const counts = groupByShape(["/a/1", "/a/22", "/a/33", "/a/44"]);

    expect([...counts.keys()][0]).toBe("/a/99");
  });

  it("breaks ties deterministically", () => {
    const first = groupByShape(["/a/1", "/bb/2"]);
    const second = groupByShape(["/bb/2", "/a/1"]);

    expect([...first.keys()]).toEqual([...second.keys()]);
  });

  it("handles an empty input", () => {
    expect(groupByShape([]).size).toBe(0);
  });
});
