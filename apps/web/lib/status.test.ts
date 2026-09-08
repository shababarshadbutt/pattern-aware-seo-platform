import { describe, expect, it } from "vitest";

import {
  confidenceBandTone,
  enforcementTone,
  fileParseStatusTone,
  patternStatusTone,
  runStatusTone,
  severityTone,
  siteActiveTone,
  sitemapFileTone,
  TONE_VAR,
  toolAvailabilityTone
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

describe("fileParseStatusTone", () => {
  it("separates a file we could not read from one deliberately skipped", () => {
    /**
     * The distinction is product logic, not shading. A `failed` file means the
     * run's pattern populations are SHORT by whatever it held, so its counts
     * are wrong rather than merely partial. `skipped` also undercounts, but
     * somebody chose it — a guard fired — so it warns instead of alarming.
     */
    expect(fileParseStatusTone("failed")).toBe("critical");
    expect(fileParseStatusTone("skipped")).toBe("warning");
    expect(fileParseStatusTone("skipped")).not.toBe("healthy");
  });

  it("does not report an in-flight file as healthy", () => {
    // No measurement yet is not a good result — the same rule the rest of
    // this file follows.
    expect(fileParseStatusTone("pending")).toBe("unknown");
    expect(fileParseStatusTone("downloading")).toBe("unknown");
    expect(fileParseStatusTone("parsing")).toBe("unknown");
    expect(fileParseStatusTone("parsed")).toBe("healthy");
  });
});

describe("sitemapFileTone", () => {
  it("refuses to call a parsed-but-empty file healthy", () => {
    /**
     * THE §1.5 CASE. An accepted file that yielded zero URLs is
     * indistinguishable from a legitimately empty one unless something says
     * so, and an HTML error page parses as valid, URL-less XML — which is how
     * M2 found this the first time. `parse_status` cannot express it, because
     * the parse genuinely succeeded, so the tone has to consider the count.
     */
    expect(sitemapFileTone("parsed", 0)).toBe("warning");
    expect(sitemapFileTone("parsed", 0)).not.toBe("healthy");
  });

  it("leaves a file that actually yielded URLs healthy", () => {
    expect(sitemapFileTone("parsed", 5700)).toBe("healthy");
  });

  it("does not let a zero count soften a real failure", () => {
    // A failed file has no URLs either, and it is still critical — the empty
    // check must not swallow the more serious state.
    expect(sitemapFileTone("failed", 0)).toBe("critical");
    expect(sitemapFileTone("pending", 0)).toBe("unknown");
  });
});

describe("enforcementTone", () => {
  it("warns about an unapplied limit without calling it a failure", () => {
    /**
     * The platform is not broken when a limit is inert — it is running on
     * defaults while a control someone set does nothing. And not `unknown`,
     * which means "no measurement": whether a limit is enforced is a fact this
     * codebase knows exactly.
     */
    expect(enforcementTone("not_enforced")).toBe("warning");
    expect(enforcementTone("not_enforced")).not.toBe("critical");
    expect(enforcementTone("not_enforced")).not.toBe("unknown");
    expect(enforcementTone("in_force")).toBe("healthy");
  });
});

describe("toolAvailabilityTone", () => {
  it("does not call an unbuilt capability a failure", () => {
    /**
     * The Tools grid renders seven cards this platform cannot offer. None of
     * them is a defect — they are capabilities deliberately never built — and
     * colouring them red reports a broken product to anyone who reads the grid
     * before the text. Same inversion `patternStatusTone` carries a warning
     * about, where a host refusing us was being called critical.
     */
    expect(toolAvailabilityTone("unavailable")).toBe("unknown");
    expect(toolAvailabilityTone("unavailable")).not.toBe("critical");
  });

  it("warns about a computation nothing in the pipeline runs", () => {
    // The expansion planner: real, tested, and never executed by a stage. A
    // reader about to act on it has to be caught, so it is not `healthy`.
    expect(toolAvailabilityTone("advisory")).toBe("warning");
    expect(toolAvailabilityTone("operational")).toBe("healthy");
  });
});
