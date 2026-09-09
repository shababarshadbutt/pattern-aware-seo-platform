import {
  appendSampleObservations,
  createOrganization,
  createSite,
  type Database,
  finishRun,
  insertAuditSnapshot,
  listPatternsByPopulation,
  listPatternsRanked,
  type OrganizationScope,
  recordPatternSample,
  type SiteScope,
  setPatternStatus,
  startRun,
  upsertPatterns
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import {
  compareByImpact,
  RATIFIED_SEVERITY_TABLE,
  scorePatternImpact
} from "@pattern-aware/sampling";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { rollUpPatternImpact } from "../src/findings.js";
import { resetOrgScopeCacheForTesting } from "../src/org-scope.js";

/**
 * The pattern explorer, against a real migrated Postgres.
 *
 * Its own harness rather than an extension of `routes.test.ts`, because the
 * assertions here are about counts, ordering and rollups over a deliberately
 * shaped set of patterns, and growing that file's shared fixture would silently
 * change totals a dozen unrelated assertions depend on.
 *
 * THE FIXTURE IS THE TEST. A single pattern with a single finding cannot
 * distinguish summing from maxing, cannot exercise a tie-break, and cannot tell
 * "nothing published" from "measured at zero" — so the seed builds one of each
 * of those cases on purpose.
 */

let harness: TestDatabase;
let app: ReturnType<typeof buildApp>;
let db: Database;

let ownScope: OrganizationScope;
let ownSite: SiteScope;
let runId = "";

/** Two findings, 410 and 500. Its total must be their SUM, not the larger. */
let twoFindingId = "";
/** One finding, a 200. Measured, and fine — a legitimate total of zero. */
let healthyId = "";
/** Sampled, but the host refused. Findings exist and none of them count. */
let blockedId = "";
/** No sample, no finding at all. NOT the same as a total of zero. */
let unsampledId = "";

/** A rival tenant, with a finding bigger than anything of ours. */
let otherSite: SiteScope;
let otherRunId = "";

const SLUG = `explorer-${Date.now()}`;

async function patternIdByTemplate(
  scope: SiteScope,
  scopedRunId: string,
  template: string
): Promise<string> {
  const patterns = await listPatternsByPopulation(db, scope, scopedRunId, 100);
  const match = patterns.find((row) => row.template === template);

  if (!match) {
    throw new Error(`fixture is missing the pattern ${template}`);
  }

  return match.id;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;

  const own = await createOrganization(db, { name: "Own", slug: SLUG });

  ownScope = own.scope;
  ownSite = (
    await createSite(db, ownScope, {
      name: "Own Site",
      baseUrl: "https://own.example"
    })
  ).scope;

  runId = (await startRun(db, ownSite, { workerId: "t" })).id;

  await upsertPatterns(db, ownSite, runId, [
    {
      template: "/two/{id}",
      segmentCount: 2,
      populationCount: 9000,
      fileCount: 1
    },
    {
      template: "/healthy/{id}",
      segmentCount: 2,
      populationCount: 8000,
      fileCount: 1
    },
    {
      template: "/blocked/{id}",
      segmentCount: 2,
      populationCount: 7000,
      fileCount: 1
    },
    {
      template: "/unsampled/{id}",
      segmentCount: 2,
      populationCount: 6000,
      fileCount: 1
    }
  ]);

  twoFindingId = await patternIdByTemplate(ownSite, runId, "/two/{id}");
  healthyId = await patternIdByTemplate(ownSite, runId, "/healthy/{id}");
  blockedId = await patternIdByTemplate(ownSite, runId, "/blocked/{id}");
  unsampledId = await patternIdByTemplate(ownSite, runId, "/unsampled/{id}");

  await setPatternStatus(db, ownSite, twoFindingId, "measured");
  await setPatternStatus(db, ownSite, healthyId, "measured");
  await setPatternStatus(db, ownSite, blockedId, "blocked", "WAF refused HEAD");

  const twoSample = await recordPatternSample(db, ownSite, {
    patternId: twoFindingId,
    sitemapRunId: runId,
    kRequested: 40,
    kThresholdHash: 1,
    sampleSize: 40,
    populationAtDraw: 9000
  });

  // Gone: weight 1.0 in the ratified table, so its score equals its estimate.
  await insertAuditSnapshot(db, ownSite, {
    patternId: twoFindingId,
    patternSampleId: twoSample.id,
    sitemapRunId: runId,
    httpStatus: 410,
    evidenceTier: "estimated",
    observedCount: 8,
    sampleSize: 40,
    populationCount: 9000,
    pointEstimate: 1800,
    ciLow: 1000,
    ciHigh: 2600,
    confidenceLevel: 0.95,
    confidenceBand: "approximate",
    estimatorVersion: "1.0.0",
    severityClass: "gone",
    severityWeight: 1,
    impactScore: 1800
  });

  await insertAuditSnapshot(db, ownSite, {
    patternId: twoFindingId,
    patternSampleId: twoSample.id,
    sitemapRunId: runId,
    httpStatus: 500,
    evidenceTier: "estimated",
    observedCount: 4,
    sampleSize: 40,
    populationCount: 9000,
    pointEstimate: 900,
    ciLow: 400,
    ciHigh: 1400,
    /*
     * A WIDER band than its sibling, on purpose. The rollup must report the
     * widest band any contributing finding carried — a sum is only as precise
     * as its least precise part — so a fixture where both read `approximate`
     * would let a "take the first band" bug pass unnoticed.
     */
    confidenceLevel: 0.95,
    confidenceBand: "low",
    estimatorVersion: "1.0.0",
    severityClass: "server_error",
    severityWeight: 0.8,
    impactScore: 720
  });

  await appendSampleObservations(db, ownSite, [
    {
      patternId: twoFindingId,
      patternSampleId: twoSample.id,
      urlHash: 1,
      url: "https://own.example/two/1",
      httpStatus: 410,
      methodUsed: "HEAD"
    },
    {
      patternId: twoFindingId,
      patternSampleId: twoSample.id,
      urlHash: 2,
      url: "https://own.example/two/2",
      httpStatus: 500,
      methodUsed: "HEAD"
    }
  ]);

  const healthySample = await recordPatternSample(db, ownSite, {
    patternId: healthyId,
    sitemapRunId: runId,
    kRequested: 30,
    kThresholdHash: 1,
    sampleSize: 30,
    populationAtDraw: 8000
  });

  await insertAuditSnapshot(db, ownSite, {
    patternId: healthyId,
    patternSampleId: healthySample.id,
    sitemapRunId: runId,
    httpStatus: 200,
    evidenceTier: "estimated",
    observedCount: 30,
    sampleSize: 30,
    populationCount: 8000,
    pointEstimate: 8000,
    ciLow: 7800,
    ciHigh: 8000,
    confidenceLevel: 0.95,
    confidenceBand: "confident",
    estimatorVersion: "1.0.0",
    // `ok` carries weight 0 — counted, and contributing nothing.
    severityClass: "ok",
    severityWeight: 0,
    impactScore: 0
  });

  const blockedSample = await recordPatternSample(db, ownSite, {
    patternId: blockedId,
    sitemapRunId: runId,
    kRequested: 30,
    kThresholdHash: 1,
    sampleSize: 30,
    populationAtDraw: 7000
  });

  await insertAuditSnapshot(db, ownSite, {
    patternId: blockedId,
    patternSampleId: blockedSample.id,
    sitemapRunId: runId,
    httpStatus: 403,
    evidenceTier: "blocked",
    /*
     * ZERO OBSERVED, because the schema will not accept anything else:
     * `ck_audit_snapshot_evidence_tier_matches_coverage` requires a blocked
     * claim to carry `observed_count = 0` and `point_estimate = 0`. A refusal
     * means the host would not let us look, so there is nothing observed to
     * report — the first draft of this fixture said 30 and the database
     * correctly refused it.
     */
    observedCount: 0,
    sampleSize: 30,
    populationCount: 7000,
    pointEstimate: 0,
    ciLow: 0,
    ciHigh: 7000,
    confidenceLevel: 0.95,
    confidenceBand: "low",
    estimatorVersion: "1.0.0",
    severityClass: "blocked",
    severityWeight: 0,
    impactScore: 0
  });

  await finishRun(db, ownSite, runId, { status: "complete" });

  const other = await createOrganization(db, {
    name: "Other",
    slug: `${SLUG}-other`
  });

  otherSite = (
    await createSite(db, other.scope, {
      name: "Other Site",
      baseUrl: "https://other.example"
    })
  ).scope;

  otherRunId = (await startRun(db, otherSite, { workerId: "t" })).id;

  await upsertPatterns(db, otherSite, otherRunId, [
    {
      template: "/secret/{id}",
      segmentCount: 2,
      populationCount: 999_999,
      fileCount: 1
    }
  ]);

  const otherPatternId = await patternIdByTemplate(
    otherSite,
    otherRunId,
    "/secret/{id}"
  );

  const otherSample = await recordPatternSample(db, otherSite, {
    patternId: otherPatternId,
    sitemapRunId: otherRunId,
    kRequested: 30,
    kThresholdHash: 1,
    sampleSize: 30,
    populationAtDraw: 999_999
  });

  /*
   * BIGGER than anything of ours, deliberately. Both sort orders rank
   * worst-first, so a missing tenant filter puts this at position one — the
   * first row anyone would see, rather than something a page boundary hides.
   */
  await insertAuditSnapshot(db, otherSite, {
    patternId: otherPatternId,
    patternSampleId: otherSample.id,
    sitemapRunId: otherRunId,
    httpStatus: 404,
    evidenceTier: "estimated",
    observedCount: 20,
    sampleSize: 30,
    populationCount: 999_999,
    pointEstimate: 666_666,
    ciLow: 500_000,
    ciHigh: 800_000,
    confidenceLevel: 0.95,
    confidenceBand: "approximate",
    estimatorVersion: "1.0.0",
    severityClass: "not_found",
    severityWeight: 1,
    impactScore: 666_666
  });

  await finishRun(db, otherSite, otherRunId, { status: "complete" });

  app = buildApp(
    {
      NODE_ENV: "test",
      DEFAULT_ORGANIZATION_SLUG: SLUG,
      ...loadPolicyConfig({})
    },
    createLogger({ service: "explorer-test", level: "silent", pretty: false }),
    db
  );
});

