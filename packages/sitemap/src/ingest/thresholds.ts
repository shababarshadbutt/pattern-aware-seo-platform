/**
 * How a run behaves when a site turns out to be bigger than expected.
 *
 * The governing rule is: DEGRADE, NEVER SILENTLY TRUNCATE. Counting is a
 * streaming operation that stays cheap at any size, so the population figure is
 * always honest even when sampling is cut back or abandoned. What must never
 * happen is a truncated read presented as a complete one — a site reported as
 * having 20 million URLs when it has 200 million looks entirely normal, and
 * every downstream estimate is then wrong about the denominator with nothing
 * indicating why.
 */
export interface OversizeThresholds {
  /** Past this, keep going but sample less and mark the run degraded. */
  readonly softLimitUrls: number;
  /** Past this, stop after counting. The population is still reported. */
  readonly hardLimitUrls: number;
  /** Past this many files, likewise. */
  readonly hardLimitFiles: number;
}

export type OversizeVerdict =
  | { readonly kind: "ok" }
  | {
      /** Continue, at a reduced sample rate, and flag the run. */
      readonly kind: "degraded";
      readonly reason: "OVERSIZE_SOFT_LIMIT";
      readonly sampleRateMultiplier: number;
    }
  | {
      /** Stop sampling. Counting continues so the population stays truthful. */
      readonly kind: "stop";
      readonly reason: "OVERSIZE_HARD_LIMIT_URLS" | "OVERSIZE_HARD_LIMIT_FILES";
    };

/**
 * How much to shrink sampling by once past the soft limit.
 *
 * Scaled by how far over the site is rather than a flat cut, so a site 10%
 * over barely changes while one 10x over shrinks hard. Floored so a very large
 * site still gets a usable sample rather than a token one — an estimate nobody
 * can act on is not much better than no estimate.
 */
const MIN_SAMPLE_RATE_MULTIPLIER = 0.1;

export function sampleRateMultiplierFor(
  totalUrls: number,
  softLimitUrls: number
): number {
  if (totalUrls <= softLimitUrls) {
    return 1;
  }

  return Math.max(MIN_SAMPLE_RATE_MULTIPLIER, softLimitUrls / totalUrls);
}

/**
 * Judge a run's size so far.
 *
 * Called as counts accumulate, not once at the end — the hard limit only saves
 * anything if it is noticed while there is still work left to skip.
 */
/**
 * The conservative default a caller gets when it does not configure its own
 * thresholds.
 *
 * Soft and hard URL limits are left at `Infinity` deliberately: as of Phase
 * 2A only the file-count hard limit is wired into the pipeline (see
 * `packages/pipeline/src/stages/ingest.ts`), so a caller that has not been
 * given real `POPULATION_SOFT_LIMIT_URLS`/`POPULATION_HARD_LIMIT_URLS` values
 * should not have this module's URL-based branches fire on its behalf. The
 * file limit mirrors `packages/shared/src/config.ts`'s own
 * `POPULATION_HARD_LIMIT_FILES` default so the two stay in agreement without
 * `packages/sitemap` importing from `packages/shared`.
 */
export const DEFAULT_OVERSIZE_THRESHOLDS: OversizeThresholds = {
  softLimitUrls: Number.POSITIVE_INFINITY,
  hardLimitUrls: Number.POSITIVE_INFINITY,
  hardLimitFiles: 50_000
};

export function assessSize(
  observed: { readonly totalUrls: number; readonly totalFiles: number },
  thresholds: OversizeThresholds
): OversizeVerdict {
  if (observed.totalFiles > thresholds.hardLimitFiles) {
    return { kind: "stop", reason: "OVERSIZE_HARD_LIMIT_FILES" };
  }

  if (observed.totalUrls > thresholds.hardLimitUrls) {
    return { kind: "stop", reason: "OVERSIZE_HARD_LIMIT_URLS" };
  }

  if (observed.totalUrls > thresholds.softLimitUrls) {
    return {
      kind: "degraded",
      reason: "OVERSIZE_SOFT_LIMIT",
      sampleRateMultiplier: sampleRateMultiplierFor(
        observed.totalUrls,
        thresholds.softLimitUrls
      )
    };
  }

  return { kind: "ok" };
}
