import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { POLICY_LIMITS } from "../src/policy-manifest.js";

/**
 * Two rules the tool routes must keep, neither of which any existing guard sees.
 *
 * 1. THE TOOLS MAY NOT DO THEIR OWN STATISTICS. The whole justification for a
 *    calculator over `packages/sampling` is that it recomputes what the
 *    pipeline runs. `measureProportion` exists so there is one composition; a
 *    route reaching past it to `wilsonInterval` or `confidenceBandFor` would
 *    rebuild that composition locally, and would then be free to drift while
 *    still looking authoritative for calling the same primitives.
 *
 * 2. THE TOOLS MAY NOT APPLY A LIMIT NOTHING ELSE APPLIES. Twelve of the
 *    platform's operational limits are validated at startup and consumed by no
 *    code, which is why `/settings` badges them NOT ENFORCED.
 *    `policy-enforcement-guard.test.ts` checks that claim in both directions —
 *    but it EXCLUDES `apps/api` and `apps/web` from the unenforced direction
 *    (`PRESENTATION_ROOTS`), reasoning that a screen naming a limit is
 *    presenting it rather than applying it.
 *
 *    That carve-out was correct until this directory existed. A tool route is
 *    the first place in `apps/api` where naming a limit and APPLYING it are the
 *    same act, so the guard's blind spot now covers exactly the code most able
 *    to break its claim — silently, since nothing would fail while `/settings`
 *    began to lie. This narrows the carve-out for that one directory.
 */

const API_ROOT = existsSync(join(process.cwd(), "src", "routes"))
  ? process.cwd()
  : join(process.cwd(), "apps", "api");

/** The one composition a tool may measure through. */
const SANCTIONED_IMPORTS = [
  "measureProportion",
  "firstRoundSampleSize",
  "planFirstRound",
  "planExpansionFor"
] as const;

/**
 * Primitives `measureProportion` composes. Importing one here would be
 * rebuilding that composition rather than using it.
 */
const FORBIDDEN_IMPORTS = [
  "wilsonInterval",
  "estimateStratified",
  "confidenceBandFor",
  /*
   * `planExpansion` takes a StratifiedEstimate, which a route holding only a
   * Measurement must FABRICATE — and the empty `strata` that fabrication
   * requires silently inverts its answer. `planExpansionFor` takes the
   * observations instead, so the estimate is built once, correctly, inside the
   * package. Listed here after that inversion shipped and was caught by a
   * screenshot rather than by any test.
   */
  "planExpansion(?!For)"
] as const;

/** Policy keys the manifest itself records as applied by nothing. */
function unenforcedKeys(): readonly string[] {
  return Object.entries(POLICY_LIMITS)
    .filter(([, meta]) => meta.enforcedAt === null)
    .map(([key]) => key);
}

function toolSources(): readonly { path: string; code: string }[] {
  const files: string[] = [join(API_ROOT, "src", "routes", "tools.ts")];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);

      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".ts")) {
        files.push(path);
      }
    }
  };

  walk(join(API_ROOT, "src", "tools"));

  return files.map((path) => ({
    path,
    /*
     * Comments stripped before matching. A docblock explaining WHY a limit is
     * not applied would otherwise count as applying it — the M7 grep-guard
     * finding, which this file's own header would trigger verbatim.
     */
    code: readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "")
  }));
}

describe("the tool routes measure through the shared composition", () => {
  it("finds the tool sources, so a passing result is not vacuous", () => {
    // Guards the guard. A rename would otherwise make every assertion below
    // pass over an empty list while reporting success.
    const sources = toolSources();

    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(
      sources.some((source) => source.code.includes("measureProportion"))
    ).toBe(true);
  });

  it("recognises a sanctioned import where one really is present", () => {
    /*
     * A positive control on the matcher itself. The `\b`-in-a-template-literal
     * bug in `policy-enforcement-guard.test.ts` made every one of its
     * assertions pass at once while checking nothing; a matcher that can only
     * report success is not a guard.
     */
    const sources = toolSources();

    for (const name of SANCTIONED_IMPORTS) {
      expect(
        sources.some((source) =>
          new RegExp(String.raw`\b${name}\b`, "u").test(source.code)
        ),
        `${name} should appear in the tool sources — if it no longer does, this control is testing nothing.`
      ).toBe(true);
    }
  });

  it("no tool source imports a statistical primitive directly", () => {
    const offences: string[] = [];

    for (const { path, code } of toolSources()) {
      for (const name of FORBIDDEN_IMPORTS) {
        if (new RegExp(String.raw`\b${name}\b`, "u").test(code)) {
          offences.push(`${path} references ${name}`);
        }
      }
    }

    expect(
      offences,
      `A tool must measure through measureProportion, the same composition runEstimate writes audit_snapshot rows with. Reaching past it to a primitive rebuilds that composition locally, where it is free to drift from the pipeline it claims to demonstrate:\n${offences.join("\n")}`
    ).toEqual([]);
  });

  it("knows which limits are unenforced, so the check below has subjects", () => {
    // Guards the guard: if the manifest ever marked everything enforced, the
    // assertion that follows would iterate nothing and pass over an empty set.
    expect(unenforcedKeys().length).toBeGreaterThan(0);
  });

  it("no tool source applies a limit that nothing else applies", () => {
    /**
     * Derived from the MANIFEST rather than a hand-written list of names, so it
     * cannot go stale: whatever `POLICY_LIMITS` currently records as
     * `enforcedAt: null` is what a tool may not honour, including limits added
     * after this file was written.
     *
     * Matched on `config.KEY` specifically, because the package DEFAULT is the
     * correct thing to use — `DEFAULT_CONFIDENCE_THRESHOLDS` is what the
     * pipeline actually runs on. An earlier version of this guard matched the
     * bare substring and flagged that constant as an offence, which would have
     * pushed the fix in exactly the wrong direction.
     *
     * Confirmed load-bearing by adding `config.CONFIDENCE_LOW_BAND_WIDTH` to
     * `tools/budget.ts`. THE LAYER NEUTRALISED IS THIS ASSERTION ITSELF, which
     * is the point: `policy-enforcement-guard.test.ts` stays green through that
     * edit because `apps/api` sits inside its `PRESENTATION_ROOTS` carve-out,
     * so without this file nothing would notice.
     */
    const offences: string[] = [];

    for (const { path, code } of toolSources()) {
      for (const key of unenforcedKeys()) {
        if (new RegExp(String.raw`config\.${key}\b`, "u").test(code)) {
          offences.push(`${path} applies ${key}`);
        }
      }
    }

    expect(
      offences,
      `These limits are validated at startup and applied by nothing, which is why /settings badges them NOT ENFORCED. A tool honouring one would produce an answer the pipeline does not, while the Settings screen truthfully reported that the number does nothing. Use the package default — measureProportion takes no thresholds argument for exactly this reason:\n${offences.join("\n")}`
    ).toEqual([]);
  });
});
