import { describe, expect, it } from "vitest";

import {
  compareByImpact,
  scoreImpact,
  scorePatternImpact
} from "./impact-score.js";
import {
  classifyOutcome,
  MissingSeverityTableError,
  RATIFIED_SEVERITY_TABLE,
  type SeverityTable,
  severityFor
} from "./severity.js";
import { estimateStratified } from "./stratified-estimate.js";

const TABLE = RATIFIED_SEVERITY_TABLE;

function estimateFor(population: number, sampled: number, hits: number) {
  return estimateStratified([{ label: "all", population, sampled, hits }]);
}

describe("classifyOutcome", () => {
  it("classifies the statuses the severity table weights", () => {
    expect(classifyOutcome({ httpStatus: 410 })).toBe("gone");
    expect(classifyOutcome({ httpStatus: 404 })).toBe("not_found");
    expect(classifyOutcome({ httpStatus: 500 })).toBe("server_error");
    expect(classifyOutcome({ httpStatus: 503 })).toBe("server_error");
    expect(classifyOutcome({ httpStatus: 200 })).toBe("ok");
    expect(classifyOutcome({ httpStatus: 301 })).toBe("redirect_single");
    expect(classifyOutcome({ httpStatus: 301, redirectHops: 3 })).toBe(
      "redirect_chain"
    );
  });

  /**
   * A 200 whose body says "not found" is worse for index quality than a clean
   * 404, because the URL can stay indexed pointing at a useless page. The
   * status alone cannot tell you this — the body sniff can.
   */
  it("separates a soft 404 from a genuine 200", () => {
    expect(classifyOutcome({ httpStatus: 200, isSoft404: true })).toBe(
      "soft_not_found"
    );
    expect(classifyOutcome({ httpStatus: 200, isSoft404: false })).toBe("ok");
  });

  describe("refusals are not defects", () => {
    /**
     * THE distinction that keeps a WAF from turning a healthy client into a
     * P0. A 403 is both a status code and a refusal, and reading it as a
     * client error would score the site as broken on evidence that says only
     * "we were not allowed to look". Legacy migration 042 draws the same line.
     */
    it("classifies 403 and 429 as blocked, not as client errors", () => {
      expect(classifyOutcome({ httpStatus: 403 })).toBe("blocked");
      expect(classifyOutcome({ httpStatus: 429 })).toBe("blocked");
    });

    it("honours an explicit block regardless of status", () => {
      expect(classifyOutcome({ httpStatus: 404, isBlocked: true })).toBe(
        "blocked"
      );
    });

    it("does not invent a class when no status was obtained", () => {
      expect(classifyOutcome({ httpStatus: null })).toBe("unknown");
    });
  });
});

describe("severityFor", () => {
  /**
   * CLAUDE.md forbids guessing these weights, so there is no fallback to guess
   * with. A caller that forgets the table gets an error rather than a
   * plausible number that could quietly become the shipped answer.
   */
  it("refuses to score without a table", () => {
    expect(() => severityFor("not_found", undefined)).toThrow(
      MissingSeverityTableError
    );
  });

  it("refuses a table with a missing or non-finite weight", () => {
    const broken = { ...TABLE, not_found: Number.NaN } as SeverityTable;

    expect(() => severityFor("not_found", broken)).toThrow(
      MissingSeverityTableError
    );
  });

  // The ratified ordering (ADR-0014), asserted so a later edit to the table
  // cannot silently invert the product's priorities.
  it("ranks gone and not-found above everything else", () => {
    expect(TABLE.gone).toBe(1);
    expect(TABLE.not_found).toBe(1);
    expect(TABLE.soft_not_found).toBeLessThan(TABLE.not_found);
    expect(TABLE.server_error).toBeLessThan(TABLE.soft_not_found);
    expect(TABLE.redirect_chain).toBeLessThan(TABLE.server_error);
    expect(TABLE.redirect_single).toBeLessThan(TABLE.redirect_chain);
  });

  it("scores a healthy or unmeasured outcome at zero", () => {
    expect(TABLE.ok).toBe(0);
    expect(TABLE.blocked).toBe(0);
    expect(TABLE.unknown).toBe(0);
  });
});

