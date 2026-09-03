import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0008's enforcement clause: "A CI test asserts no page formats a sampled
 * figure outside [`<Estimate>`]."
 *
 * The component's discriminated union already makes an interval-less
 * `estimated` unconstructable — but only for code that goes through the
 * component. Nothing stopped a page reading `finding.pointEstimate` and
 * printing it directly, which is exactly what had happened to `impactScore`:
 * rendered as a bare `toFixed(1)`, no `~`, no interval, indistinguishable
 * from a counted figure.
 *
 * So the rule is structural rather than a review habit: a screen may pass a
 * whole snapshot to an adapter, and may not touch the estimate-bearing fields
 * itself. The adapters in `components/estimate.tsx` are the one place allowed
 * to read them, because reading them is their job.
 */

/**
 * Fields that carry an extrapolated figure.
 *
 * `populationCount` and `sampleSize` are deliberately absent: a population is
 * COUNTED and a sample size is a fact about the draw, so both are rendered as
 * plain numbers and neither needs an interval.
 */
const SAMPLED_FIELDS = [
  "pointEstimate",
  "ciLow",
  "ciHigh",
  "impactScore",
  "impactLow",
  "impactHigh"
] as const;

/** The only module allowed to read those fields. */
const ADAPTER_FILE = "estimate.tsx";

/**
 * Resolved from the working directory, not from `import.meta.url`.
 *
 * Vitest's transform rewrites `import.meta.url` to something that is not a
 * `file:` URL, so `fileURLToPath` throws on it. The working directory is
 * `apps/web` when the workspace runs its own suite and the repo root when
 * vitest is pointed here with `--root`; both are handled, and the
 * "finds screens to check" test below fails loudly if neither resolved.
 */
const WEB_ROOT = existsSync(join(process.cwd(), "app"))
  ? process.cwd()
  : join(process.cwd(), "apps", "web");

function tsxFilesUnder(directory: string): readonly string[] {
  const absolute = join(WEB_ROOT, directory);
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

  walk(absolute);

  return found;
}

describe("ADR-0008: no sampled figure is formatted outside <Estimate>", () => {
  it("finds screens to check, so a passing result is not vacuous", () => {
    /**
     * Guards the guard. If the walk stopped matching files — a renamed
     * directory, a changed extension — every assertion below would pass over
     * an empty list and this test would report success while checking
     * nothing.
     */
    expect(tsxFilesUnder("app").length).toBeGreaterThan(2);
  });

  it("no screen reads an estimate-bearing field directly", () => {
    const offences: string[] = [];

    for (const file of [
      ...tsxFilesUnder("app"),
      ...tsxFilesUnder("components")
    ]) {
      if (file.endsWith(ADAPTER_FILE)) {
        continue;
      }

      const source = readFileSync(file, "utf8");

      for (const [index, line] of source.split("\n").entries()) {
        // Comments explain the rule; they do not break it.
        const code = line.trim();

        if (code.startsWith("//") || code.startsWith("*")) {
          continue;
        }

        for (const field of SAMPLED_FIELDS) {
          if (code.includes(`.${field}`)) {
            offences.push(
              `${file.replace(WEB_ROOT, "")}:${index + 1} reads .${field} — pass the snapshot to estimateFromSnapshot/impactFromSnapshot instead`
            );
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it("the adapter module does read them, which is the point", () => {
    /**
     * The complement of the rule above. If this ever fails, the adapters have
     * been moved or renamed and the check above is scanning for a convention
     * nothing follows any more — passing for the wrong reason.
     */
    const adapter = readFileSync(
      join(WEB_ROOT, "components", ADAPTER_FILE),
      "utf8"
    );

    for (const field of SAMPLED_FIELDS) {
      expect(adapter).toContain(`.${field}`);
    }
  });
});
