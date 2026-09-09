import {
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "@pattern-aware/sampling";
import type { PolicyConfig } from "@pattern-aware/shared";

/**
 * The sampling budget the tools answer with — the one the platform actually
 * uses, not the package's defaults.
 *
 * MIRRORS `apps/worker/src/index.ts`, deliberately and duplicately.
 * `budget-composition.test.ts` asserts the two field-to-key maps are identical,
 * so a key added in one place and not the other fails the build rather than
 * making the sample-plan tool quietly report a size the worker would not draw.
 *
 * Duplicated rather than shared because moving the composition into
 * `packages/shared` would relocate the enforcement point of six live limits for
 * a calculator's convenience: `POLICY_LIMITS` records `enforcedAt` as
 * `apps/worker/src/index.ts` for all six `SAMPLE_*` keys, and the enforcement
 * guard checks that the key is referenced in the file it names. That is a real
 * refactor with its own consequences for what `/settings` reports, not a
 * side-effect a tools slice should cause.
 *
 * THE RULE THIS ENCODES, which is the whole reason there are two different
 * treatments in this codebase: a tool must answer with what the pipeline does,
 * and `POLICY_LIMITS[key].enforcedAt` is the field that says what that is.
 * Non-null means the value reaches real behaviour, so the tool follows config —
 * which is these six keys. Null means nothing applies it and the package
 * default is what runs, which is the case for the four `CONFIDENCE_*` widths;
 * that is why `measureProportion` takes no thresholds parameter at all, and why
 * nothing under this directory may reference a `CONFIDENCE_*` key.
 *
 * `sampleRate` has no env override, so it comes from the package default — the
 * same exception the worker makes, for the same reason.
 */
export function policySampleBudget(config: PolicyConfig): SampleBudget {
  return {
    sampleRate: DEFAULT_SAMPLE_BUDGET.sampleRate,
    minSample: config.SAMPLE_MIN_SIZE,
    maxFirstRound: config.SAMPLE_MAX_FIRST_ROUND,
    maxExpanded: config.SAMPLE_MAX_EXPANDED,
    maxExpansionFactor: config.SAMPLE_MAX_EXPANSION_FACTOR,
    maxPopulationFraction: config.SAMPLE_MAX_POPULATION_FRACTION,
    minPerStratum: config.SAMPLE_MIN_PER_STRATUM
  };
}
