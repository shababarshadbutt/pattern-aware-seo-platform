import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { internalDatabase } from "./client.js";
import { InvalidPartitionKeyError, partitionName } from "./partitions.js";
import { pgConstraintName } from "./pg-errors.js";
import { createOrganization } from "./repositories/organization.js";
import { upsertPatterns } from "./repositories/pattern.js";
import { createSite, InvalidSiteUrlError } from "./repositories/site.js";
import {
  ActiveRunExistsError,
  finishRun,
  startRun
} from "./repositories/sitemap-run.js";
import type { SiteScope } from "./scope.js";
import { createTestDatabase, type TestDatabase } from "./test-harness.js";

let harness: TestDatabase;
let siteScope: SiteScope;
let runId: string;
let patternId: string;
let sampleId: string;

beforeAll(async () => {
  harness = await createTestDatabase();

  const org = await createOrganization(harness.db, {
    name: "Constraint Fixtures",
    slug: "fixtures"
  });

  const created = await createSite(harness.db, org.scope, {
    name: "Fixture Site",
    baseUrl: "https://fixtures.test"
  });

  siteScope = created.scope;
  runId = (await startRun(harness.db, siteScope, { workerId: "test" })).id;

  await upsertPatterns(harness.db, siteScope, runId, [
    {
      template: "/x/{param}",
      segmentCount: 2,
      populationCount: 40_000,
      fileCount: 1
    }
  ]);

  const db = internalDatabase(harness.db);

  const patternRow = await db.execute<{ id: string }>(sql`
    select id from pattern where site_id = ${siteScope.siteId} limit 1
  `);

  patternId = patternRow.rows[0]?.id ?? "";

  const sampleRow = await db.execute<{ id: string }>(sql`
    insert into pattern_sample
      (site_id, pattern_id, sitemap_run_id, k_requested, k_threshold_hash,
       sample_size, population_at_draw)
    values (${siteScope.siteId}, ${patternId}, ${runId}, 400, 123456, 30, 40000)
    returning id
  `);

  sampleId = sampleRow.rows[0]?.id ?? "";
}, 60_000);

afterAll(async () => {
  await harness?.destroy();
});

/**
 * Assert that a statement was rejected by one specific constraint.
 *
 * Matching on the error message would not work: Drizzle wraps driver errors and
 * its message is the SQL text, so `toThrow(/ck_.../)` passes or fails for the
 * wrong reasons. Naming the constraint also makes the test fail loudly if a
 * DIFFERENT constraint catches the row first — which would mean the guard under
 * test is not the one doing the work.
 */
async function expectRejectedBy(
  statement: Promise<unknown>,
  constraint: string
): Promise<void> {
  try {
    await statement;
  } catch (error) {
    expect(pgConstraintName(error)).toBe(constraint);

    return;
  }

  throw new Error(
    `expected ${constraint} to reject the statement, but it succeeded`
  );
}

/** Insert an audit_snapshot with the given overrides applied to a valid base row. */
async function insertSnapshot(overrides: {
  observedCount?: number;
  sampleSize?: number;
  populationCount?: number;
  pointEstimate?: number;
  ciLow?: number;
  ciHigh?: number;
  evidenceTier?: "counted" | "estimated" | "blocked";
  severityClass?: string;
  severityWeight?: string;
  impactScore?: number;
}): Promise<void> {
  const v = {
    observedCount: 1,
    sampleSize: 30,
    populationCount: 40_000,
    pointEstimate: 1_333,
    ciLow: 200,
    ciHigh: 6_800,
    evidenceTier: "estimated" as const,
    severityClass: "not_found",
    severityWeight: "1.000",
    ...overrides
  };

  /**
   * Impact defaults to the estimate weighted at 1.0, AFTER overrides are
   * applied. Pinning it to a literal meant that overriding `pointEstimate`
   * left an impact score larger than the estimate it weights, so
   * `ck_audit_snapshot_impact_sane` rejected the row before the constraint the
   * test was actually aiming at ever got a chance.
   */
  const impactScore = overrides.impactScore ?? v.pointEstimate;

  await internalDatabase(harness.db).execute(sql`
    insert into audit_snapshot
      (site_id, pattern_id, pattern_sample_id, sitemap_run_id, http_status,
       evidence_tier, observed_count, sample_size, population_count,
       point_estimate, ci_low, ci_high, confidence_band, estimator_version,
       severity_class, severity_weight, impact_score)
    values
      (${siteScope.siteId}, ${patternId}, ${sampleId}, ${runId}, 404,
       ${v.evidenceTier}, ${v.observedCount}, ${v.sampleSize}, ${v.populationCount},
       ${v.pointEstimate}, ${v.ciLow}, ${v.ciHigh}, 'approximate', 'test-1',
       ${v.severityClass}, ${v.severityWeight}, ${impactScore})
  `);
}

