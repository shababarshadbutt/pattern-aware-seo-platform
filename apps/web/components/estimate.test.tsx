import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AuditSnapshotSummary } from "../lib/api";
import { Estimate, estimateFromSnapshot, impactFromSnapshot } from "./estimate";

/**
 * ADR-0008's rendering contract, asserted.
 *
 * The type system already makes an interval-less `estimated` unconstructable,
 * which is the stronger guard. These cover what types cannot: that the `~` and
 * the interval actually reach the DOM, that a counted number does NOT get a
 * `~`, and that a blocked pattern renders no number at all.
 */

function snapshot(
  overrides: Partial<AuditSnapshotSummary> = {}
): AuditSnapshotSummary {
  return {
    id: "s1",
    patternId: "p1",
    patternSampleId: "ps1",
    sitemapRunId: "r1",
    httpStatus: 404,
    evidenceTier: "estimated",
    observedCount: 56,
    sampleSize: 62,
    populationCount: 6200,
    pointEstimate: 5600,
    ciLow: 4991,
    ciHigh: 5919,
    confidenceBand: "confident",
    confidenceLevel: 0.95,
    severityClass: "not_found",
    severityWeight: 1,
    impactScore: 5600,
    impactLow: 4991,
    impactHigh: 5919,
    estimatorVersion: "1.0.0",
    computedAt: "2026-09-03T17:27:09.882Z",
    ...overrides
  };
}

describe("an estimated figure", () => {
  it("always renders the ~ prefix and the interval", () => {
    render(<Estimate {...estimateFromSnapshot(snapshot())} />);

    const rendered = screen.getByTitle(/n=62 of N=6,200/u).textContent ?? "";

    expect(rendered).toContain("~5,600");
    expect(rendered).toContain("4,991");
    expect(rendered).toContain("5,919");
  });

  it("states the band in words, not only in colour", () => {
    /**
     * The band used to reach the reader through hue alone — invisible to
     * anyone who cannot distinguish the tokens, and absent from a screenshot
     * or a printout. ADR-0008 asks for a plain-language chip.
     */
    render(
      <Estimate
        {...estimateFromSnapshot(snapshot({ confidenceBand: "low" }))}
      />
    );

    expect(screen.getByText("low")).toBeDefined();
  });

  it("carries n and N so the claim is checkable", () => {
    render(<Estimate {...estimateFromSnapshot(snapshot())} />);

    expect(
      screen.getByTitle(/n=62 of N=6,200, confident confidence/u)
    ).toBeDefined();
  });
});

describe("a counted figure", () => {
  it("renders a plain number with no ~ and no interval", () => {
    /**
     * n = N. There is nothing left to be uncertain about, and a `~` on a
     * census would understate what is actually known — the inverse of the
     * usual failure and just as dishonest.
     */
    const { container } = render(
      <Estimate
        {...estimateFromSnapshot(
          snapshot({
            evidenceTier: "counted",
            populationCount: 18,
            sampleSize: 18,
            observedCount: 18,
            pointEstimate: 18,
            ciLow: 18,
            ciHigh: 18
          })
        )}
      />
    );

    // Asserted over the whole rendered output rather than a single node: the
    // point is that NO part of it carries a "~" or an interval dash.
    const text = container.textContent ?? "";

    expect(text).toContain("18");
    expect(text).not.toContain("~");
    expect(text).not.toContain("–");
  });
});

describe("a blocked pattern", () => {
  it("renders no number at all", () => {
    /**
     * A host refusing us is not a health measurement. Rendering a zero here
     * would report a blocked pattern as a clean one.
     */
    render(
      <Estimate
        {...estimateFromSnapshot(
          snapshot({ evidenceTier: "blocked", pointEstimate: 0 })
        )}
      />
    );

    expect(screen.getByText("no measurement")).toBeDefined();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("impact, as an estimated quantity", () => {
  it("renders with its own interval rather than as a bare figure", () => {
    /**
     * REGRESSION. Impact is `pointEstimate x severityWeight`, so it inherits
     * the estimate's uncertainty — and it was rendered as a bare
     * `toFixed(1)`, with no `~` and no interval, identically whether the tier
     * was counted or estimated.
     */
    render(
      <Estimate
        {...impactFromSnapshot(
          snapshot({
            severityWeight: 0.9,
            impactScore: 479.7,
            impactLow: 333.9,
            impactHigh: 612,
            pointEstimate: 533,
            ciLow: 371,
            ciHigh: 680,
            confidenceBand: "low"
          })
        )}
      />
    );

    const text = screen.getByTitle(/n=62/u).textContent ?? "";

    expect(text).toContain("~479.7");
    expect(text).toContain("333.9");
    expect(text).toContain("612");
  });

  it("weights the bounds by exactly the stored severity weight", () => {
    // Reuses the band rather than recomputing it: scaling both the point and
    // its bounds by a constant cannot change the interval's relative width.
    const props = impactFromSnapshot(
      snapshot({ severityWeight: 0.4, impactLow: 100, impactHigh: 200 })
    );

    expect(props.tier).toBe("estimated");

    if (props.tier === "estimated") {
      expect(props.low).toBe(100);
      expect(props.high).toBe(200);
      expect(props.band).toBe("confident");
    }
  });
});
