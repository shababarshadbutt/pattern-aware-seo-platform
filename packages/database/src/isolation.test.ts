import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { internalDatabase } from "./client.js";
import { PARTITIONED_TABLES, partitionName } from "./partitions.js";
import {
  countOrganizationSnapshotsBySeverity,
  insertAuditSnapshot,
  listOrganizationSnapshotsByImpact,
  listSnapshotsByPatterns
} from "./repositories/audit-snapshot.js";
import { createOrganization } from "./repositories/organization.js";
import {
  countPatterns,
  listPatternsByPopulation,
  listPatternsRanked,
  upsertPatterns
} from "./repositories/pattern.js";
import {
  countExpandedPatterns,
  recordPatternSample
} from "./repositories/pattern-sample.js";
import {
  appendSampleObservations,
  countRunObservations,
  listRunObservations,
  summariseRunRequests,
  tallyRunObservations
} from "./repositories/sample-observation.js";
import {
  countSites,
  createSite,
  findSiteById,
  listSites,
  updateSite
} from "./repositories/site.js";
import {
  latestRunPerSite,
  listOrganizationRuns,
  startRun
} from "./repositories/sitemap-run.js";
import {
  type OrganizationScope,
  type SiteScope,
  siteScopeWithin
} from "./scope.js";
import { createTestDatabase, type TestDatabase } from "./test-harness.js";

let harness: TestDatabase;

/** Two organizations, one site each — the shape a cross-tenant leak shows up in. */
let acmeOrg: OrganizationScope;
let acmeSite: SiteScope;
let rivalOrg: OrganizationScope;
let rivalSite: SiteScope;
let acmeRunId: string;
let rivalRunId: string;

beforeAll(async () => {
  harness = await createTestDatabase();

  const acme = await createOrganization(harness.db, {
    name: "Acme Aviation",
    slug: "acme"
  });

  acmeOrg = acme.scope;

  const acmeCreated = await createSite(harness.db, acmeOrg, {
    name: "Acme Parts",
    baseUrl: "https://parts.acme-aviation.test"
  });

  acmeSite = acmeCreated.scope;

  const rival = await createOrganization(harness.db, {
    name: "Rival Industrial",
    slug: "rival"
  });

  rivalOrg = rival.scope;

  const rivalCreated = await createSite(harness.db, rivalOrg, {
    name: "Rival Supply",
    baseUrl: "https://supply.rival-industrial.test"
  });

  rivalSite = rivalCreated.scope;

  acmeRunId = (await startRun(harness.db, acmeSite, { workerId: "test" })).id;
  rivalRunId = (await startRun(harness.db, rivalSite, { workerId: "test" })).id;

  await upsertPatterns(harness.db, acmeSite, acmeRunId, [
    {
      template: "/part/{param}",
      segmentCount: 2,
      populationCount: 40_000,
      fileCount: 3
    },
    {
      template: "/nsn/{param}",
      segmentCount: 2,
      populationCount: 12_000,
      fileCount: 1
    }
  ]);

  await upsertPatterns(harness.db, rivalSite, rivalRunId, [
    {
      template: "/product/{param}",
      segmentCount: 2,
      populationCount: 900,
      fileCount: 1
    }
  ]);

  /*
   * A published finding for each tenant, so the organization-scoped fleet
   * queries have something to leak. The rival's impact is deliberately the
   * HIGHER of the two: a query that forgot its tenant filter would rank the
   * rival's row first and it would be the very first row a caller saw, rather
   * than something buried past a page boundary where a passing test could miss
   * it.
   */
  await seedFinding(acmeSite, acmeRunId, "/part/{param}", 120);
  await seedFinding(rivalSite, rivalRunId, "/product/{param}", 700);
}, 60_000);

/**
 * One pattern, one draw, one published claim — the minimum a finding needs.
 *
 * `estimate` is an integer because `point_estimate`, `ci_low` and `ci_high` are
 * bigint: they count URLs. Only `impact_score`, `severity_weight` and
 * `confidence_level` are numeric — impact is fractional by construction
 * (ADR-0020), an affected-URL count is not.
 */