describe("the degenerate-interval guard", () => {
  /**
   * THE defect Phase 0 found in the legacy estimator, now structurally
   * impossible.
   *
   * Legacy computes a normal half-width of `1.96 * sqrt(variance)`; with zero
   * observed hits the variance is zero, so the interval collapses to [0, 0] and
   * the product reports certainty that a 40,000-URL pattern has no 404s on the
   * strength of 30 probes. The action plan lists detecting this as the
   * highest-value paging alert in the system. A CHECK constraint is strictly
   * better than an alert: the row cannot be written at all, so the failure lands
   * in a test run rather than in a client-facing number.
   */
  it("rejects a zero-width interval from a partial sample", async () => {
    await expectRejectedBy(
      insertSnapshot({
        observedCount: 0,
        pointEstimate: 0,
        ciLow: 0,
        ciHigh: 0
      }),
      "ck_audit_snapshot_no_degenerate_interval"
    );
  });

  /**
   * ...but n = N is exactly when the interval SHOULD collapse: that population
   * was counted, not estimated. Wilson bounds with the finite-population
   * correction do this by construction (ADR-0001), so the constraint has to
   * allow it or the correct answer would be unwritable.
   */
  it("allows a zero-width interval when the sample covered the population", async () => {
    await expect(
      insertSnapshot({
        evidenceTier: "counted",
        observedCount: 7,
        sampleSize: 40_000,
        populationCount: 40_000,
        pointEstimate: 7,
        ciLow: 7,
        ciHigh: 7
      })
    ).resolves.toBeUndefined();
  });

  it("accepts an ordinary estimate with a real interval", async () => {
    await expect(insertSnapshot({})).resolves.toBeUndefined();
  });
});

describe("the evidence-tier contract", () => {
  // ADR-0008 enforced at storage rather than left to the component layer.
  it("refuses to call a partial sample 'counted'", async () => {
    await expectRejectedBy(
      insertSnapshot({
        evidenceTier: "counted",
        sampleSize: 30,
        populationCount: 40_000
      }),
      "ck_audit_snapshot_evidence_tier_matches_coverage"
    );
  });

  it("refuses a 'blocked' claim that smuggles in a number", async () => {
    await expectRejectedBy(
      insertSnapshot({
        evidenceTier: "blocked",
        observedCount: 0,
        pointEstimate: 900
      }),
      "ck_audit_snapshot_evidence_tier_matches_coverage"
    );
  });

  it("rejects an interval that does not contain its own point estimate", async () => {
    await expectRejectedBy(
      insertSnapshot({ pointEstimate: 9_000, ciLow: 200, ciHigh: 6_800 }),
      "ck_audit_snapshot_interval_contains_estimate"
    );
  });

  it("rejects more hits than probes", async () => {
    await expectRejectedBy(
      insertSnapshot({ observedCount: 31, sampleSize: 30 }),
      "ck_audit_snapshot_counts_sane"
    );
  });
});

