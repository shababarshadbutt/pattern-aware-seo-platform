import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BarChart } from "./bar-chart";

/**
 * Two rules this chart has to hold, both found by looking at a rendered page
 * rather than by reading the code.
 *
 * ZERO DRAWS NOTHING (D3d): the 2% floor keeps "one in nine million" visible
 * and must never apply to a zero, which would report patterns at depths that
 * had none.
 *
 * A FLAT SERIES IS NOT A FULL ONE (this milestone): scaling to the series
 * maximum turns seven identical counts into seven full-height bars, so a
 * reader sees "3 of 8 patterns are low-confidence" drawn exactly like "8 of 8".
 */

function heights(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>("[style*='height']")].map(
    (node) => node.style.height
  );
}

describe("BarChart", () => {
  it("draws nothing at all for a zero bucket", () => {
    const { container } = render(
      <BarChart
        bars={[
          { label: "a", value: 4 },
          { label: "b", value: 0 }
        ]}
        label="test"
      />
    );

    const drawn = heights(container);

    expect(drawn).toContain("0%");
    // And the non-zero bar is still drawn, so this is not passing vacuously.
    expect(drawn).toContain("100%");
  });

  it("keeps a tiny non-zero bucket visible", () => {
    const { container } = render(
      <BarChart
        bars={[
          { label: "huge", value: 9_000_000 },
          { label: "one", value: 1 }
        ]}
        label="test"
      />
    );

    expect(heights(container)).toContain("2%");
  });

  it("scales a flat series to its own maximum without a reference", () => {
    // The distribution case: a depth histogram has no denominator but itself.
    const { container } = render(
      <BarChart
        bars={[
          { label: "a", value: 3 },
          { label: "b", value: 3 }
        ]}
        label="test"
      />
    );

    expect(heights(container)).toEqual(["100%", "100%"]);
  });

  it("scales against the reference when one is given", () => {
    /**
     * THE REGRESSION THIS FILE EXISTS FOR. Seven windows each reporting 3 of 8
     * patterns at low confidence rendered as seven full-height bars, because
     * the series maximum was also 3. Drawn against the 8 they are 3 OF, the
     * same data reads as just under 40%.
     */
    const { container } = render(
      <BarChart
        bars={[
          { label: "a", value: 3 },
          { label: "b", value: 3 }
        ]}
        label="test"
        reference={8}
      />
    );

    expect(heights(container)).toEqual(["38%", "38%"]);
  });

  it("never clips a bar that exceeds its reference", () => {
    // A reference below a real value would hide the disagreement rather than
    // report it; the larger of the two wins so the bar stays inside the track.
    const { container } = render(
      <BarChart bars={[{ label: "a", value: 12 }]} label="test" reference={8} />
    );

    expect(heights(container)).toEqual(["100%"]);
  });
});
