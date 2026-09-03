import { describe, expect, it } from "vitest";

import {
  confidenceBandTone,
  patternStatusTone,
  runStatusTone,
  severityTone,
  siteActiveTone,
  TONE_VAR
} from "./status";

/**
 * The status classifiers.
 *
 * Pure display logic, and the standards require it tested for the same reason
 * the legacy frontend extracted its own: a status mapped to the wrong tone is
 * a wrong statement about a client's site rendered in the most confident
 * possible way, and it is invisible to a typecheck.
 */

describe("runStatusTone", () => {
  it("separates a finished run from one still in flight", () => {
    expect(runStatusTone("complete")).toBe("healthy");
    expect(runStatusTone("degraded")).toBe("warning");
    expect(runStatusTone("running")).toBe("unknown");
    expect(runStatusTone("pending")).toBe("unknown");
    expect(runStatusTone("failed")).toBe("critical");
    expect(runStatusTone("cancelled")).toBe("critical");
  });

  it("never calls a degraded run healthy", () => {
    /**
     * A degraded run produced honest numbers over partial coverage. Showing it
     * as healthy would let a run that measured a fraction of the site read as
     * a complete audit — the distinction `finalize` exists to record.
     */
    expect(runStatusTone("degraded")).not.toBe("healthy");
  });
});

describe("patternStatusTone", () => {
  it("does not treat an absence of measurement as a defect", () => {
    /**
     * `blocked` is a host refusing us and `needs_review` is a sampling
     * decision; neither means the pattern is broken. Rendering either as
     * critical would let a WAF turn a healthy client into a P0 — the exact
     * inversion the enum comment in schema/enums.ts warns about.
     */
    expect(patternStatusTone("blocked")).not.toBe("critical");
    expect(patternStatusTone("needs_review")).not.toBe("critical");
    expect(patternStatusTone("measured")).toBe("healthy");
  });

  it("maps the unsampled states to unknown rather than to bad news", () => {
    expect(patternStatusTone("unsampled")).toBe("unknown");
    expect(patternStatusTone("sampling")).toBe("unknown");
  });
});

describe("confidenceBandTone", () => {
  it("renders low confidence as unknown, never as critical", () => {
    /**
     * THE ADR-0008 CLAIM, asserted. A wide interval is an absence of evidence,
     * not bad news about the site: `--status-unknown` is documented in the
     * palette as "insufficient sampling confidence" and is what the low band
     * was defined for. Critical here would tell an analyst a thinly-sampled
     * pattern is a problem, when the honest reading is "sample it harder".
     */
    expect(confidenceBandTone("low")).toBe("unknown");
    expect(confidenceBandTone("low")).not.toBe("critical");
  });

  it("grades the usable bands", () => {
    expect(confidenceBandTone("confident")).toBe("healthy");
    expect(confidenceBandTone("approximate")).toBe("warning");
  });
});

describe("severityTone", () => {
  it("scores a refusal and an unclassifiable outcome as no evidence", () => {
    // Matches RATIFIED_SEVERITY_TABLE, where both weigh zero: "we could not
    // look" and "we looked and it is fine" are different answers, and neither
    // is damage.
    expect(severityTone("blocked")).toBe("unknown");
    expect(severityTone("unknown")).toBe("unknown");
    expect(severityTone("ok")).toBe("healthy");
  });

  it("ranks gone and not-found above a single redirect", () => {
    // ADR-0014 put 410/404 highest; a one-hop redirect is a nuisance.
    expect(severityTone("gone")).toBe("critical");
    expect(severityTone("not_found")).toBe("critical");
    expect(severityTone("redirect_single")).not.toBe("critical");
  });
});

describe("siteActiveTone", () => {
  it("distinguishes an active site from a paused one", () => {
    expect(siteActiveTone(true)).toBe("healthy");
    expect(siteActiveTone(false)).toBe("unknown");
  });
});

describe("TONE_VAR", () => {
  it("resolves every tone to a defined design token", () => {
    /**
     * A missing entry yields `undefined`, which React drops silently — the
     * badge renders with inherited colour and looks deliberate. Checked
     * against the token names, since a typo here is invisible at runtime.
     */
    for (const tone of ["healthy", "warning", "critical", "unknown"] as const) {
      expect(TONE_VAR[tone]).toMatch(/^var\(--status-[a-z]+\)$/u);
    }
  });
});