describe("scoreImpact", () => {
  it("weights the estimate by severity", () => {
    // 60 of 400 probes 404 on a 90M pattern -> 13.5M affected, severity 1.0.
    const score = scoreImpact(
      {
        outcome: { httpStatus: 404 },
        estimate: estimateFor(90_000_000, 400, 60)
      },
      { severityTable: TABLE }
    );

    expect(score.severityClass).toBe("not_found");
    expect(score.estimatedAffectedUrls).toBe(13_500_000);
    expect(score.score).toBe(13_500_000);
  });

  /**
   * The reason severity exists at all: the same number of affected URLs is not
   * equally bad depending on what happened to them.
   */
  it("ranks equal URL counts by what went wrong", () => {
    const estimate = estimateFor(1_000_000, 400, 40);

    const gone = scoreImpact(
      { outcome: { httpStatus: 410 }, estimate },
      { severityTable: TABLE }
    );
    const redirect = scoreImpact(
      { outcome: { httpStatus: 301 }, estimate },
      { severityTable: TABLE }
    );

    expect(gone.estimatedAffectedUrls).toBe(redirect.estimatedAffectedUrls);
    expect(gone.score).toBeGreaterThan(redirect.score * 6);
  });

  /**
   * Ranking on the upper bound would put the least-understood patterns first,
   * exactly inverting the ordering — a wide interval means thin evidence, not
   * a big problem. The bounds ride along for display only.
   */
  it("scores on the point estimate and carries the bounds alongside", () => {
    const estimate = estimateFor(40_000, 30, 1);
    const score = scoreImpact(
      { outcome: { httpStatus: 404 }, estimate },
      { severityTable: TABLE }
    );

    expect(score.score).toBe(estimate.pointEstimate);
    expect(score.scoreLow).toBeLessThan(score.score);
    expect(score.scoreHigh).toBeGreaterThan(score.score);
  });

  it("scores a blocked probe at zero and says why", () => {
    const score = scoreImpact(
      {
        outcome: { httpStatus: 403 },
        estimate: estimateFor(90_000_000, 400, 400)
      },
      { severityTable: TABLE }
    );

    // Every probe refused. Scoring this as 90M affected URLs would make a
    // crawler-blocking client the worst site on the fleet.
    expect(score.score).toBe(0);
    expect(score.isAbsenceOfEvidence).toBe(true);
  });

  it("leaves the traffic hook inert by default", () => {
    const estimate = estimateFor(1_000_000, 400, 40);
    const plain = scoreImpact(
      { outcome: { httpStatus: 404 }, estimate },
      { severityTable: TABLE }
    );
    const weighted = scoreImpact(
      { outcome: { httpStatus: 404 }, estimate },
      { severityTable: TABLE, trafficMultiplier: 0.4 }
    );

    expect(weighted.score).toBeCloseTo(plain.score * 0.4, 6);
  });

  /**
   * The traffic hook could not actually have been used as first written.
   *
   * `impact_score` is stored, and `ck_audit_snapshot_impact_sane` requires it
   * not to exceed the estimate it weights — the number is in URL units, and a
   * score larger than the affected-URL count it derives from means nothing. A
   * multiplier of 2.5 on a 100,000-URL estimate produced 250,000 and the
   * database rejected the row. Found by probing the interaction between the
   * hook and the constraint, which neither one shows in isolation.
   */
  it("refuses a traffic multiplier that would exceed the estimate", () => {
    const estimate = estimateFor(1_000_000, 400, 40);

    expect(() =>
      scoreImpact(
        { outcome: { httpStatus: 404 }, estimate },
        { severityTable: TABLE, trafficMultiplier: 2.5 }
      )
    ).toThrow(RangeError);
  });

  it("keeps the score inside the estimate for every legal multiplier", () => {
    const estimate = estimateFor(1_000_000, 400, 40);

    for (const multiplier of [1, 0.9, 0.5, 0.01]) {
      const score = scoreImpact(
        { outcome: { httpStatus: 404 }, estimate },
        { severityTable: TABLE, trafficMultiplier: multiplier }
      );

      // Exactly what the database CHECK asserts.
      expect(score.score).toBeLessThanOrEqual(estimate.pointEstimate);
    }
  });
});

