import {
  classifyOutcome,
  DEFAULT_ESCALATION_BUDGET,
  decideEscalation,
  type EscalationBudget,
  escalationAllowance,
  escalationRate,
  type SeverityClass
} from "@pattern-aware/sampling";

import type { HostCircuitBreaker } from "./circuit-breaker.js";
import { type ProbeOptions, type ProbeResult, probeUrl } from "./probe.js";
import type { HostRateLimiter } from "./rate-limiter.js";
import { rateLimitKey } from "./rate-limiter.js";

/**
 * Drive one pattern's sample through the probe, honouring every budget.
 *
 * This is where M4's escalation policy stops being a pure function and starts
 * preventing requests. The policy decides; this asks it before every
 * escalation and obeys the answer.
 */

export interface VerifyPatternInput {
  /** The URLs drawn for this pattern, already resolved from sample candidates. */
  readonly urls: readonly string[];
  /**
   * How many probes this pattern's sample was PLANNED to make.
   *
   * The escalation cap is a budget against the plan rather than a ratio
   * against work done — see ADR-0015. Passing `urls.length` is right for a
   * complete round; passing the full planned size is right when verifying it in
   * chunks, so the budget is not re-granted per chunk.
   *
   * Must be at least `urls.length`. A value below it would grant a budget
   * smaller than the work being done, and zero would disable the cap entirely
   * — see the validation below.
   */
  readonly plannedSampleSize: number;
}

export interface VerifyPatternOptions extends ProbeOptions {
  readonly rateLimiter?: HostRateLimiter;
  readonly circuitBreaker?: HostCircuitBreaker;
  readonly escalationBudget?: EscalationBudget;
}

export interface VerifiedUrl {
  readonly probe: ProbeResult;
  readonly severityClass: SeverityClass;
  /** True when the escalation cap prevented the GET this URL wanted. */
  readonly escalationSuppressed: boolean;
}

export type PatternVerdict =
  | { readonly kind: "measured" }
  | {
      /**
       * The host cannot be measured the cheap way. A finding for a person, not
       * a failure.
       *
       * ONLY `HEAD_NOT_SUPPORTED`, and the absence of a cap reason here is
       * deliberate — it used to be one, and that was wrong in a way only an
       * end-to-end run showed.
       *
       * A healthy 200 wants a soft-404 sniff, so a pattern that is entirely
       * healthy escalates on every URL and always spends its allowance, while a
       * pattern that is entirely gone (410, nothing to sniff) never escalates
       * at all. Flagging a spent allowance for review therefore inverted the
       * signal precisely: every healthy pattern was flagged and a completely
       * dead one came back clean. At fleet scale that makes the flag
       * meaningless and buries the host-level problems it exists to surface.
       *
       * A suppressed sniff still yields a usable status from the HEAD, so those
       * URLs are measured — what is reduced is soft-404 COVERAGE, which is now
       * reported as a number (see `soft404Sniffed`) instead of as a verdict.
       */
      readonly kind: "needs_review";
      readonly reason: "HEAD_NOT_SUPPORTED";
    }
  | {
      /** The host refused us. Never reported as a site defect. */
      readonly kind: "blocked";
      readonly reason: "TOO_MANY_REQUESTS" | "FORBIDDEN";
    };

export interface VerifyPatternResult {
  readonly verdict: PatternVerdict;
  readonly results: readonly VerifiedUrl[];
  readonly probed: number;
  readonly escalated: number;
  /** Outbound requests actually sent. Not the same as `probed`. */
  readonly requestCount: number;
  /** `escalated / probed`, for `sampling_health`. */
  readonly escalationRate: number;
  /**
   * How many URLs actually got a soft-404 sniff.
   *
   * The honest measure of what the escalation cap cost: a 2xx whose sniff was
   * suppressed has a real status but an unknown soft-404 outcome, and this is
   * the count of the ones that were genuinely checked. Reported rather than
   * flagged, because low coverage is a reason to sample harder (M3's expansion)
   * rather than a reason to send a human to look at a healthy pattern.
   */
  readonly soft404Sniffed: number;
  /** URLs whose sniff the cap prevented. `soft404Sniffed + this` = 2xx probed. */
  readonly soft404Suppressed: number;
}

/** Thrown when a sample plan cannot bound the work it is describing. */
export class InvalidSamplePlanError extends Error {
  public override readonly name = "InvalidSamplePlanError";
}

