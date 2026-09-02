import { describe, expect, it } from "vitest";

import {
  DEFAULT_ESCALATION_BUDGET,
  decideEscalation,
  escalationAllowance,
  escalationRate,
  estimatedRequestCost
} from "./escalation.js";

const BUDGET = DEFAULT_ESCALATION_BUDGET;

describe("escalationAllowance", () => {
  it("allows the configured share of the planned sample", () => {
    expect(escalationAllowance(400, BUDGET)).toBe(80);
    expect(escalationAllowance(30, BUDGET)).toBe(6);
  });

  /**
   * A pattern that may not escalate even once cannot be verified at all — it
   * would be flagged for review before doing any work. The floor means the cap
   * constrains without ever blocking outright.
   */
  it("always allows at least one escalation", () => {
    expect(escalationAllowance(3, BUDGET)).toBe(1);
    expect(escalationAllowance(1, BUDGET)).toBe(1);
  });

  it("allows none for an empty plan", () => {
    expect(escalationAllowance(0, BUDGET)).toBe(0);
  });
});

describe("decideEscalation", () => {
  /**
   * The cap is measured against the PLANNED sample, not against probes
   * completed. A ratio against work done trips on the first probe — one
   * escalation out of one is 100% — so it would need an arbitrary warm-up
   * floor. Against the plan it is an absolute budget from the start.
   */
  it("allows the first escalation of a fresh sample", () => {
    const decision = decideEscalation(
      { probed: 1, escalated: 0, plannedSampleSize: 400 },
      BUDGET
    );

    expect(decision.kind).toBe("allow");
  });

  it("still allows when one probe of one has escalated", () => {
    const decision = decideEscalation(
      { probed: 1, escalated: 1, plannedSampleSize: 400 },
      BUDGET
    );

    // 1 of a 400-probe plan is obviously fine, though it is 100% of work done.
    expect(decision.kind).toBe("allow");
  });

  it("reports how much room is left", () => {
    const decision = decideEscalation(
      { probed: 100, escalated: 30, plannedSampleSize: 400 },
      BUDGET
    );

    expect(decision).toEqual({ kind: "allow", remaining: 50 });
  });

  /**
   * The failure this exists to catch: a pattern where everything looks
   * suspicious costs a HEAD plus a GET on every probe, quietly spending several
   * times the budget the run was given. The answer is not to escalate less —
   * each escalation is individually justified — but to notice the pattern is
   * not answerable cheaply and say so.
   */
  it("flags for review once the allowance is spent", () => {
    const decision = decideEscalation(
      { probed: 90, escalated: 80, plannedSampleSize: 400 },
      BUDGET
    );

    expect(decision).toEqual({
      kind: "flag_for_review",
      reason: "GET_ESCALATION_CAP",
      escalated: 80,
      allowed: 80
    });
  });

  it("stays flagged once past the allowance", () => {
    const decision = decideEscalation(
      { probed: 120, escalated: 95, plannedSampleSize: 400 },
      BUDGET
    );

    expect(decision.kind).toBe("flag_for_review");
  });

  /**
   * An empty plan is not a spent budget. Returning `flag_for_review` here sent
   * a human to look at a pattern with no sample and nothing to find.
   */
  it("says there is nothing to probe rather than flagging an empty plan", () => {
    expect(
      decideEscalation(
        { probed: 0, escalated: 0, plannedSampleSize: 0 },
        BUDGET
      )
    ).toEqual({ kind: "nothing_to_probe" });
  });

  it("honours a stricter budget", () => {
    const decision = decideEscalation(
      { probed: 50, escalated: 5, plannedSampleSize: 400 },
      { ...BUDGET, maxEscalationFraction: 0.01 }
    );

    // 1% of 400 is 4, already exceeded.
    expect(decision.kind).toBe("flag_for_review");
  });
});

describe("the body-fetch caps", () => {
  /**
   * Phase 0 checked the action plan's claim that GET bodies were unbounded and
   * found the opposite — legacy already caps them, and sends a Range header so
   * the server does not transmit more than is read. These are the ported
   * values; a soft-404 signal appears in the first few KB of markup and the
   * whole page is never needed.
   */
  it("bounds a soft-404 sniff to the first 64 KB", () => {
    expect(BUDGET.soft404BodyBytes).toBe(65_536);
  });

  it("bounds a method-fallback re-probe more tightly still", () => {
    // A method-rejection re-probe needs a status, not content.
    expect(BUDGET.methodFallbackBodyBytes).toBe(8_192);
    expect(BUDGET.methodFallbackBodyBytes).toBeLessThan(
      BUDGET.soft404BodyBytes
    );
  });
});

describe("escalationRate", () => {
  it("reports the share of probes that escalated", () => {
    expect(
      escalationRate({ probed: 100, escalated: 25, plannedSampleSize: 400 })
    ).toBe(0.25);
  });

  /**
   * Zero rather than NaN, so a fleet-wide average is not poisoned by patterns
   * that have not started — the M7 alert watches this figure.
   */
  it("reports zero for an unprobed pattern", () => {
    expect(
      escalationRate({ probed: 0, escalated: 0, plannedSampleSize: 400 })
    ).toBe(0);
  });
});

describe("estimatedRequestCost", () => {
  /**
   * "One check" is not one request. Treating it as one under-counts the
   * platform request budget by exactly however much escalation is happening,
   * which is the figure most likely to be high on a struggling site.
   */
  it("counts a HEAD plus a GET for every escalated probe", () => {
    expect(
      estimatedRequestCost({
        probed: 400,
        escalated: 80,
        plannedSampleSize: 400
      })
    ).toBe(480);
  });

  it("counts one request per probe when nothing escalated", () => {
    expect(
      estimatedRequestCost({
        probed: 400,
        escalated: 0,
        plannedSampleSize: 400
      })
    ).toBe(400);
  });
});