afterAll(async () => {
  await app.close();
  await harness.destroy();
  resetOrgScopeCacheForTesting();
});

interface ServedPattern {
  readonly id: string;
  readonly status: string;
  readonly findingCount: number;
  readonly worstHttpStatus?: number;
  readonly worstSeverityClass?: string;
  readonly impact?: {
    readonly evidenceTier: string;
    readonly pointEstimate: number;
    readonly ciLow: number;
    readonly ciHigh: number;
    readonly observedCount: number;
    readonly impactScore: number;
    readonly impactLow: number;
    readonly impactHigh: number;
    readonly confidenceBand: string;
    readonly populationCount: number;
    readonly countedFindings: number;
  };
}

interface ServedBody {
  readonly patterns: readonly ServedPattern[];
  readonly total: number;
  readonly observedUrls: number;
  readonly statusCounts: readonly unknown[];
}

async function fetchPatterns(query = ""): Promise<{
  readonly statusCode: number;
  readonly body: ServedBody;
}> {
  const response = await app.inject({
    method: "GET",
    url: `/sites/${ownSite.siteId}/patterns${query}`
  });

  return {
    statusCode: response.statusCode,
    body: response.json() as ServedBody
  };
}

function pick(body: ServedBody, id: string): ServedPattern {
  const match = body.patterns.find((row) => row.id === id);

  if (!match) {
    throw new Error(`the response did not carry the pattern ${id}`);
  }

  return match;
}