describe("scorePatternImpact", () => {
  /**
   * SUMMED, not maxed. A URL has exactly one status, so the sets behind each
   * finding are disjoint — 5,000 404s and 5,000 500s really is 10,000 broken
   * URLs, and taking the maximum would report half the damage.
   */
  it("sums disjoint findings", () => {
    const impact = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 404 },
          estimate: estimateFor(100_000, 400, 20)
        },
        {
          outcome: { httpStatus: 500 },
          estimate: estimateFor(100_000, 400, 20)
        }
      ],
      { severityTable: TABLE }
    );

    // 5,000 at 1.0 plus 5,000 at 0.8.
    expect(impact.totalScore).toBeCloseTo(5_000 + 4_000, 6);
  });

  it("reports the worst finding as well as the total", () => {
    const impact = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 301 },
          estimate: estimateFor(100_000, 400, 8)
        },
        {
          outcome: { httpStatus: 410 },
          estimate: estimateFor(100_000, 400, 40)
        }
      ],
      { severityTable: TABLE }
    );

    // 2,000 redirects at 0.15 = 300; 10,000 gone at 1.0 = 10,000.
    expect(impact.worstFinding?.severityClass).toBe("gone");
    // The total answers "how much is wrong here", the worst answers "what" —
    // a triage screen needs both.
    expect(impact.totalScore).toBeCloseTo(10_300, 6);
  });

  /**
   * `worstFinding` is the highest SCORE, not the highest severity class, and
   * that is deliberate rather than an accident of implementation.
   *
   * A pattern with 50,000 redirect chains genuinely does deserve attention
   * ahead of one with 200 gone pages, even though a 410 is individually worse
   * than a 301. Severity weights how bad each URL is; the score is what
   * decides where an analyst looks first, and volume is part of that. Pinned
   * because "worst" reads as "highest severity" and a future change might
   * quietly make it so.
   */
  it("lets volume outweigh severity when it genuinely should", () => {
    const impact = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 301, redirectHops: 3 },
          estimate: estimateFor(1_000_000, 400, 200)
        },
        {
          outcome: { httpStatus: 410 },
          estimate: estimateFor(1_000_000, 400, 1)
        }
      ],
      { severityTable: TABLE }
    );

    expect(impact.worstFinding?.severityClass).toBe("redirect_chain");
  });

  it("excludes refusals from the total", () => {
    const impact = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 404 },
          estimate: estimateFor(100_000, 400, 20)
        },
        {
          outcome: { httpStatus: 429 },
          estimate: estimateFor(100_000, 400, 380)
        }
      ],
      { severityTable: TABLE }
    );

    expect(impact.totalScore).toBeCloseTo(5_000, 6);
    expect(impact.isUnmeasured).toBe(false);
  });

  /**
   * "We could not look" and "we looked and it is fine" both score zero, and
   * they are different answers. A pattern behind a WAF must not read as
   * healthy.
   */
  it("distinguishes unmeasured from measured-and-clean", () => {
    const blocked = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 403 },
          estimate: estimateFor(100_000, 400, 400)
        }
      ],
      { severityTable: TABLE }
    );
    const clean = scorePatternImpact(
      [
        { outcome: { httpStatus: 200 }, estimate: estimateFor(100_000, 400, 0) }
      ],
      { severityTable: TABLE }
    );

    expect(blocked.totalScore).toBe(0);
    expect(clean.totalScore).toBe(0);
    expect(blocked.isUnmeasured).toBe(true);
    expect(clean.isUnmeasured).toBe(false);
  });

  it("handles a pattern with no findings", () => {
    const impact = scorePatternImpact([], { severityTable: TABLE });

    expect(impact.totalScore).toBe(0);
    expect(impact.worstFinding).toBeUndefined();
    expect(impact.isUnmeasured).toBe(false);
  });
});

describe("compareByImpact", () => {
  it("orders worst first", () => {
    const ranked = [
      { id: "b", totalScore: 100 },
      { id: "a", totalScore: 9_000 },
      { id: "c", totalScore: 500 }
    ].sort(compareByImpact);

    expect(ranked.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  /**
   * The ordering has to be total. Without a tie-break, two equally-scored
   * patterns could swap places between page loads and a reader would think
   * something had changed.
   */
  it("breaks ties deterministically", () => {
    const first = [
      { id: "z", totalScore: 10 },
      { id: "a", totalScore: 10 }
    ].sort(compareByImpact);
    const second = [
      { id: "a", totalScore: 10 },
      { id: "z", totalScore: 10 }
    ].sort(compareByImpact);

    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });
});