export async function verifyPattern(
  input: VerifyPatternInput,
  options: VerifyPatternOptions = {}
): Promise<VerifyPatternResult> {
  /**
   * VALIDATED, not trusted.
   *
   * `decideEscalation` answers `nothing_to_probe` for a zero-size plan, which
   * is not `suppress_escalation` — so a caller passing 0 alongside thirty real URLs
   * disabled the cap completely and the run came back "measured" with sixty
   * requests sent and no signal at all. Silent success on bad input, and the
   * bad input is a plausible slip: `plannedSampleSize` is easy to leave at a
   * default.
   */
  if (
    !Number.isInteger(input.plannedSampleSize) ||
    input.plannedSampleSize < input.urls.length
  ) {
    throw new InvalidSamplePlanError(
      `plannedSampleSize must be an integer of at least urls.length (${input.urls.length}); got ${input.plannedSampleSize}`
    );
  }

  const escalationBudget =
    options.escalationBudget ?? DEFAULT_ESCALATION_BUDGET;
  const allowance = escalationAllowance(
    input.plannedSampleSize,
    escalationBudget
  );
  const results: VerifiedUrl[] = [];

  let probed = 0;
  let escalated = 0;
  let requestCount = 0;
  let soft404Sniffed = 0;
  let soft404Suppressed = 0;
  let verdict: PatternVerdict = { kind: "measured" };

  for (const url of input.urls) {
    const host = rateLimitKey(url);
    const circuit = options.circuitBreaker?.stateFor(host);

    /**
     * An open circuit stops the loop, it does not skip one URL.
     *
     * Continuing would spend the rest of the sample learning the same fact
     * repeatedly, which is precisely the waste the breaker exists to prevent —
     * legacy measured a fully-blocked 1.3M-URL population paying ~2.6M requests
     * to discover one thing 1.3M times.
     */
    if (circuit?.kind === "open") {
      verdict = { kind: "blocked", reason: circuit.reason };
      break;
    }

    /**
     * ASKED BEFORE THE REQUEST, not after.
     *
     * The cap has to prevent the escalation rather than report it, so the
     * decision is made with the counts as they stand and the sniff is
     * suppressed when the budget is spent. A suppressed sniff still yields a
     * usable status from the HEAD — what is lost is soft-404 detection on that
     * URL, which is the honest trade for not doubling the request cost.
     */
    const decision = decideEscalation(
      { probed, escalated, plannedSampleSize: input.plannedSampleSize },
      escalationBudget
    );

    const suppressEscalation = decision.kind === "suppress_escalation";

    const probe = await probeUrl(
      url,
      probeOptionsFor(options, host, suppressEscalation)
    );

    probed += 1;
    requestCount += probe.requestCount;

    if (probe.escalatedToGet) {
      escalated += 1;
    }

    options.circuitBreaker?.record(host, probe.httpStatus);

    const severityClass = classifyOutcome({
      httpStatus: probe.httpStatus,
      ...(probe.soft404 === undefined
        ? {}
        : { isSoft404: probe.soft404.isSoft404 })
    });

    if (probe.soft404 !== undefined) {
      soft404Sniffed += 1;
    } else if (suppressEscalation && isSniffable(probe.httpStatus)) {
      // A 2xx that would have been sniffed had the budget allowed it. Counted
      // separately from "not applicable", so coverage is a fraction of the
      // URLs the sniff could ever have applied to.
      soft404Suppressed += 1;
    }

    results.push({
      probe,
      severityClass,
      escalationSuppressed: suppressEscalation
    });

    /**
     * A refusal mid-sample re-checks the breaker immediately, so the run stops
     * on the probe that opened the circuit rather than one URL later.
     */
    const reopened = options.circuitBreaker?.stateFor(host);

    if (reopened?.kind === "open") {
      verdict = { kind: "blocked", reason: reopened.reason };
      break;
    }

    /**
     * THE OTHER ESCALATION PATH, which the cap could not reach.
     *
     * Suppressing the sniff bounds a 2xx-heavy pattern, because the sniff is
     * optional — the HEAD already answered. A METHOD REJECTION is not
     * optional: without the GET re-probe there is no usable status at all, and
     * reporting the 405 would call a working page broken because of how we
     * asked.
     *
     * So a host that rejects HEAD on every URL escalated on every probe and
     * ignored the cap completely. Measured on a 30-URL sample against an
     * allowance of six: thirty escalations and sixty requests, exactly the
     * unbounded cost the cap exists to prevent, while the verdict claimed the
     * cap had tripped.
     *
     * It cannot be fixed by suppressing the re-probe, so it is fixed by
     * stopping. Once the budget is spent and a probe STILL had to escalate,
     * every remaining URL will cost double too and none of them can be made
     * cheap — the honest conclusion is that this host does not answer HEAD,
     * which is a host-level finding for a person to look at. Bounded to the
     * allowance plus one.
     */
    if (escalated > allowance && probe.methodRejectedStatus !== undefined) {
      verdict = { kind: "needs_review", reason: "HEAD_NOT_SUPPORTED" };
      break;
    }
  }

  return {
    verdict,
    results,
    probed,
    escalated,
    requestCount,
    escalationRate: escalationRate({
      probed,
      escalated,
      plannedSampleSize: input.plannedSampleSize
    }),
    soft404Sniffed,
    soft404Suppressed
  };
}

/** Is this a status the soft-404 sniff would apply to at all? */
function isSniffable(status: number | null | undefined): boolean {
  return (
    status !== null && status !== undefined && status >= 200 && status < 300
  );
}

/**
 * Build the probe's options, composing the caller's request hook with the rate
 * limiter rather than letting one silently win.
 *
 * Passing both a `beforeRequest` and a `rateLimiter` previously dropped the
 * caller's hook without a word — and that hook is how the platform-wide budget
 * gets charged, so losing it would under-count fleet traffic while the per-host
 * limiter kept working and nothing looked wrong.
 */
function probeOptionsFor(
  options: VerifyPatternOptions,
  host: string,
  suppressEscalation: boolean
): ProbeOptions {
  const limiter = options.rateLimiter;
  const callerHook = options.beforeRequest;

  const beforeRequest =
    limiter === undefined && callerHook === undefined
      ? undefined
      : async (url: string): Promise<() => void> => {
          const releases: (() => void)[] = [];

          if (callerHook !== undefined) {
            releases.push(await callerHook(url));
          }

          if (limiter !== undefined) {
            releases.push(await limiter.acquire(host));
          }

          return () => {
            // Released in reverse, so the limiter's slot frees before an outer
            // budget hook that might be gating on it.
            for (const release of releases.reverse()) {
              release();
            }
          };
        };

  return {
    ...(options.profileLadder === undefined
      ? {}
      : { profileLadder: options.profileLadder }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(beforeRequest === undefined ? {} : { beforeRequest }),
    // Suppressing the sniff is what actually enforces the cap on a 2xx-heavy
    // pattern: it is the escalation a healthy 200 would otherwise trigger.
    skipSoft404Sniff: options.skipSoft404Sniff === true || suppressEscalation
  };
}
