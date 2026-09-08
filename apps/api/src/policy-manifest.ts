import type { PolicyConfig } from "@pattern-aware/shared";

/**
 * What each operational limit means, and whether anything actually applies it.
 *
 * WHY `enforcedAt` EXISTS AT ALL. Several of these limits are validated at
 * startup, served over the wire, and consumed by nothing — the escalation
 * fraction is the clearest case: `HTTP_MAX_GET_ESCALATION_FRACTION` is read
 * from the environment while `verifyPattern` falls back to the hardcoded
 * `DEFAULT_ESCALATION_BUDGET`, because the pipeline's verify stage never passes
 * one. A Settings screen that printed those numbers as though they governed
 * anything would be asserting a guarantee the code does not make, which is the
 * §1.9 defect this codebase has already found twice. So the fact travels with
 * the number.
 *
 * WHY IT IS A PATH AND NOT A BOOLEAN. `enforcedAt: string | null` is one field,
 * so there is no flag that can disagree with its own explanatory note. The
 * string names the file where the value is consumed, which is checkable —
 * `policy-enforcement-guard.test.ts` reads it and fails when a limit marked
 * enforced has no reference in that file, or when a limit marked unenforced
 * acquires one anywhere.
 *
 * WHY THE MAPPED TYPE. `{ [K in keyof PolicyConfig]: PolicyMeta }` makes it a
 * COMPILE ERROR to add a key to the config mask without recording whether it is
 * enforced, and a compile error to describe a key that is not config. The
 * alternative — a plain record — silently omits new limits, and an omitted
 * limit is one the screen stops mentioning rather than one it flags.
 */

/** How a value should be read, so the UI formats it without guessing. */
export type PolicyUnit = "rps" | "count" | "fraction" | "ms" | "bytes";

export interface PolicyMeta {
  /** Human label. The env-var name travels separately and is shown as-is. */
  readonly label: string;
  readonly unit: PolicyUnit;
  /**
   * Repo-relative path of the file that consumes this value, or `null` when
   * nothing does. Checked by the enforcement guard, not taken on trust.
   */
  readonly enforcedAt: string | null;
}

const WORKER_ENTRY = "apps/worker/src/index.ts";