async function seedFinding(
  scope: SiteScope,
  sitemapRunId: string,
  template: string,
  estimate: number
): Promise<void> {
  const [target] = (
    await listPatternsByPopulation(harness.db, scope, sitemapRunId)
  ).filter((row) => row.template === template);

  if (target === undefined) {
    throw new Error(`seedFinding could not find pattern ${template}`);
  }

  const sample = await recordPatternSample(harness.db, scope, {
    patternId: target.id,
    sitemapRunId,
    kRequested: 60,
    kThresholdHash: 1_000,
    sampleSize: 60,
    populationAtDraw: target.populationCount
  });

  /**
   * Real probed URLs for each tenant, so a cross-tenant read has something to
   * RETURN rather than merely something to miss.
   *
   * Without these the run-observation isolation test below passes against an
   * empty table no matter what its predicates say — which is exactly what it
   * did until the guard was neutralised and the test stayed green. A test that
   * cannot fail is not evidence.
   *
   * The second probe is ESCALATED deliberately. `summariseRunRequests` charges
   * an escalated check two requests, so with one escalation per tenant each
   * side has a distinct `probes` / `getEscalations` / `httpRequests` triple
   * (2 / 1 / 3) and a leak shows up in every field rather than in one. With
   * both probes unescalated, the escalation predicate could be deleted
   * entirely and the isolation case would still pass.
   */
  await appendSampleObservations(harness.db, scope, [
    {
      patternId: target.id,
      patternSampleId: sample.id,
      urlHash: 4_001,
      url: `${template.replace("/{param}", "")}/probe-1`,
      httpStatus: 404,
      methodUsed: "HEAD"
    },
    {
      patternId: target.id,
      patternSampleId: sample.id,
      urlHash: 4_002,
      url: `${template.replace("/{param}", "")}/probe-2`,
      httpStatus: 200,
      methodUsed: "GET",
      escalatedToGet: true
    }
  ]);

  await insertAuditSnapshot(harness.db, scope, {
    patternId: target.id,
    patternSampleId: sample.id,
    sitemapRunId,
    httpStatus: 404,
    evidenceTier: "estimated",
    observedCount: 6,
    sampleSize: 60,
    populationCount: target.populationCount,
    pointEstimate: estimate,
    ciLow: Math.round(estimate * 0.8),
    /*
     * Clamped to the population, because `ck_audit_snapshot_interval_contains_
     * estimate` requires `ci_high <= population_count`. The rival's pattern
     * holds only 900 URLs, so an unclamped +20% upper bound on a large estimate
     * is not merely rejected — it is meaningless, since an interval cannot
     * extend past the population it describes.
     */
    ciHigh: Math.min(target.populationCount, Math.round(estimate * 1.2)),
    confidenceLevel: 0.95,
    confidenceBand: "confident",
    estimatorVersion: "isolation-test",
    severityClass: "not_found",
    // Weight 1.0, so impact equals the estimate — which is what keeps this
    // inside `ck_audit_snapshot_impact_sane`, the constraint M4 added after a
    // multiplier could push impact past the estimate it weights.
    severityWeight: 1,
    impactScore: estimate
  });
}

afterAll(async () => {
  await harness?.destroy();
});

describe("site onboarding", () => {
  it("creates one partition of every partitioned table", async () => {
    const result = await internalDatabase(harness.db).execute<{
      relname: string;
    }>(sql`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relispartition
      order by c.relname
    `);

    const created = new Set(result.rows.map((r) => r.relname));

    for (const table of PARTITIONED_TABLES) {
      expect(created.has(partitionName(table, acmeSite.siteId))).toBe(true);
      expect(created.has(partitionName(table, rivalSite.siteId))).toBe(true);
    }
  });

  /**
   * The reason onboarding is one transaction. A site row whose partitions failed
   * to appear would accept no patterns at all, and would fail hours later during
   * ingestion rather than here.
   */
  it("routes a site's rows into that site's own partition", async () => {
    const result = await internalDatabase(harness.db).execute<{
      count: string;
    }>(
      sql.raw(
        `select count(*)::text as count from "${partitionName("pattern", acmeSite.siteId)}"`
      )
    );

    expect(Number(result.rows[0]?.count)).toBe(2);
  });
});

