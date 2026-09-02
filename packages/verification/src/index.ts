/**
 * HTTP verification: turning a sampled URL into an observation.
 *
 * A new package rather than a folder in the worker, because the concerns are
 * distinct from anything already here — probing someone else's origin, pacing
 * that traffic, and deciding what a response means — and because the policy it
 * enforces (packages/sampling) must stay independently testable from the client
 * that enforces it.
 */

export {
  type CircuitBreakerOptions,
  type CircuitState,
  HostCircuitBreaker
} from "./circuit-breaker.js";
export {
  DEFAULT_PROBE_BUDGET,
  type ProbeBudget,
  type ProbeErrorReason,
  type ProbeOptions,
  type ProbeResult,
  probeUrl
} from "./probe.js";
export {
  HostRateLimiter,
  type RateLimiterOptions,
  rateLimitKey
} from "./rate-limiter.js";
export {
  BROWSER_PROFILE,
  CRAWLER_PROFILE,
  DEFAULT_PROFILE_LADDER,
  headersFor,
  isSameProfile,
  type RequestProfile
} from "./request-profile.js";
export {
  detectSoft404,
  SOFT_404_TEXT_SIGNALS,
  type Soft404Options,
  type Soft404Verdict
} from "./soft-404.js";
export {
  type PatternVerdict,
  type VerifiedUrl,
  type VerifyPatternInput,
  type VerifyPatternOptions,
  type VerifyPatternResult,
  verifyPattern
} from "./verify-pattern.js";