export const POLICY_LIMITS: {
  readonly [K in keyof PolicyConfig]: PolicyMeta;
} = {
  // --- Population thresholds ---
  POPULATION_SOFT_LIMIT_URLS: {
    label: "Population soft limit",
    unit: "count",
    enforcedAt: null
  },
  POPULATION_HARD_LIMIT_URLS: {
    label: "Population hard limit",
    unit: "count",
    enforcedAt: null
  },
  POPULATION_HARD_LIMIT_FILES: {
    label: "Population hard limit (files)",
    unit: "count",
    enforcedAt: null
  },

  // --- Sampling bounds. Composed into a SampleBudget at the worker edge. ---
  SAMPLE_MIN_SIZE: {
    label: "Minimum sample size",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  SAMPLE_MAX_FIRST_ROUND: {
    label: "First-round sample cap",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  SAMPLE_MAX_EXPANDED: {
    label: "Expanded sample cap",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  SAMPLE_MAX_EXPANSION_FACTOR: {
    label: "Maximum expansion factor",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  SAMPLE_MAX_POPULATION_FRACTION: {
    label: "Maximum share of a population sampled",
    unit: "fraction",
    enforcedAt: WORKER_ENTRY
  },
  SAMPLE_MIN_PER_STRATUM: {
    label: "Minimum sample per stratum",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },

  /*
   * --- Confidence bands (ADR-0013). NONE OF THESE FOUR ARE APPLIED. ---
   *
   * Recorded as enforced when this manifest was first written, and the
   * enforcement guard proved that wrong: the four variables appear in no source
   * file outside `config.ts`. `confidenceBandFor` and `planExpansion`
   * default to `DEFAULT_CONFIDENCE_THRESHOLDS`
   * (`packages/sampling/src/confidence-band.ts:37`) and nothing threads the
   * configured values through — the same shape as the escalation fraction
   * below, a tunable losing to a package default because no caller passes it.
   *
   * Worth more than the others, because `CONFIDENCE_LOW_BAND_WIDTH`'s own
   * docblock in `config.ts` says it is shared deliberately between the
   * expansion trigger and the UI's LOW band, "and the two disagreeing would
   * mean the interface flags a pattern the engine considers settled". Setting
   * it today changes neither.
   */
  CONFIDENCE_LOW_BAND_WIDTH: {
    label: "Low-confidence band width",
    unit: "fraction",
    enforcedAt: null
  },
  CONFIDENCE_APPROXIMATE_BAND_WIDTH: {
    label: "Approximate-confidence band width",
    unit: "fraction",
    enforcedAt: null
  },
  CONFIDENCE_ZERO_HIT_LOW_BAND_WIDTH: {
    label: "Low band width, zero-hit estimate",
    unit: "fraction",
    enforcedAt: null
  },
  CONFIDENCE_ZERO_HIT_APPROXIMATE_BAND_WIDTH: {
    label: "Approximate band width, zero-hit estimate",
    unit: "fraction",
    enforcedAt: null
  },

  // --- Outbound HTTP. These bound traffic at somebody else's origin. ---
  HTTP_PER_HOST_REQUESTS_PER_SECOND: {
    label: "Per-host request rate",
    unit: "rps",
    enforcedAt: WORKER_ENTRY
  },
  HTTP_PER_HOST_CONCURRENCY: {
    label: "Per-host concurrency",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  /*
   * The five unenforced budgets, and the reason the screen says so.
   *
   * There is no per-site or platform-wide request counter anywhere — no table,
   * no Redis key — so nothing can charge a daily cap against anything. The warn
   * and halt fractions are fractions OF those uncounted caps. And the
   * escalation fraction loses to `DEFAULT_ESCALATION_BUDGET` because the verify
   * stage never passes a budget through.
   */
  HTTP_PLATFORM_DAILY_REQUEST_CAP: {
    label: "Platform daily request cap",
    unit: "count",
    enforcedAt: null
  },
  HTTP_PER_SITE_DAILY_REQUEST_CAP: {
    label: "Per-site daily request cap",
    unit: "count",
    enforcedAt: null
  },
  HTTP_BUDGET_WARN_FRACTION: {
    label: "Budget warn threshold",
    unit: "fraction",
    enforcedAt: null
  },
  HTTP_BUDGET_HALT_FRACTION: {
    label: "Budget halt threshold",
    unit: "fraction",
    enforcedAt: null
  },
  HTTP_MAX_GET_ESCALATION_FRACTION: {
    label: "Maximum GET escalation share",
    unit: "fraction",
    enforcedAt: null
  },

  // --- Circuit breaker ---
  HTTP_CIRCUIT_BREAK_AFTER_429: {
    label: "Circuit break after 429s",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  HTTP_CIRCUIT_BREAK_AFTER_403: {
    label: "Circuit break after 403s",
    unit: "count",
    enforcedAt: WORKER_ENTRY
  },
  HTTP_CIRCUIT_COOLDOWN_MS: {
    label: "Circuit cooldown",
    unit: "ms",
    enforcedAt: WORKER_ENTRY
  }
};

/** The manifest's keys, typed so a caller can index a `PolicyConfig` with them. */
export const POLICY_LIMIT_KEYS = Object.keys(
  POLICY_LIMITS
) as readonly (keyof PolicyConfig)[];

/**
 * Per-site policy columns that are stored and served but applied by nothing.
 *
 * Separate from {@link POLICY_LIMITS} because these are database columns rather
 * than environment variables, and because the guard has to scan them against a
 * different exclusion set: `packages/database` owns them and `apps/api` and
 * `apps/web` legitimately carry and render them, so only a reference from the
 * verification or worker side would mean one had become real.
 *
 * `HostRateLimiter` derives a single `#intervalMs` from `requestsPerSecond` and
 * its options accept no per-site override, which is precisely the absence the
 * guard asserts.
 */
export const SITE_POLICY_COLUMNS = {
  dailyRequestCap: {
    label: "Daily request cap",
    unit: "count",
    enforcedAt: null
  },
  minRequestIntervalMs: {
    label: "Minimum request interval",
    unit: "ms",
    enforcedAt: null
  }
} as const satisfies Record<string, PolicyMeta>;