describe("cross-tenant isolation", () => {
  it("returns only the scoped site's patterns", async () => {
    const acmePatterns = await listPatternsByPopulation(
      harness.db,
      acmeSite,
      acmeRunId
    );
    const rivalPatterns = await listPatternsByPopulation(
      harness.db,
      rivalSite,
      rivalRunId
    );

    expect(acmePatterns.map((p) => p.template)).toEqual([
      "/part/{param}",
      "/nsn/{param}"
    ]);
    expect(rivalPatterns.map((p) => p.template)).toEqual(["/product/{param}"]);
  });

  /**
   * The leak that matters: a scope for one tenant, pointed at another tenant's
   * run id. Filtering on the run alone would return Rival's patterns to Acme.
   */
  it("finds nothing when a scope is pointed at another tenant's run", async () => {
    const leaked = await listPatternsByPopulation(
      harness.db,
      acmeSite,
      rivalRunId
    );

    expect(leaked).toEqual([]);
  });

  /**
   * A fabricated scope — right organization, someone else's site id — must not
   * resolve. This is the check `siteScopeWithin` documents that it cannot
   * perform itself, and the reason every read filters on both columns rather
   * than on the primary key alone.
   */
  it("refuses a site id that belongs to a different organization", async () => {
    const forged = siteScopeWithin(acmeOrg, rivalSite.siteId);

    expect(await findSiteById(harness.db, forged)).toBeUndefined();
    // ...while the legitimate holder still sees it.
    expect(await findSiteById(harness.db, rivalSite)).toBeDefined();
  });

  /**
   * The claim M1 made was that cross-tenant references are unrepresentable by
   * construction. Automated review on PR #2 pointed out they were not: every
   * table referencing a run also carries `site_id`, but only
   * `(sitemap_run_id)` was constrained, so a row could name one site and a run
   * belonging to another. Migration 0002 closes it with composite keys; this
   * asserts the hole is actually shut rather than trusting the DDL.
   */
  it("refuses a row naming one site and another site's run", async () => {
    const db = internalDatabase(harness.db);

    await expect(
      db.execute(sql`
        insert into pattern
          (site_id, sitemap_run_id, template, segment_count, population_count)
        values (${acmeSite.siteId}, ${rivalRunId}, '/forged/{param}', 2, 1)
      `)
    ).rejects.toThrow();

    await expect(
      db.execute(sql`
        insert into sitemap_file (site_id, sitemap_run_id, url, file_ordinal)
        values (${acmeSite.siteId}, ${rivalRunId}, 'https://parts.acme-aviation.test/s.xml', 1)
      `)
    ).rejects.toThrow();
  });

  it("still accepts a row whose site and run agree", async () => {
    const db = internalDatabase(harness.db);

    await expect(
      db.execute(sql`
        insert into sitemap_file (site_id, sitemap_run_id, url, file_ordinal)
        values (${acmeSite.siteId}, ${acmeRunId}, 'https://parts.acme-aviation.test/ok.xml', 1)
      `)
    ).resolves.toBeDefined();
  });

  it("lists only an organization's own sites", async () => {
    expect((await listSites(harness.db, acmeOrg)).map((s) => s.name)).toEqual([
      "Acme Parts"
    ]);
    expect((await listSites(harness.db, rivalOrg)).map((s) => s.name)).toEqual([
      "Rival Supply"
    ]);
  });

  /**
   * THE FLEET-VIEW READS ARE THE NEW EXPOSURE, so they get their own cases.
   *
   * `listOrganizationSnapshotsByImpact` and `listOrganizationRuns` are the only
   * queries in this package that deliberately span more than one site
   * (ADR-0028), which makes them the two most likely places for a
   * cross-ORGANIZATION leak to appear. M7 found exactly this shape of bug in
   * `routes/patterns.ts` — a scope built and then never used to filter — and it
   * stayed latent because only one organization existed.
   *
   * The rival's finding carries the higher impact score, so a missing tenant
   * filter surfaces as the FIRST row rather than as something a limit might
   * hide.
   */
  it("ranks only an organization's own findings, worst first", async () => {
    const acmeFindings = await listOrganizationSnapshotsByImpact(
      harness.db,
      acmeOrg
    );

    expect(acmeFindings.map((row) => row.patternTemplate)).toEqual([
      "/part/{param}"
    ]);
    expect(acmeFindings[0]?.siteName).toBe("Acme Parts");
    expect(acmeFindings[0]?.impactScore).toBeCloseTo(120, 2);

    const rivalFindings = await listOrganizationSnapshotsByImpact(
      harness.db,
      rivalOrg
    );

    expect(rivalFindings.map((row) => row.patternTemplate)).toEqual([
      "/product/{param}"
    ]);
    expect(rivalFindings[0]?.siteName).toBe("Rival Supply");
  });

  it("lists only an organization's own runs", async () => {
    const acmeRuns = await listOrganizationRuns(harness.db, acmeOrg);
    const rivalRuns = await listOrganizationRuns(harness.db, rivalOrg);

    expect(acmeRuns.map((row) => row.id)).toEqual([acmeRunId]);
    expect(acmeRuns[0]?.siteName).toBe("Acme Parts");
    expect(rivalRuns.map((row) => row.id)).toEqual([rivalRunId]);
    expect(rivalRuns[0]?.siteName).toBe("Rival Supply");
  });

  it("cannot UPDATE another organization's site", async () => {
    /**
     * The repository layer's own proof, with no route above it to compensate.
     *
     * The API's write path also checks membership before calling this, so the
     * route test cannot tell which of the two is holding — removing either one
     * leaves it green. This one can: `updateSite` is called directly with a
     * scope that pairs the rival's site id with Acme's organization id, which
     * is exactly the shape `siteScopeWithin` can produce and explicitly does
     * not vouch for.
     *
     * Confirmed load-bearing by dropping the `organization_id` predicate from
     * `updateSite`, which turns this into a successful rename of the rival's
     * row.
     */
    const forged = siteScopeWithin(acmeOrg, rivalSite.siteId);

    const changed = await updateSite(harness.db, forged, {
      name: "Renamed by another tenant",
      tier: "bulk"
    });

    // Nothing came back, because nothing matched.
    expect(changed).toBeUndefined();

    // And the rival's row is untouched, which is the claim that matters —
    // "returned undefined" and "changed nothing" are different assertions.
    const rival = await findSiteById(harness.db, rivalSite);

    expect(rival?.name).toBe("Rival Supply");
    expect(rival?.tier).not.toBe("bulk");
  });

  it("re-derives the host when its own site's base URL changes", async () => {
    /*
     * `host` is the rate-limiter bucket key and is derived from `base_url` so
     * the two can never disagree. An update that accepted a URL and left the
     * host would pace probes against a domain nobody requests any more.
     */
    const updated = await updateSite(harness.db, acmeSite, {
      baseUrl: "https://relocated.acme.test/catalog"
    });

    expect(updated?.host).toBe("relocated.acme.test");
  });

  it("cannot read another organization's observations through the run join", async () => {
    /**
     * A NEW WAY TO REACH ROWS NEEDS ITS OWN PROOF.
     *
     * `listRunObservations` gets to `sample_observation` by joining `pattern`,
     * which is a path none of the cases above exercise. Its site predicate is
     * on the observation side and the run predicate on the pattern side, so a
     * scope pointing at one tenant while the run belongs to another must return
     * nothing — and that combination is exactly what a forged scope produces.
     *
     * Confirmed load-bearing by removing `eq(sampleObservation.siteId, ...)`
     * from `listRunObservations`, which returns the rival's probed URLs.
     */
    const forged = siteScopeWithin(acmeOrg, rivalSite.siteId);

    // The rival really does have probes to leak — asserted FIRST, so this
    // test cannot pass against an empty table. It did exactly that until the
    // predicate was neutralised and the test stayed green.
    const rivalOwn = await listRunObservations(
      harness.db,
      rivalSite,
      rivalRunId
    );

    expect(rivalOwn.length).toBeGreaterThan(0);
    expect(rivalOwn.map((row) => row.patternTemplate)).toContain(
      "/product/{param}"
    );

    const acmeSeesRival = await listRunObservations(
      harness.db,
      acmeSite,
      rivalRunId
    );

    expect(acmeSeesRival).toHaveLength(0);
    expect(await countRunObservations(harness.db, acmeSite, rivalRunId)).toBe(
      0
    );

    // A scope forged onto the rival's site id DOES reach the rows — that is
    // the shape siteScopeWithin can produce and explicitly does not vouch
    // for. Asserted rather than wished away: it is precisely why the API
    // never builds a scope from a caller-supplied id and resolves the site
    // from the run instead (ADR-0029).
    const forgedRead = await listRunObservations(
      harness.db,
      forged,
      rivalRunId
    );

    expect(forgedRead.length).toBeGreaterThan(0);
  });

  it("cannot tally another organization's probe outcomes", async () => {
    /**
     * `tallyRunObservations` reaches `sample_observation` through the same
     * `pattern` join as `listRunObservations`, so it is a second query on a
     * shared path and gets its own case rather than inheriting one.
     *
     * The rival's outcomes are asserted to EXIST first — the previous version
     * of the neighbouring test passed against an empty table, which is not
     * evidence of anything.
     */
    const rivalOwn = await tallyRunObservations(
      harness.db,
      rivalSite,
      rivalRunId
    );

    expect(rivalOwn.length).toBeGreaterThan(0);
    expect(rivalOwn.reduce((sum, row) => sum + row.count, 0)).toBeGreaterThan(
      0
    );

    const acmeSeesRival = await tallyRunObservations(
      harness.db,
      acmeSite,
      rivalRunId
    );

    expect(acmeSeesRival).toHaveLength(0);
  });

  it("cannot summarise another organization's request cost", async () => {
    /**
     * A third query on the shared `pattern` join, so it gets its own case for
     * the reason the tally above does — a shared join path is not a shared
     * proof.
     *
     * Confirmed load-bearing by removing `eq(sampleObservation.siteId, ...)`
     * from `summariseRunRequests`. THE LAYER NEUTRALISED IS THE REPOSITORY'S
     * OBSERVATION-SIDE SITE PREDICATE — named, because a claim that does not
     * say which layer it removed is a claim rather than a measurement. Without
     * it, Acme reads the rival's two probes and their escalation.
     */
    const rivalOwn = await summariseRunRequests(
      harness.db,
      rivalSite,
      rivalRunId
    );

    // Asserted FIRST: the rival really does have request cost to leak. Both
    // fixtures write two probes, one of them escalated, so the triple is
    // distinct in every field and a leak cannot hide in an unread column.
    expect(rivalOwn.probes).toBe(2);
    expect(rivalOwn.getEscalations).toBe(1);
    expect(rivalOwn.httpRequests).toBe(3);

    const acmeSeesRival = await summariseRunRequests(
      harness.db,
      acmeSite,
      rivalRunId
    );

    expect(acmeSeesRival.probes).toBe(0);
    expect(acmeSeesRival.getEscalations).toBe(0);
    expect(acmeSeesRival.httpRequests).toBe(0);
  });

  it("cannot count another organization's expanded patterns", async () => {
    /**
     * `countExpandedPatterns` reads `pattern_sample` directly rather than
     * through the `pattern` join, so its tenant filter is a different predicate
     * on a different table and inherits nothing from the cases above.
     *
     * Confirmed load-bearing by removing `eq(patternSample.siteId, ...)` from
     * `countExpandedPatterns`. THE LAYER NEUTRALISED IS THAT REPOSITORY'S
     * `pattern_sample` SITE PREDICATE. Without it, Acme counts the rival's
     * round-2 draw seeded below.
     */
    const [rivalPattern] = await listPatternsByPopulation(
      harness.db,
      rivalSite,
      rivalRunId
    );

    if (rivalPattern === undefined) {
      throw new Error("expected the rival to have a pattern");
    }

    /*
     * A second draw for the rival, which nothing else in this suite creates.
     * `k_threshold_hash` rises with the round because ADR-0002's superset
     * property requires round 2 to contain round 1 — a reviewer verifies that
     * by comparing thresholds, so a round 2 below round 1 would be a nonsense
     * row that happened to satisfy the constraints.
     */
    await recordPatternSample(harness.db, rivalSite, {
      patternId: rivalPattern.id,
      sitemapRunId: rivalRunId,
      round: 2,
      kRequested: 120,
      kThresholdHash: 2_000,
      sampleSize: 120,
      populationAtDraw: rivalPattern.populationCount
    });

    // Asserted FIRST, so this cannot pass over an empty table.
    expect(await countExpandedPatterns(harness.db, rivalSite, rivalRunId)).toBe(
      1
    );

    expect(await countExpandedPatterns(harness.db, acmeSite, rivalRunId)).toBe(
      0
    );
  });
  /**
   * THE PORTFOLIO'S TWO NEW CROSS-SITE READS (ADR-0037).
   *
   * Both span every site in one organization, which puts them in the same
   * category as the two fleet lists above and earns each its own case rather
   * than letting one stand in for the other — the D3e correction: a second
   * query on a shared boundary is a second place to get the boundary wrong.
   *
   * Each asserts the rival's rows EXIST before asserting we cannot see them.
   * The D3d finding is why: an isolation case that seeds nothing passes by
   * asserting emptiness against an empty table, and reports a guarantee it
   * never tested.
   */
  it("returns only an organization's own latest runs, one per site", async () => {
    const rivalLatest = await latestRunPerSite(harness.db, rivalOrg);

    // Asserted FIRST, so the next assertion cannot pass over an empty table.
    expect([...rivalLatest.keys()]).toEqual([rivalSite.siteId]);
    expect(rivalLatest.get(rivalSite.siteId)?.id).toBe(rivalRunId);

    const acmeLatest = await latestRunPerSite(harness.db, acmeOrg);

    expect([...acmeLatest.keys()]).toEqual([acmeSite.siteId]);
    expect(acmeLatest.get(acmeSite.siteId)?.id).toBe(acmeRunId);
    expect(acmeLatest.has(rivalSite.siteId)).toBe(false);
  });

  it("counts only an organization's own findings by severity", async () => {
    const rivalCounts = await countOrganizationSnapshotsBySeverity(
      harness.db,
      rivalOrg
    );

    // Asserted FIRST, for the same reason as above.
    expect(rivalCounts.length).toBeGreaterThan(0);
    expect(rivalCounts.every((row) => row.siteId === rivalSite.siteId)).toBe(
      true
    );

    const acmeCounts = await countOrganizationSnapshotsBySeverity(
      harness.db,
      acmeOrg
    );

    expect(acmeCounts.length).toBeGreaterThan(0);
    expect(acmeCounts.every((row) => row.siteId === acmeSite.siteId)).toBe(
      true
    );
    expect(acmeCounts.some((row) => row.siteId === rivalSite.siteId)).toBe(
      false
    );
  });

  /**
   * The portfolio footer reads "showing 1-N of M". `countSites` supplies the
   * M, and it shares its predicates with `listSites` so the two cannot describe
   * different sets — but it is still a second query, so it needs its own proof
   * that it does not count the neighbours.
   */
  it("counts only an organization's own sites", async () => {
    expect(await countSites(harness.db, acmeOrg)).toBe(1);
    expect(await countSites(harness.db, rivalOrg)).toBe(1);
    expect(await countSites(harness.db, acmeOrg, { tier: "priority" })).toBe(0);
  });

  /**
   * `listPatternsRanked` reaches `audit_snapshot` from the `pattern` side
   * through a LEFT JOIN, which is a path no case above exercises. Its site
   * predicate sits on `pattern` and the join pairs `site_id` with `pattern_id`,
   * so a scope pointing at one tenant while the run belongs to another must
   * return nothing.
   *
   * Confirmed load-bearing by removing `eq(pattern.siteId, scope.siteId)` from
   * `listPatternsRanked`: the rival's `/product/{param}` comes back, ranked by
   * its own findings. THE LAYER NEUTRALISED IS THAT QUERY'S SITE PREDICATE —
   * named, because nothing above it in the repository can compensate.
   */
  it("cannot rank another organization's patterns", async () => {
    // The rival really does have a pattern to leak, asserted FIRST so this
    // cannot pass against an empty table.
    const rivalOwn = await listPatternsRanked(
      harness.db,
      rivalSite,
      rivalRunId,
      {
        sort: "impact"
      }
    );

    expect(rivalOwn.length).toBeGreaterThan(0);
    expect(rivalOwn.map((row) => row.template)).toContain("/product/{param}");

    const acmeSeesRival = await listPatternsRanked(
      harness.db,
      acmeSite,
      rivalRunId,
      { sort: "impact" }
    );

    expect(acmeSeesRival).toHaveLength(0);
    expect(await countPatterns(harness.db, acmeSite, rivalRunId)).toBe(0);
  });

  /**
   * `listSnapshotsByPatterns` takes pattern IDS FROM ITS CALLER, which is the
   * one shape that makes a site predicate load-bearing rather than incidental:
   * every other snapshot query derives its ids from a scoped read, and this one
   * is handed them. If the predicate went missing, passing a rival's pattern id
   * would return the rival's published claims — and the caller would have no
   * way to tell, because it asked for exactly that id.
   *
   * Confirmed load-bearing by removing `eq(auditSnapshot.siteId, ...)` from
   * `listSnapshotsByPatterns`. THE LAYER NEUTRALISED IS THAT QUERY'S SITE
   * PREDICATE.
   */
  it("cannot read another organization's findings by pattern id", async () => {
    const [rivalPatternRow] = await listPatternsByPopulation(
      harness.db,
      rivalSite,
      rivalRunId,
      1
    );

    if (rivalPatternRow === undefined) {
      throw new Error("the rival fixture has no pattern to read");
    }

    // The rival's own scope DOES see its claims — asserted first, so the
    // isolation assertion below cannot succeed against an empty result.
    const rivalOwn = await listSnapshotsByPatterns(harness.db, rivalSite, [
      rivalPatternRow.id
    ]);

    expect(rivalOwn.length).toBeGreaterThan(0);

    const acmeSeesRival = await listSnapshotsByPatterns(harness.db, acmeSite, [
      rivalPatternRow.id
    ]);

    expect(acmeSeesRival).toHaveLength(0);
  });
});