describe("the impact score", () => {
  /**
   * THE guard that keeps a WAF from producing a P0.
   *
   * `blocked` means the host refused us, so there is no evidence of anything.
   * A blocked claim carrying a non-zero impact score would put a
   * crawler-blocking but perfectly healthy client at the top of the triage
   * queue — the most misleading thing this product could do.
   */
  it("refuses impact on a blocked outcome", async () => {
    // Deliberately an otherwise-ordinary estimated row: a `blocked` evidence
    // TIER already forces point_estimate to zero, so it could not carry impact
    // even without this guard. The guard exists for the case where the tier
    // looks normal and only the severity class says the host refused us.
    await expectRejectedBy(
      insertSnapshot({ severityClass: "blocked", impactScore: 500 }),
      "ck_audit_snapshot_refusal_has_no_impact"
    );
  });

  it("refuses impact on an unclassifiable outcome", async () => {
    await expectRejectedBy(
      insertSnapshot({ severityClass: "unknown", impactScore: 500 }),
      "ck_audit_snapshot_refusal_has_no_impact"
    );
  });

  it("refuses impact on a healthy outcome", async () => {
    await expectRejectedBy(
      insertSnapshot({ severityClass: "ok", impactScore: 500 }),
      "ck_audit_snapshot_refusal_has_no_impact"
    );
  });

  // Impact is the estimate WEIGHTED, so it can never exceed it: a weight above
  // one would be inventing affected URLs that were never estimated.
  it("refuses an impact score above the estimate it weights", async () => {
    await expectRejectedBy(
      insertSnapshot({
        pointEstimate: 1_000,
        ciHigh: 6_800,
        impactScore: 5_000
      }),
      "ck_audit_snapshot_impact_sane"
    );
  });

  it("refuses a severity weight outside [0, 1]", async () => {
    await expectRejectedBy(
      insertSnapshot({ severityWeight: "1.500" }),
      "ck_audit_snapshot_impact_sane"
    );
  });

  it("accepts a properly weighted finding", async () => {
    await expect(
      insertSnapshot({
        severityClass: "server_error",
        severityWeight: "0.800",
        impactScore: 1_066
      })
    ).resolves.toBeUndefined();
  });
});

describe("one active run per site", () => {
  /**
   * Enforced by a partial unique index rather than a check-then-insert, because
   * losing that race means two runs pointing traffic at the same origin — a
   * doubled request rate at somebody else's production web server, which is the
   * single outcome the sampling design exists to avoid.
   */
  it("refuses a second in-flight run", async () => {
    await expect(
      startRun(harness.db, siteScope, { workerId: "other" })
    ).rejects.toThrow(ActiveRunExistsError);
  });

  it("allows a new run once the previous one is closed", async () => {
    await finishRun(harness.db, siteScope, runId, { status: "complete" });

    const next = await startRun(harness.db, siteScope, { workerId: "next" });

    expect(next.status).toBe("running");

    await finishRun(harness.db, siteScope, next.id, {
      status: "degraded",
      statusReason: "OVERSIZE_SOFT_LIMIT"
    });
  });
});

describe("input validation before DDL", () => {
  /**
   * Partition bounds and identifiers cannot be bound parameters, so this is the
   * one place the codebase interpolates a value into SQL. The regex is what
   * makes that safe.
   */
  it("refuses to build partition DDL from a non-UUID", () => {
    expect(() => partitionName("pattern", "'; drop table pattern; --")).toThrow(
      InvalidPartitionKeyError
    );
    expect(() => partitionName("pattern", "not-a-uuid")).toThrow(
      InvalidPartitionKeyError
    );
  });

  it("produces an identifier inside Postgres's 63-byte limit", () => {
    const longest = partitionName(
      "sample_observation",
      "ffffffff-ffff-ffff-ffff-ffffffffffff"
    );

    expect(longest.length).toBeLessThanOrEqual(63);
  });

  it("rejects a site URL that has no host", async () => {
    const org = await createOrganization(harness.db, {
      name: "Bad URL",
      slug: "bad-url"
    });

    await expect(
      createSite(harness.db, org.scope, { name: "Nope", baseUrl: "not a url" })
    ).rejects.toThrow(InvalidSiteUrlError);
  });
});
