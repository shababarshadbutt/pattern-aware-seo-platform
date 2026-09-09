import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SamplingHealthSummary } from "../lib/api";
import { NOT_MEASURED, SamplingHealthGrid } from "./sampling-health";

/**
 * `circuit_breaks` must never render as a number.
 *
 * The column is `integer not null default 0` and nothing in the platform can
 * produce a value for it: `HostCircuitBreaker` keeps its state in a private Map
 * inside one worker process, no table records an opening, and `runFinalize`
 * runs as a separate job. So a measured zero and an unwritten one are the same
 * row, and printing "0" reports a measurement nobody made — §1.9's shape, a
 * label asserting a guarantee the code does not make.
 *
 * Three of the four figures that used to be literal zeros are derived from the
 * rows as of ADR-0034. This one is not, and this file is what stops it quietly
 * reverting to `formatCount` the next time someone tidies the grid.
 */

const HEALTH: SamplingHealthSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  siteId: "00000000-0000-4000-8000-000000000003",
  sitemapRunId: "00000000-0000-4000-8000-000000000002",
  windowStart: "2026-09-05T00:00:00.000Z",
  windowEnd: "2026-09-05T01:00:00.000Z",
  patternsTotal: 12,
  patternsLowConfidence: 3,
  patternsExpanded: 0,
  patternsBlocked: 1,
  patternsNeedsReview: 2,
  // Distinct from patternsTotal, so getByText below matches exactly one node.
  samplesDrawn: 11,
  httpRequests: 640,
  getEscalations: 55,
  /*
   * SEVEN, not zero, and that is the whole point. If the component reverts to
   * `formatCount(health.circuitBreaks)` a zero would be invisible against an
   * empty render — a seven cannot hide.
   */
  circuitBreaks: 7
};

const WEB_ROOT = existsSync(join(process.cwd(), "app"))
  ? process.cwd()
  : join(process.cwd(), "apps", "web");

function sourceFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);

      if (statSync(path).isDirectory()) {
        walk(path);

        continue;
      }

      if (
        (entry.endsWith(".tsx") || entry.endsWith(".ts")) &&
        !entry.includes(".test.")
      ) {
        found.push(path);
      }
    }
  };

  walk(join(WEB_ROOT, directory));

  return found;
}

describe("circuit breaks is reported as unmeasured, never as a figure", () => {
  it("renders the words rather than the number", () => {
    render(<SamplingHealthGrid health={HEALTH} />);

    expect(screen.getByText(NOT_MEASURED)).toBeDefined();
    expect(screen.queryByText("7")).toBeNull();
  });

  it("still renders the figures that ARE measured", () => {
    /**
     * Anti-vacuity for the case above: if the grid rendered nothing at all,
     * "does not contain 7" would pass for the wrong reason. These three are the
     * figures ADR-0034 moved from structurally-zero to derived, so they are
     * exactly the ones worth proving arrive.
     */
    render(<SamplingHealthGrid health={HEALTH} />);

    expect(screen.getByText("640")).toBeDefined();
    expect(screen.getByText("55")).toBeDefined();
    expect(screen.getByText("11")).toBeDefined();
  });

  it("finds files to scan, so the structural check is not vacuous", () => {
    /**
     * Guards the guard, the way the ADR-0008 guard does. A renamed directory or
     * a changed extension would otherwise make the scan below pass over an
     * empty list while reporting success.
     */
    const mentions = [
      ...sourceFilesUnder("app"),
      ...sourceFilesUnder("components")
    ].filter((file) => readFileSync(file, "utf8").includes("circuitBreaks"));

    expect(mentions.length).toBeGreaterThan(0);
  });

  it("no screen formats circuitBreaks as a number", () => {
    /**
     * Covers the second call site — the run detail's coverage panel — which
     * cannot be rendered in isolation here. A component test alone would have
     * left that one free to print the zero.
     *
     * Confirmed load-bearing by restoring `formatCount(health.circuitBreaks)`
     * in `components/sampling-health.tsx`, and separately by restoring
     * `formatCount(samplingHealth.circuitBreaks)` in
     * `app/runs/[runId]/page.tsx`. THE LAYER NEUTRALISED IN EACH CASE IS THAT
     * FILE'S PRESENTATION-LAYER SUBSTITUTION; each fails this test on its own.
     */
    const offences: string[] = [];

    for (const file of [
      ...sourceFilesUnder("app"),
      ...sourceFilesUnder("components")
    ]) {
      for (const [index, line] of readFileSync(file, "utf8")
        .split("\n")
        .entries()) {
        const code = line.trim();

        // Comments explain the rule; they do not break it. This is the M7
        // grep-guard finding, where a docblock counted as an enforcement.
        if (code.startsWith("//") || code.startsWith("*")) {
          continue;
        }

        if (/formatCount\([^)]*circuitBreaks/.test(code)) {
          offences.push(`${file}:${index + 1}`);
        }
      }
    }

    expect(
      offences,
      `circuitBreaks must render as "${NOT_MEASURED}", not as a number. Nothing in the platform produces the figure, so a 0 there reports a measurement nobody made. Offending lines:\n${offences.join("\n")}`
    ).toEqual([]);
  });
});
