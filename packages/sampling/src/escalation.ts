/**
 * How much of a pattern's sample may escalate from HEAD to GET before the
 * pattern is set aside for a human instead of burning more budget.
 *
 * WHY THIS EXISTS. Verification is HEAD-first because a HEAD is cheap and
 * answers most questions. A GET is escalated to only when the HEAD result is
 * suspicious — a method rejection, or a 2xx that needs its body sniffed for a
 * soft-404. That design saves most of the traffic, and a pattern where
 * everything looks suspicious defeats it completely: every probe costs a HEAD
 * plus a ranged GET, and the run quietly spends several times the budget it was
 * given. The action plan calls this out directly.
 *
 * The answer is not to escalate less — the escalations are individually
 * justified. It is to notice that this pattern is not answerable cheaply, stop,
 * and say so. A pattern flagged for review is a finding, not a failure.
 *
 * Pure and synchronous so the decision is testable without an HTTP client. The
 * client consults it; it never reaches out.
 */

export interface EscalationBudget {
  /**
   * Share of the PLANNED sample allowed to escalate.
   *
   * Deliberately measured against the planned size rather than probes
   * completed so far. A ratio against work done trips on the first probe — one
   * escalation out of one is 100% — so it would need an arbitrary warm-up
   * floor to be usable. Against the plan it is an absolute budget from the
   * start: 20% of a 400-probe sample is 80 escalations, and the first one is
   * obviously fine.
   */
  readonly maxEscalationFraction: number;
  /** Bytes of body fetched to sniff a 2xx for a soft-404. */
  readonly soft404BodyBytes: number;
  /** Bytes fetched when a HEAD was method-rejected and GET is the fallback. */
  readonly methodFallbackBodyBytes: number;
}

/**
 * Ported from the legacy engine, which had these right.
 *
 * Phase 0 checked the action plan's claim that GET bodies were unbounded and
 * found the opposite: legacy already caps them, and sends a `Range` header so
 * the server does not transmit more than is read. 64 KB is enough for a
 * soft-404 signal to appear in the markup; the whole page is never needed. The
 * 8 KB fallback is smaller because a method-rejection re-probe only needs a
 * status, not content.
 */
export const DEFAULT_ESCALATION_BUDGET: EscalationBudget = {
  maxEscalationFraction: 0.2,
  soft404BodyBytes: 64 * 1024,
  methodFallbackBodyBytes: 8 * 1024
};

export interface EscalationState {
  /** Probes completed for this pattern, across all rounds. */
  readonly probed: number;
  /** How many of those needed a GET on top of their HEAD. */
  readonly escalated: number;
  /** Probes this pattern's sample was planned to make. */
  readonly plannedSampleSize: number;
}

export type EscalationDecision =
  | { readonly kind: "allow"; readonly remaining: number }
  | {
      /**
       * The allowance is spent: stop escalating.
       *
       * RENAMED from `flag_for_review`, which described the wrong consequence.
       * A spent allowance means the optional soft-404 sniff is not sent — the
       * URL still has a real status from its HEAD, so the pattern is still
       * measured. Calling it a flag made every entirely-healthy pattern (whose
       * every 200 wants a sniff) look like it needed a human, while an entirely
       * dead pattern (410, nothing to sniff) came back clean. The consumer
       * always did the right thing with this decision; only its name disagreed.
       */
      readonly kind: "suppress_escalation";
      readonly reason: "ESCALATION_BUDGET_SPENT";
      readonly escalated: number;
      readonly allowed: number;
    }
  /**
   * Nothing was planned, so there is nothing to escalate.
   *
   * Distinguished from `suppress_escalation` deliberately. An empty plan
   * yields an allowance of zero, which read as "the cap is already spent" —
   * indistinguishable from a real pattern whose budget ran out, when in fact
   * there is nothing here to probe at all.
   */
  | { readonly kind: "nothing_to_probe" };

/** How many escalations this pattern's sample is allowed in total. */
export function escalationAllowance(
  plannedSampleSize: number,
  budget: EscalationBudget = DEFAULT_ESCALATION_BUDGET
): number {
  if (plannedSampleSize <= 0) {
    return 0;
  }

  /**
   * Rounded UP, and at least one.
   *
   * On a small pattern 20% of 30 is 6, but 20% of 3 rounds to nothing — and a
   * pattern that may not escalate even once cannot be verified at all, so it
   * would be flagged for review before doing any work. A floor of one means
   * the cap constrains without ever blocking outright.
   */
  return Math.max(
    1,
    Math.ceil(plannedSampleSize * budget.maxEscalationFraction)
  );
}

/**
 * Decide whether another HEAD→GET escalation is allowed.
 *
 * Called before escalating, not after, so the cap prevents the request rather
 * than reporting it.
 */
export function decideEscalation(
  state: EscalationState,
  budget: EscalationBudget = DEFAULT_ESCALATION_BUDGET
): EscalationDecision {
  if (state.plannedSampleSize <= 0) {
    return { kind: "nothing_to_probe" };
  }

  const allowed = escalationAllowance(state.plannedSampleSize, budget);

  if (state.escalated >= allowed) {
    return {
      kind: "suppress_escalation",
      reason: "ESCALATION_BUDGET_SPENT",
      escalated: state.escalated,
      allowed
    };
  }

  return { kind: "allow", remaining: allowed - state.escalated };
}

/**
 * The escalation rate to record against `sampling_health`.
 *
 * Reported per pattern and aggregated fleet-wide, where a rising rate means the
 * HEAD-first design is being defeated somewhere — the M7 alert watches it.
 * Returns 0 rather than NaN for an unprobed pattern, so an average over many
 * patterns is not poisoned by the ones that have not started.
 */
export function escalationRate(state: EscalationState): number {
  return state.probed <= 0 ? 0 : state.escalated / state.probed;
}

/**
 * How many requests a pattern's verification actually costs.
 *
 * Worth having explicitly, because "one check" is not one request and treating
 * it as one under-counts the platform request budget by however much escalation
 * is happening. Legacy documents the same arithmetic: a check is a HEAD, plus a
 * GET when it escalated.
 *
 * A FLOOR, not the whole cost. Legacy also notes that a 3xx costs a HEAD plus a
 * follow-up HEAD on the destination, which this cannot count because nothing
 * here tracks redirects. The HTTP client will know its real request count and
 * should report that, rather than leaving this as the platform budget only
 * input.
 */
export function estimatedRequestCost(state: EscalationState): number {
  return state.probed + state.escalated;
}
