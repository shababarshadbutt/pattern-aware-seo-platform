import {
  classifyOutcome,
  DEFAULT_ESCALATION_BUDGET,
  decideEscalation,
  type EscalationBudget,
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
  /** True when an open circuit meant no request was sent at all. */
  readonly skippedByCircuit: boolean;
}

export type PatternVerdict =
  | { readonly kind: "measured" }
  | {
      /** Too much of the sample needed a GET. A finding, not a failure. */
      readonly kind: "needs_review";
      readonly reason: "GET_ESCALATION_CAP";
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
}

export async function verifyPattern(
  input: VerifyPatternInput,
  options: VerifyPatternOptions = {}
): Promise<VerifyPatternResult> {
  const escalationBudget =
    options.escalationBudget ?? DEFAULT_ESCALATION_BUDGET;
  const results: VerifiedUrl[] = [];

  let probed = 0;
  let escalated = 0;
  let requestCount = 0;
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

    const suppressEscalation = decision.kind === "flag_for_review";

    if (suppressEscalation && verdict.kind === "measured") {
      verdict = { kind: "needs_review", reason: "GET_ESCALATION_CAP" };
    }

    const probeOptions: ProbeOptions = {
      ...options,
      // Suppressing the sniff is what actually enforces the cap: it is the
      // escalation a healthy 2xx would otherwise trigger.
      skipSoft404Sniff: options.skipSoft404Sniff === true || suppressEscalation,
      ...(options.rateLimiter === undefined
        ? {}
        : {
            beforeRequest: async () =>
              (options.rateLimiter as HostRateLimiter).acquire(host)
          })
    };

    const probe = await probeUrl(url, probeOptions);

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

    results.push({
      probe,
      severityClass,
      escalationSuppressed: suppressEscalation,
      skippedByCircuit: false
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
    })
  };
}