describe("the pattern explorer", () => {
  it("sums a pattern's findings rather than taking the worst", async () => {
    /**
     * 1800 + 720, not 1800. A URL has exactly one status, so the URL sets
     * behind each finding are disjoint and adding them double-counts nothing;
     * maxing would report half the damage. This is the assertion a
     * one-finding fixture cannot make.
     */
    const { body } = await fetchPatterns("?sort=impact");
    const two = pick(body, twoFindingId);

    expect(two.findingCount).toBe(2);
    expect(two.impact?.impactScore).toBeCloseTo(2520, 6);
    expect(two.impact?.impactLow).toBeCloseTo(1000 * 1 + 400 * 0.8, 6);
    expect(two.impact?.impactHigh).toBeCloseTo(2600 * 1 + 1400 * 0.8, 6);
  });

  it("carries affected URLs separately from weighted impact", async () => {
    /**
     * They diverge exactly when a weight is not 1.0, which is why both columns
     * exist. The 410 is stored at weight 1.0 and the 500 at 0.8, so:
     *   affected = 1800 + 900          = 2700
     *   impact   = 1800*1.0 + 900*0.8  = 2520
     * A screen showing only the second answers the ranking question and leaves
     * "how many URLs is this" unanswered.
     */
    const { body } = await fetchPatterns("?sort=impact");
    const two = pick(body, twoFindingId);

    expect(two.impact?.pointEstimate).toBeCloseTo(2700, 6);
    expect(two.impact?.impactScore).toBeCloseTo(2520, 6);
    expect(two.impact?.pointEstimate).not.toBeCloseTo(
      two.impact?.impactScore ?? 0,
      6
    );
  });

  it("never reports more affected URLs than the population holds", async () => {
    /**
     * Summing per-finding upper bounds is the conservative choice, and several
     * wide intervals can add past N. "Affected: more URLs than exist" is a
     * figure no reader can act on, so the bounds clamp to the population.
     */
    const { body } = await fetchPatterns();

    for (const row of body.patterns) {
      if (row.impact) {
        expect(row.impact.ciHigh).toBeLessThanOrEqual(
          row.impact.populationCount
        );
        expect(row.impact.ciLow).toBeLessThanOrEqual(
          row.impact.populationCount
        );
      }
    }
  });

  it("does not count healthy URLs as affected", async () => {
    /**
     * THE DEFECT A SCREENSHOT CAUGHT AND NO TEST HAD. `/healthy` is 8,000 URLs
     * all returning 200, and its `ok` finding estimates 8,000 of them. Folding
     * `ok` into the affected sum reported "Affected 8,000" in a triage column
     * for a pattern with nothing wrong — and on a pattern with both statuses it
     * would have added healthy URLs to the broken ones.
     *
     * It is still MEASURED, though: zero, not "not measured". A pattern whose
     * only finding is `ok` has been looked at and found fine, which is a
     * different fact from a host that refused us.
     */
    const { body } = await fetchPatterns();
    const healthy = pick(body, healthyId);

    expect(healthy.impact).toBeDefined();
    expect(healthy.impact?.evidenceTier).not.toBe("blocked");
    expect(healthy.impact?.pointEstimate).toBe(0);
    expect(healthy.impact?.impactScore).toBe(0);
    expect(healthy.impact?.countedFindings).toBe(0);
  });

  it("reports the widest band any contributing finding carried", async () => {
    // `approximate` + `low` must roll up as `low`: a sum is only as precise as
    // its least precise part, and reporting the narrower one overstates it.
    const { body } = await fetchPatterns("?sort=impact");
    const two = pick(body, twoFindingId);

    expect(two.impact?.confidenceBand).toBe("low");
    expect(two.impact?.evidenceTier).toBe("estimated");
  });

  it("names the worst finding separately from the total", async () => {
    // The total answers "how much is wrong here"; the worst answers "what is
    // wrong here". A triage row needs both, and 410 outranks 500 on score.
    const { body } = await fetchPatterns("?sort=impact");
    const two = pick(body, twoFindingId);

    expect(two.worstHttpStatus).toBe(410);
    expect(two.worstSeverityClass).toBe("gone");
  });

  it("keeps nothing-published, all-blocked and measured-at-zero apart", async () => {
    /**
     * THE SECTION 1.5 CASE, in three parts. A pattern nothing published, a
     * pattern whose every finding is an absence of evidence, and a pattern
     * genuinely measured at zero all render as "0" unless the API keeps them
     * distinct — and collapsing the middle into the last reports a host
     * refusing us as a clean bill of health.
     */
    const { body } = await fetchPatterns();

    expect(pick(body, unsampledId).impact).toBeUndefined();

    const blocked = pick(body, blockedId);
    expect(blocked.findingCount).toBe(1);
    expect(blocked.impact?.evidenceTier).toBe("blocked");
    expect(blocked.impact?.countedFindings).toBe(0);

    const healthy = pick(body, healthyId);
    expect(healthy.findingCount).toBe(1);
    // A finding exists and it is a measurement, so NOT the blocked tier — but
    // it carries no damage, so it contributes nothing. See the case below.
    expect(healthy.impact?.countedFindings).toBe(0);
    expect(healthy.impact?.impactScore).toBe(0);
    expect(healthy.impact?.evidenceTier).not.toBe("blocked");
  });

  it("keeps a pattern with no finding in the list at all", async () => {
    // The LEFT JOIN, asserted. An inner join would drop exactly the patterns a
    // triage screen exists to surface, and the table would look healthy.
    const { body } = await fetchPatterns("?sort=impact");

    expect(body.patterns.map((row) => row.id)).toContain(unsampledId);
  });

  it("orders exactly as compareByImpact would", async () => {
    /**
     * The SQL ordering and `packages/sampling`'s documented total order are two
     * statements of one rule — worst score first, ties broken on id so a reader
     * never sees two rows swap between page loads. Asserted rather than assumed
     * because the paging happens in SQL while the rule lives in TypeScript.
     */
    const { body } = await fetchPatterns("?sort=impact");
    const returned = body.patterns.map((row) => ({
      id: row.id,
      totalScore: row.impact?.impactScore ?? 0
    }));

    expect(returned).toEqual([...returned].sort(compareByImpact));
  });

  it("agrees with scorePatternImpact where the stored weights still match", () => {
    /**
     * `rollUpPatternImpact` deliberately does NOT call `scorePatternImpact` —
     * that function re-derives the weight from the table in force NOW, while a
     * stored claim carries the weight that was in force when it was published
     * (ADR-0014). The two must still agree wherever those coincide, or the
     * duplication has drifted into a second, quieter answer.
     *
     * The `gone` finding alone, because `gone` weighs 1.0 in the ratified table
     * and the fixture stored 1.0 for it. The 500 is stored at 0.8, which is
     * exactly the caveat above, and is excluded on purpose.
     */
    const viaSampling = scorePatternImpact(
      [
        {
          outcome: { httpStatus: 410, isSoft404: false },
          estimate: {
            pointEstimate: 1800,
            ciLow: 1000,
            ciHigh: 2600
          }
        }
      ] as unknown as Parameters<typeof scorePatternImpact>[0],
      { severityTable: RATIFIED_SEVERITY_TABLE }
    );

    const viaRollup = rollUpPatternImpact([
      {
        impactScore: 1800,
        ciLow: 1000,
        ciHigh: 2600,
        severityWeight: 1,
        severityClass: "gone",
        evidenceTier: "estimated",
        confidenceBand: "approximate",
        sampleSize: 40,
        populationCount: 9000
      } as unknown as Parameters<typeof rollUpPatternImpact>[0][number]
    ]);

    expect(viaRollup?.impactScore).toBeCloseTo(viaSampling.totalScore, 6);
    expect(viaRollup?.impactLow).toBeCloseTo(viaSampling.totalScoreLow, 6);
    expect(viaRollup?.impactHigh).toBeCloseTo(viaSampling.totalScoreHigh, 6);
  });

  it("agrees with the SQL sum it is paged by", async () => {
    /**
     * Two sources for one number: SQL sums `impact_score` to order and page,
     * and the rollup sums it again to render with bounds. If they disagree the
     * table is ordered by one figure and labelled with another, and no screen
     * could reveal it. `rankScore` never leaves the API, so this is the only
     * place the two can be compared at all.
     */
    const ranked = await listPatternsRanked(db, ownSite, runId, {
      sort: "impact"
    });
    const { body } = await fetchPatterns("?sort=impact");

    expect(ranked.length).toBeGreaterThan(0);

    for (const row of ranked) {
      expect(pick(body, row.id).impact?.impactScore ?? 0).toBeCloseTo(
        row.rankScore,
        6
      );
    }
  });

  it("never puts the bare rank score on the wire", async () => {
    // A summed point value with no interval. Shipping it would hand a screen a
    // sampled figure it could render bare, which ADR-0008 forbids.
    const { body } = await fetchPatterns("?sort=impact");

    expect(JSON.stringify(body)).not.toContain("rankScore");
  });

  it("counts the whole run, not the page", async () => {
    // The D3a defect: a card that sums the visible rows and calls it the run.
    // A page of one must still report four.
    const { body } = await fetchPatterns("?limit=1");

    expect(body.patterns).toHaveLength(1);
    expect(body.total).toBe(4);
  });

  it("lets the status filter reach the total as well as the rows", async () => {
    // Otherwise the footer describes a different collection from the table.
    const { body } = await fetchPatterns("?status=measured");

    expect(body.total).toBe(2);
    expect(body.patterns.every((row) => row.status === "measured")).toBe(true);
  });

  it("pages without repeating or dropping a row", async () => {
    const first = await fetchPatterns("?sort=impact&limit=2&offset=0");
    const second = await fetchPatterns("?sort=impact&limit=2&offset=2");
    const ids = [...first.body.patterns, ...second.body.patterns].map(
      (row) => row.id
    );

    expect(new Set(ids).size).toBe(4);
  });

  it("refuses a limit above the cap rather than serving it", async () => {
    // ADR-0028: a result set not bounded by the URL is validated and capped at
    // the edge rather than trusted.
    const { statusCode } = await fetchPatterns("?limit=5000");

    expect(statusCode).toBe(400);
  });

  it("reports counted run figures the cards can carry", async () => {
    const { body } = await fetchPatterns();

    // Two observations were appended; both are probes, and both are counted.
    expect(body.observedUrls).toBe(2);
    expect(body.statusCounts.length).toBeGreaterThan(0);
  });

  it("does not serve another organization's patterns", async () => {
    /**
     * Confirmed load-bearing by removing `assertSiteInOrg` from the route: it
     * then answers 200 with `/secret/{id}` ranked first, because every
     * repository beneath filters on `site_id` alone — correctly, since a
     * `SiteScope` is supposed to have been vouched for already. THE LAYER
     * NEUTRALISED IS THE ROUTE'S MEMBERSHIP CHECK.
     *
     * The rival's rows are asserted to EXIST before the isolation assertion, so
     * this cannot pass against an empty table the way an earlier isolation case
     * in this repo silently did.
     */
    const rivalRows = await listPatternsRanked(db, otherSite, otherRunId, {
      sort: "impact"
    });

    expect(rivalRows.length).toBeGreaterThan(0);
    expect(rivalRows[0]?.rankScore).toBeGreaterThan(0);

    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}/patterns`
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain("/secret/{id}");
  });
});
