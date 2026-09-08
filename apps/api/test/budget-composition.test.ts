import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The API's sample budget must be the worker's sample budget.
 *
 * `apps/api/src/tools/budget.ts` deliberately duplicates the composition in
 * `apps/worker/src/index.ts` rather than sharing it, because moving that
 * composition into `packages/shared` would relocate the enforcement point of
 * six live limits — `POLICY_LIMITS` records `enforcedAt` as the worker entry
 * for every `SAMPLE_*` key, and the enforcement guard checks the key is
 * referenced in the file it names. That is a real refactor with consequences
 * for what `/settings` reports, not a side effect a tools slice should cause.
 *
 * Duplication is only safe while something notices divergence. If the two drift
 * the sample-plan tool reports a size the platform would not draw — a number
 * that looks authoritative, is internally consistent, and is wrong about the
 * only thing the tool exists to say.
 */

const REPO_ROOT = existsSync(join(process.cwd(), "apps", "worker"))
  ? process.cwd()
  : join(process.cwd(), "..", "..");

/** Every `field: config.KEY` pair in a source file. */
function budgetPairs(relativePath: string): ReadonlyMap<string, string> {
  const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
  const pairs = new Map<string, string>();

  for (const match of source.matchAll(/(\w+):\s*config\.(SAMPLE_[A-Z_]+)/gu)) {
    const [, field, key] = match;

    if (field !== undefined && key !== undefined) {
      pairs.set(field, key);
    }
  }

  return pairs;
}

describe("the API and the worker compose the same sample budget", () => {
  const worker = budgetPairs(join("apps", "worker", "src", "index.ts"));
  const api = budgetPairs(join("apps", "api", "src", "tools", "budget.ts"));

  it("finds pairs in both files, so a broken matcher cannot pass vacuously", () => {
    /*
     * Six SAMPLE_* keys are config-driven; `sampleRate` has no env override and
     * comes from the package default in both files, so it is correctly absent.
     * If either extraction stopped matching, the equality below would compare
     * two empty maps and report success.
     */
    expect(worker.size).toBe(6);
    expect(api.size).toBe(6);
  });

  it("maps every budget field to the same config key", () => {
    /**
     * Confirmed load-bearing by changing one key in `tools/budget.ts` —
     * `minSample: config.SAMPLE_MIN_PER_STRATUM` — which fails here naming both
     * files. THE LAYER NEUTRALISED IS THE API'S OWN COMPOSITION.
     */
    expect(
      Object.fromEntries([...api].sort()),
      "apps/api/src/tools/budget.ts has drifted from apps/worker/src/index.ts. The sample-plan tool would report a sample size the platform would not actually draw."
    ).toEqual(Object.fromEntries([...worker].sort()));
  });
});
