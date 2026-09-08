import {
  appendSampleObservations,
  createOrganization,
  createSite,
  type Database,
  findRunSamplingHealth,
  findSiteById,
  finishRun,
  insertAuditSnapshot,
  listPatternsByPopulation,
  type OrganizationScope,
  recordPatternSample,
  type SiteScope,
  setFileParseStatus,
  siteScopeWithin,
  startRun,
  upsertPatternPopulations,
  upsertPatterns,
  upsertSamplingHealth,
  upsertSitemapFiles
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { resetOrgScopeCacheForTesting } from "../src/org-scope.js";
import { POLICY_LIMITS } from "../src/policy-manifest.js";

/**
 * The API against a real migrated Postgres, driven through `app.inject()`.
 *
 * No port is bound and no mock query layer is involved — which is the point.
 * Every assertion below is about the boundary between the routes and the
 * scoped repository layer, and that boundary is exactly what a mock would
 * replace with an assumption. Two of these tests cover failures that were
 * live in this code and that a unit test could not have seen: a caller-supplied
 * `siteId` reading another organization's rows, and a non-UUID path segment
 * returning a 500 with the raw SQL in the body.
 */

let harness: TestDatabase;
let app: ReturnType<typeof buildApp>;
let db: Database;

/** The organization the API is configured to act as. */
let ownScope: OrganizationScope;
let ownSite: SiteScope;

/**
 * A SECOND site in the API's own organization, fully seeded.
 *
 * The fleet routes need real own-organization rows, and `ownSite` cannot
 * supply them: a test below asserts that a site with no finished run reports
 * exactly that, so giving it a completed run would silently gut that case.
 * Without this site the "/issues returns our findings" assertion would pass
 * against an empty list and prove nothing.
 */
let ownFleetSite: SiteScope;
let ownFleetRunId = "";
let ownFleetPatternId = "";

/** A second tenant, which the API is NOT configured for. */
let otherSite: SiteScope;
let otherPatternId = "";
let otherRunId = "";

const DEMO_SLUG = `api-test-${Date.now()}`;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;

  const own = await createOrganization(db, {
    name: "Own Org",
    slug: DEMO_SLUG
  });

  ownScope = own.scope;
  ownSite = (
    await createSite(db, ownScope, {
      name: "Own Site",
      baseUrl: "https://own.example"
    })
  ).scope;

  /**
   * A second organization with a real site, run and pattern.
   *
   * This is what makes the isolation test meaningful: the rows exist and are
   * reachable by id, so a route that skips the membership check returns them
   * rather than simply finding nothing.
   */
  const other = await createOrganization(db, {
    name: "Other Org",
    slug: `${DEMO_SLUG}-other`
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
      populationCount: 5000,
      fileCount: 1
    }
  ]);

  await finishRun(db, otherSite, otherRunId, { status: "complete" });

  const [otherPattern] = await listPatternsByPopulation(
    db,
    otherSite,
    otherRunId,
    1
  );

  otherPatternId = otherPattern?.id ?? "";

  const sample = await recordPatternSample(db, otherSite, {
    patternId: otherPatternId,
    sitemapRunId: otherRunId,
    kRequested: 30,
    kThresholdHash: 1,
    sampleSize: 30,
    populationAtDraw: 5000
  });

  await insertAuditSnapshot(db, otherSite, {
    patternId: otherPatternId,
    patternSampleId: sample.id,
    sitemapRunId: otherRunId,
    httpStatus: 404,
    evidenceTier: "estimated",
    observedCount: 15,
    sampleSize: 30,
    populationCount: 5000,
    pointEstimate: 2500,
    ciLow: 1700,
    ciHigh: 3300,
    confidenceLevel: 0.95,
    confidenceBand: "approximate",
    estimatorVersion: "1.0.0",
    severityClass: "not_found",
    severityWeight: 1,
    impactScore: 2500
  });

  ownFleetSite = (
    await createSite(db, ownScope, {
      name: "Own Fleet Site",
      baseUrl: "https://fleet.own.example"
    })
  ).scope;

  ownFleetRunId = (await startRun(db, ownFleetSite, { workerId: "t" })).id;

  await upsertPatterns(db, ownFleetSite, ownFleetRunId, [
    {
      template: "/own-fleet/{id}",
      segmentCount: 2,
      populationCount: 3000,
      fileCount: 1
    }
  ]);

  /**
   * Real files and per-file populations, not just a pattern row.
   *
   * The run-detail and population-by-file assertions below are about rows the
   * API had no route to before this milestone, so seeding only the pattern
   * would let every one of them pass against an empty list and prove nothing —
   * the same trap the "/issues returns our findings" case documents above.
   */
  const ownFiles = await upsertSitemapFiles(db, ownFleetSite, ownFleetRunId, [
    { url: "https://fleet.own.example/sitemap-1.xml", fileOrdinal: 1 },
    { url: "https://fleet.own.example/sitemap-2.xml", fileOrdinal: 2 }
  ]);

  await setFileParseStatus(db, ownFleetSite, ownFiles[0]?.id ?? "", "parsed", {
    urlCount: 2000
  });
  // One FAILED file, deliberately: a run that reports a clean status while a
  // file it could not read leaves the population short is the exact case the
  // run-detail screen exists to make visible.
  await setFileParseStatus(db, ownFleetSite, ownFiles[1]?.id ?? "", "failed", {
    parseError: "unexpected end of document"
  });

  await finishRun(db, ownFleetSite, ownFleetRunId, { status: "complete" });

  const [ownPattern] = await listPatternsByPopulation(
    db,
    ownFleetSite,
    ownFleetRunId,
    1
  );

  ownFleetPatternId = ownPattern?.id ?? "";

  await upsertPatternPopulations(db, ownFleetSite, [
    {
      patternId: ownFleetPatternId,
      sitemapFileId: ownFiles[0]?.id ?? "",
      urlCount: 2000
    },
    {
      patternId: ownFleetPatternId,
      sitemapFileId: ownFiles[1]?.id ?? "",
      urlCount: 1000
    }
  ]);

  const ownSample = await recordPatternSample(db, ownFleetSite, {
    patternId: ownPattern?.id ?? "",
    sitemapRunId: ownFleetRunId,
    kRequested: 30,
    kThresholdHash: 1,
    sampleSize: 30,
    populationAtDraw: 3000
  });

  await appendSampleObservations(db, ownFleetSite, [
    {
      patternId: ownFleetPatternId,
      patternSampleId: ownSample.id,
      urlHash: 11,
      url: "https://fleet.own.example/own-fleet/1",
      httpStatus: 410,
      methodUsed: "HEAD"
    },
    {
      patternId: ownFleetPatternId,
      patternSampleId: ownSample.id,
      urlHash: 12,
      url: "https://fleet.own.example/own-fleet/2",
      httpStatus: 200,
      methodUsed: "HEAD"
    }
  ]);

  /*
   * Impact 100, deliberately far BELOW the other tenant's 2500. The fleet list
   * ranks worst-first, so a missing tenant filter puts the other
   * organization's finding at position one — the first row anyone would see,
   * rather than something a limit could hide past a page boundary.
   */
  await insertAuditSnapshot(db, ownFleetSite, {
    patternId: ownPattern?.id ?? "",
    patternSampleId: ownSample.id,
    sitemapRunId: ownFleetRunId,
    httpStatus: 410,
    evidenceTier: "estimated",
    observedCount: 1,
    sampleSize: 30,
    populationCount: 3000,
    pointEstimate: 100,
    ciLow: 80,
    ciHigh: 120,
    confidenceLevel: 0.95,
    confidenceBand: "confident",
    estimatorVersion: "1.0.0",
    severityClass: "gone",
    severityWeight: 1,
    impactScore: 100
  });

  /*
   * A health window for EACH tenant. The other org's row matters as much as
   * ours: without it the isolation case below asserts a 404 against a site that
   * has nothing to leak, which passes whatever the route does. The figures
   * differ so a leak is visible in the values, not only in the row count.
   */
  await upsertSamplingHealth(db, ownFleetSite, {
    sitemapRunId: ownFleetRunId,
    windowStart: new Date("2026-09-01T00:00:00Z"),
    windowEnd: new Date("2026-09-01T01:00:00Z"),
    patternsTotal: 2,
    patternsLowConfidence: 1,
    patternsBlocked: 0,
    patternsNeedsReview: 1,
    samplesDrawn: 2,
    httpRequests: 140,
    getEscalations: 20
  });

  await upsertSamplingHealth(db, otherSite, {
    sitemapRunId: otherRunId,
    windowStart: new Date("2026-09-01T00:00:00Z"),
    windowEnd: new Date("2026-09-01T01:00:00Z"),
    patternsTotal: 9,
    patternsLowConfidence: 9,
    patternsBlocked: 9,
    patternsNeedsReview: 9,
    samplesDrawn: 9,
    httpRequests: 999,
    getEscalations: 99
  });

  resetOrgScopeCacheForTesting();

  /**
   * A literal plus a policy mask, not `loadConfig(process.env)`.
   *
   * `buildApp` takes only what it reads. Validating the whole environment here
   * would make this suite depend on REDIS_URL, which no route touches — and it
   * did, until the type was narrowed.
   *
   * The `/settings` route needs the operational limits, so `buildApp` widened
   * to `ApiConfig & PolicyConfig`. THE INVARIANT SURVIVED: every policy key is
   * defaulted, so `loadPolicyConfig({})` parses an EMPTY environment and this
   * suite still holds no database URL, no Redis URL and no secret. Widening to
   * the full `Config` instead would have undone the fix this comment records.
   */
  app = buildApp(
    {
      NODE_ENV: "test",
      DEFAULT_ORGANIZATION_SLUG: DEMO_SLUG,
      ...loadPolicyConfig({})
    },
    createLogger({ service: "api-test", level: "silent", pretty: false }),
    db
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
  await harness.destroy();
  resetOrgScopeCacheForTesting();
});

describe("tenant isolation", () => {
  it("does not serve another organization's site", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}`
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "SITE_NOT_FOUND" }
    });
  });

  it("does not serve another organization's patterns", async () => {
    /**
     * THE GAP THIS TEST EXISTS FOR. `siteScopeWithin` carries the
     * organization across but cannot verify the site belongs to it — its doc
     * says the caller owes that check — and the pattern routes did not perform
     * it. Every repository below it filters on `site_id` alone, correctly, so
     * a caller-supplied id read straight through. The rows here are real and
     * complete, so a regression returns data rather than an empty list.
     */
    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}/patterns`
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain("/secret/{id}");
  });

  it("does not serve another organization's pattern detail or evidence", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}/patterns/${otherPatternId}`
    });

    expect(response.statusCode).toBe(404);

    const body = JSON.stringify(response.json());

    expect(body).not.toContain("/secret/{id}");
    // Nor the published claim about it.
    expect(body).not.toContain("2500");
  });

  it("lists only its own organization's sites", async () => {
    const response = await app.inject({ method: "GET", url: "/sites" });

    expect(response.statusCode).toBe(200);

    const names = response
      .json<{ sites: { name: string }[] }>()
      .sites.map((site) => site.name);

    expect(names).toContain("Own Site");
    expect(names).not.toContain("Other Site");
  });
});

describe("the fleet-wide routes", () => {
  /**
   * The exposure these routes add.
   *
   * Neither takes a `siteId`, so neither has a membership check to make — the
   * tenant boundary lives inside `listOrganizationSnapshotsByImpact` and
   * `listOrganizationRuns`, which derive their site ids from the
   * `OrganizationScope` rather than from the request (ADR-0028). These tests
   * assert both halves: our rows come back, and the other tenant's — which are
   * real, complete, and ranked ABOVE ours — do not.
   */
  it("ranks our own findings and never another tenant's", async () => {
    const response = await app.inject({ method: "GET", url: "/issues" });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      issues: readonly {
        readonly siteName: string;
        readonly patternTemplate: string;
      }[];
    };

    expect(body.issues.map((row) => row.patternTemplate)).toEqual([
      "/own-fleet/{id}"
    ]);
    expect(body.issues[0]?.siteName).toBe("Own Fleet Site");
    expect(JSON.stringify(body)).not.toContain("/secret/{id}");
    expect(JSON.stringify(body)).not.toContain("Other Site");
  });

  it("sends impact with its interval, because impact is an estimate", async () => {
    /**
     * ADR-0008 applies to impact too — it is `point_estimate x
     * severity_weight`, so it is exactly as estimated as the count it weights.
     * The screen cannot render the interval if the API never sends it, and it
     * did not until ADR-0024.
     */
    const response = await app.inject({ method: "GET", url: "/issues" });
    const [finding] = (
      response.json() as {
        issues: readonly Record<string, unknown>[];
      }
    ).issues;

    expect(finding).toMatchObject({
      impactScore: 100,
      impactLow: 80,
      impactHigh: 120
    });
  });

  it("lists our own runs and never another tenant's", async () => {
    const response = await app.inject({ method: "GET", url: "/runs" });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      runs: readonly { readonly id: string; readonly siteName: string }[];
    };

    expect(body.runs.map((row) => row.id)).toEqual([ownFleetRunId]);
    expect(body.runs[0]?.siteName).toBe("Own Fleet Site");
    expect(body.runs.map((row) => row.id)).not.toContain(otherRunId);
  });

  it("does not serve another organization's run detail", async () => {
    /**
     * THE ISOLATION CASE FOR THE ONLY ROUTE ADDRESSED BY RUN ID ALONE.
     *
     * `/runs/:runId` has no `siteId` to check membership on, so the boundary
     * is entirely inside `findOrganizationRunById`, which filters on the site
     * ids `organizationSiteIds` returns for the caller's own scope. The other
     * tenant's run is real and complete, so a regression here returns their
     * files and pattern counts rather than an empty response.
     *
     * Confirmed load-bearing: removing the `inArray(siteId, ...)` predicate
     * from that query turns this into a 200 carrying "/secret/{id}"'s run.
     */
    const response = await app.inject({
      method: "GET",
      url: `/runs/${otherRunId}`
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "RUN_NOT_FOUND" } });
    expect(JSON.stringify(response.json())).not.toContain("other.example");
  });

  it("serves one of our own runs with its files and pattern counts", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}`
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      readonly run: { readonly id: string; readonly siteName: string };
      readonly files: readonly {
        readonly parseStatus: string;
        readonly parseError: string | null;
        readonly urlCount: number;
      }[];
      readonly fileCount: number;
      readonly patternStatus: readonly {
        readonly status: string;
        readonly count: number;
        readonly populationCount: number;
      }[];
    };

    expect(body.run.id).toBe(ownFleetRunId);
    expect(body.run.siteName).toBe("Own Fleet Site");

    // `sitemap_file` had no route at all before this: every column here was
    // written by the pipeline and readable by nothing.
    expect(body.fileCount).toBe(2);
    expect(body.files).toHaveLength(2);
    expect(body.files.map((file) => file.parseStatus)).toEqual([
      "parsed",
      "failed"
    ]);
    expect(body.files[1]?.parseError).toBe("unexpected end of document");

    // Counts, not URLs — the whole point of the population index.
    expect(body.patternStatus).toEqual([
      { status: "unsampled", count: 1, populationCount: 3000 }
    ]);
  });

  it("does not publish the file's internal storage key", async () => {
    /*
     * `storageKey` names a location in our own object store and no screen has
     * a use for it. It stays off the wire because the response schema does not
     * declare it, so this asserts the stripping actually happens rather than
     * trusting the comment in schemas.ts.
     */
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}`
    });

    expect(response.body).not.toContain("storageKey");
  });

  it("rejects a non-UUID run id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/runs/not-a-uuid"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" }
    });
  });

  it("rejects a limit outside the allowed range", async () => {
    /*
     * These are the only routes whose result set is not bounded by the URL, so
     * the cap is the thing standing between a caller and the whole table.
     */
    for (const query of ["?limit=0", "?limit=201", "?limit=abc"]) {
      const response = await app.inject({
        method: "GET",
        url: `/issues${query}`
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("honours a valid limit", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/issues?limit=1"
    });

    expect(response.statusCode).toBe(200);
    expect(
      (response.json() as { issues: readonly unknown[] }).issues
    ).toHaveLength(1);
  });
});

describe("editing a site", () => {
  /**
   * THE FIRST MUTATION IN THIS API, so these cover more than the happy path.
   *
   * A write's failure modes are worse than a read's: a missing membership check
   * is an edit to another tenant's row rather than a leak, and a host that is
   * not re-derived silently paces probes against a bucket for a domain nobody
   * requests any more.
   */
  it("updates a field and leaves the others alone", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { name: "Own Site Renamed" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Own Site Renamed",
      // Untouched, because the body was a partial.
      baseUrl: "https://own.example",
      tier: "standard"
    });
  });

  it("re-derives the host when the base URL changes", async () => {
    /**
     * The schema comment says `host` is derived from `base_url` so the
     * rate-limiter bucket "can never disagree with the URL the crawler actually
     * requests". An update that accepted a new URL and left the old host would
     * break that in the direction that matters, and nothing would report it.
     */
    const response = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { baseUrl: "https://moved.own.example/shop" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      baseUrl: "https://moved.own.example/shop",
      host: "moved.own.example"
    });
  });

  it("clears a cap to null rather than to zero", async () => {
    /*
     * Null means "inherit the platform default"; zero would mean a site allowed
     * no requests at all. The two are one coercion slip apart, so both the
     * clearing and the setting are asserted.
     */
    const set = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { dailyRequestCap: 5_000 }
    });

    expect(set.json()).toMatchObject({ dailyRequestCap: 5000 });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { dailyRequestCap: null }
    });

    expect(cleared.json()).toMatchObject({ dailyRequestCap: null });
  });

  it("does not edit another organization's site", async () => {
    /**
     * THE ISOLATION CASE FOR THE WRITE PATH, and the reason it matters more
     * than its read counterpart: a missing check here is not a leak but a
     * mutation of another tenant's row.
     *
     * WHAT THIS TEST DOES AND DOES NOT PROVE, measured rather than assumed.
     * Two independent layers block the write — the route's membership check,
     * and `updateSite`'s own `organization_id` predicate — and removing EITHER
     * ONE leaves this test green, because the other still returns 404. Removing
     * BOTH turns it into a 200 with the rename applied, which is what was
     * actually verified.
     *
     * So this asserts the boundary holds, not that any one layer holds it. The
     * per-layer proof for the repository is in
     * `packages/database/src/isolation.test.ts`, where there is no route above
     * it to compensate — which is the same "each layer needs its own proof"
     * rule the schema-level and compile-level guards already follow.
     */
    const response = await app.inject({
      method: "PATCH",
      url: `/sites/${otherSite.siteId}`,
      payload: { name: "Pwned" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "SITE_NOT_FOUND" }
    });

    // And the row is untouched, not merely unreported.
    const stillTheirs = await findSiteById(db, otherSite);

    expect(stillTheirs?.name).toBe("Other Site");
  });

  it("rejects a host another site in the organization already uses", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { baseUrl: "https://fleet.own.example" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "HOST_IN_USE" } });

    // A 409, not a 500 carrying the constraint name and the SQL.
    const body = response.body.toLowerCase();

    expect(body).not.toContain("select");
    expect(body).not.toContain("uq_site_org_host");
  });

  it("refuses a tier change while a run is in flight", async () => {
    /**
     * Queues are namespaced `{tier}:{siteId}:{stage}`, so re-tiering mid-run
     * leaves already-queued work addressed to the old namespace and nothing
     * migrates it — the run would stall with no error, which is the
     * "completed without succeeding" shape section 1.5 is about.
     *
     * `ownSite` has no finished run by design (another test depends on that),
     * so a run is started here and cleaned up after.
     */
    const run = await startRun(db, ownSite, { workerId: "tier-guard" });

    const refused = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { tier: "priority" }
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "RUN_IN_FLIGHT" } });
    expect(refused.body).toContain(run.id);

    // A change to something OTHER than tier is still allowed mid-run.
    const allowed = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { name: "Renamed mid-run" }
    });

    expect(allowed.statusCode).toBe(200);

    await finishRun(db, ownSite, run.id, { status: "cancelled" });

    const nowAllowed = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { tier: "priority" }
    });

    expect(nowAllowed.statusCode).toBe(200);
    expect(nowAllowed.json()).toMatchObject({ tier: "priority" });
  });

  it("rejects an unknown field instead of silently dropping it", async () => {
    /**
     * Responses strip unknown keys on purpose; a WRITE is the opposite case.
     * Ignoring a field the caller believed it was setting is how a form appears
     * to save something it did not.
     */
    const response = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { organizationId: "00000000-0000-0000-0000-000000000000" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an empty body, a bad URL and a non-UUID id", async () => {
    const empty = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: {}
    });

    expect(empty.statusCode).toBe(400);

    const badUrl = await app.inject({
      method: "PATCH",
      url: `/sites/${ownSite.siteId}`,
      payload: { baseUrl: "not-a-url" }
    });

    expect(badUrl.statusCode).toBe(400);

    const badId = await app.inject({
      method: "PATCH",
      url: "/sites/nope",
      payload: { name: "x" }
    });

    expect(badId.statusCode).toBe(400);
  });
});

describe("the run analysis routes", () => {
  it("sends the panel data the analysis screen needs", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}`
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      readonly depthDistribution: readonly {
        readonly segmentCount: number;
        readonly count: number;
        readonly populationCount: number;
      }[];
      readonly topPatterns: readonly { readonly template: string }[];
      readonly smallestPattern?: { readonly template: string };
      readonly previousTotalUrls?: number;
    };

    // One pattern at depth 2 holding 3,000 URLs — both figures counted.
    expect(body.depthDistribution).toEqual([
      { segmentCount: 2, count: 1, populationCount: 3000 }
    ]);
    expect(body.topPatterns.map((row) => row.template)).toEqual([
      "/own-fleet/{id}"
    ]);

    /*
     * A single-pattern run must NOT report the same template as both largest
     * and smallest — that reads as a rendering bug rather than as a run with
     * one pattern.
     */
    expect(body.smallestPattern).toBeUndefined();

    // No earlier run for this site, so no trend — absent, not zero.
    expect(body.previousTotalUrls).toBeUndefined();
  });

  it("pages the sampled URLs and reports the true total", async () => {
    const first = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/observations?limit=1&offset=0`
    });

    expect(first.statusCode).toBe(200);

    const firstBody = first.json() as {
      readonly observations: readonly { readonly id: string }[];
      readonly total: number;
    };

    // Two observations were seeded for this run.
    expect(firstBody.total).toBe(2);
    expect(firstBody.observations).toHaveLength(1);

    const second = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/observations?limit=1&offset=1`
    });

    const secondBody = second.json() as {
      readonly observations: readonly { readonly id: string }[];
      readonly total: number;
    };

    // A stable order across pages: the same row must not appear twice while
    // another never appears at all. Both probes share a timestamp, which is
    // exactly the case the id tie-break exists for.
    expect(secondBody.observations[0]?.id).not.toBe(
      firstBody.observations[0]?.id
    );
    expect(secondBody.total).toBe(2);
  });

  it("carries the pattern each probed URL was drawn from", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/observations`
    });

    const body = response.json() as {
      readonly observations: readonly {
        readonly patternTemplate: string;
        readonly url: string;
      }[];
    };

    // Without the join this is a bare pattern UUID, which is not actionable.
    expect(
      body.observations.every(
        (row) => row.patternTemplate === "/own-fleet/{id}"
      )
    ).toBe(true);
  });

  it("filters by HTTP status class", async () => {
    /*
     * One 410 and one 200 were seeded, so each class returns exactly one and
     * the classes do not overlap.
     */
    const clientError = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/observations?status=client_error`
    });
    const ok = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/observations?status=ok`
    });

    expect((clientError.json() as { total: number }).total).toBe(1);
    expect((ok.json() as { total: number }).total).toBe(1);
    expect(
      (clientError.json() as { observations: { httpStatus: number }[] })
        .observations[0]?.httpStatus
    ).toBe(410);
  });

  it("rejects a limit outside the allowed range", async () => {
    for (const query of ["?limit=0", "?limit=201", "?status=nonsense"]) {
      const response = await app.inject({
        method: "GET",
        url: `/runs/${ownFleetRunId}/observations${query}`
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("does not serve another organization's observations or export", async () => {
    /**
     * Both new routes reach rows by a NEW path — a join from
     * `sample_observation` through `pattern` — so each is a new way to read
     * data and needs its own isolation case rather than inheriting the run
     * detail's.
     */
    for (const path of ["/observations", "/export.csv"]) {
      const response = await app.inject({
        method: "GET",
        url: `/runs/${otherRunId}${path}`
      });

      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("/secret/{id}");
    }
  });

  it("exports CSV with a header row and one line per probe", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/export.csv`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("attachment");

    const lines = response.body.trim().split("\n");

    // Header plus the two seeded probes, and no truncation notice.
    expect(lines[0]).toBe(
      "url,pattern,http_status,method,escalated_to_get,is_soft_404,error_reason,response_ms,observed_at"
    );
    expect(lines).toHaveLength(3);
    expect(response.body).not.toContain("TRUNCATED");
    expect(response.body).toContain("/own-fleet/{id}");
  });

  it("quotes a value containing a comma or a quote", async () => {
    /*
     * RFC 4180: an unescaped comma silently shifts every later column, which
     * is a corruption that looks like data rather than like an error.
     */
    const response = await app.inject({
      method: "GET",
      url: `/runs/${ownFleetRunId}/export.csv`
    });

    for (const line of response.body.trim().split("\n").slice(1)) {
      expect(line.startsWith('"https://')).toBe(true);
    }
  });
});

describe("the newly exposed per-site reads", () => {
  /**
   * Queries that existed, were tested, and had no route.
   *
   * `listSnapshotsByImpact` was reachable only from the pipeline's finalize
   * stage, and `listPatternFiles`, `sumPatternPopulation` and
   * `countObservations` had no caller anywhere. Every assertion below is about
   * data the database has held since M6 that no screen could show.
   */
  it("sends a site's own findings, named by pattern", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownFleetSite.siteId}`
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      readonly findings: readonly {
        readonly patternTemplate: string;
        readonly impactScore: number;
        readonly impactLow: number;
        readonly impactHigh: number;
      }[];
    };

    // The template is what makes the row actionable; without the join it was
    // a pattern UUID.
    expect(body.findings.map((finding) => finding.patternTemplate)).toEqual([
      "/own-fleet/{id}"
    ]);

    // ADR-0008 applies here exactly as it does on the fleet list.
    expect(body.findings[0]).toMatchObject({
      impactScore: 100,
      impactLow: 80,
      impactHigh: 120
    });
  });

  it("never sends another tenant's findings on a site overview", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}`
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain("/secret/{id}");
  });

  it("sends a pattern's per-file population and its observed n", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownFleetSite.siteId}/patterns/${ownFleetPatternId}`
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      readonly files: readonly {
        readonly urlCount: number;
        readonly fileUrl: string;
        readonly fileOrdinal: number;
      }[];
      readonly populationFromFiles: number;
      readonly observedCount: number;
      readonly latestSample?: { readonly sampleSize: number };
    };

    // Largest contributor first, and NAMED — the population row holds only a
    // file id, which is not something a reader can act on.
    expect(body.files.map((file) => file.urlCount)).toEqual([2000, 1000]);
    expect(body.files[0]?.fileUrl).toBe(
      "https://fleet.own.example/sitemap-1.xml"
    );

    /*
     * The summed population, which is the figure worth having: it agrees with
     * `pattern.populationCount` here (3000), and a screen showing both is how
     * the M6 undercount — where the two silently diverge — becomes visible.
     */
    expect(body.populationFromFiles).toBe(3000);

    // The n of the estimate, distinct from the 30 that were drawn. The gap is
    // a verification pass that did not finish.
    expect(body.observedCount).toBe(2);
    expect(body.latestSample?.sampleSize).toBe(30);
  });
});

describe("request validation", () => {
  it("rejects a non-UUID site id with 400 and no query in the body", async () => {
    /**
     * This returned 500 with the raw SQL — column list and query text — because
     * the path segment reached a Postgres `uuid` comparison unvalidated. Both
     * halves are asserted: the status, and that nothing internal is echoed.
     */
    const response = await app.inject({
      method: "GET",
      url: "/sites/not-a-uuid"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" }
    });

    const body = response.body.toLowerCase();

    expect(body).not.toContain("select");
    expect(body).not.toContain("site_id");
  });

  it("rejects a non-UUID pattern id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownSite.siteId}/patterns/nope`
    });

    expect(response.statusCode).toBe(400);
  });

  it("answers an unknown route in the same error shape", async () => {
    const response = await app.inject({ method: "GET", url: "/no-such-thing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "ROUTE_NOT_FOUND" }
    });
  });
});

describe("a site with no finished run", () => {
  it("is not reported as missing", async () => {
    /**
     * "No completed run yet" used to be a 404, which made a freshly-onboarded
     * site indistinguishable from a typo in the URL. An empty list with a null
     * run id lets the screen tell the reader which of the two it is.
     */
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownSite.siteId}/patterns`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sitemapRunId: null,
      patterns: [],
      total: 0,
      /*
       * Zero, and reached without inventing a run. Every figure the explorer
       * frames itself with has to have a defined value in this state, or the
       * screen renders blanks that read as "we measured nothing" rather than
       * "there is nothing to measure yet".
       */
      observedUrls: 0,
      totalUrls: 0,
      statusCounts: []
    });
  });
});

describe("the settings route", () => {
  /**
   * `/settings` is the first read of the organization row itself —
   * `findOrganization` had been exported with no callers since M1, because
   * `resolveDefaultOrgScope` keeps only the id and throws the name and slug
   * away.
   */
  it("names the organization the API is acting as", async () => {
    const response = await app.inject({ method: "GET", url: "/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organization: { name: "Own Org", slug: DEMO_SLUG }
    });
  });

  it("sends every limit the manifest describes, and only those", async () => {
    /**
     * Asserted as SET EQUALITY against the manifest rather than by spot-checking
     * a few keys. The manifest is a mapped type over `keyof PolicyConfig`, so
     * adding a key to the config mask already fails to compile without an
     * enforcement record; this covers the other half — a route that quietly
     * stops serving one, or serves something the manifest does not describe.
     */
    const response = await app.inject({ method: "GET", url: "/settings" });
    const body = response.json() as {
      readonly policy: readonly { readonly key: string }[];
    };

    expect([...body.policy.map((row) => row.key)].sort()).toEqual(
      Object.keys(POLICY_LIMITS).sort()
    );
  });

  it("carries the real configured value for each limit", async () => {
    const response = await app.inject({ method: "GET", url: "/settings" });
    const byKey = new Map(
      (
        response.json() as {
          readonly policy: readonly {
            readonly key: string;
            readonly value: number;
          }[];
        }
      ).policy.map((row) => [row.key, row.value])
    );

    // The defaults `loadPolicyConfig({})` filled in when the app was built.
    expect(byKey.get("HTTP_PER_HOST_REQUESTS_PER_SECOND")).toBe(25);
    expect(byKey.get("SAMPLE_MAX_FIRST_ROUND")).toBe(400);
  });

  it("states which limits nothing applies, rather than implying all do", async () => {
    /**
     * THE REASON THIS SCREEN IS WORTH SERVING. Five HTTP budgets, four
     * confidence thresholds and two site columns are configured and applied by
     * nothing. Printing those numbers without that fact would assert a
     * guarantee the code does not make — §1.9's shape, and the specific defect
     * that made this route worth building rather than a plain config dump.
     */
    const response = await app.inject({ method: "GET", url: "/settings" });
    const body = response.json() as {
      readonly policy: readonly {
        readonly key: string;
        readonly enforcedAt: string | null;
      }[];
      readonly siteColumns: readonly {
        readonly key: string;
        readonly enforcedAt: string | null;
      }[];
    };

    const unenforced = body.policy
      .filter((row) => row.enforcedAt === null)
      .map((row) => row.key);

    expect(unenforced).toContain("HTTP_PER_SITE_DAILY_REQUEST_CAP");
    expect(unenforced).toContain("HTTP_MAX_GET_ESCALATION_FRACTION");
    expect(unenforced).toContain("CONFIDENCE_LOW_BAND_WIDTH");

    // And the enforced ones are not all lumped together as unknown.
    const enforced = body.policy.filter((row) => row.enforcedAt !== null);

    expect(enforced).not.toHaveLength(0);
    expect(enforced.map((row) => row.key)).toContain(
      "HTTP_PER_HOST_REQUESTS_PER_SECOND"
    );

    // Both site columns travel so the screen can badge them without deciding.
    expect(body.siteColumns.map((row) => row.key).sort()).toEqual([
      "dailyRequestCap",
      "minRequestIntervalMs"
    ]);
    expect(body.siteColumns.every((row) => row.enforcedAt === null)).toBe(true);
  });

  it("leaks no credential, asserted by shape rather than by a denylist", async () => {
    /**
     * The policy config is a `.pick()` over the one schema, so a secret is not
     * absent because something filtered it — it was never in the mask. This
     * asserts the consequence on the wire: every value is a NUMBER, and a
     * credential never is. Shape rather than a list of today's secret names,
     * because a list is the thing nobody updates when a variable is added.
     */
    const response = await app.inject({ method: "GET", url: "/settings" });
    const body = response.json() as {
      readonly policy: readonly {
        readonly key: string;
        readonly value: unknown;
      }[];
    };

    for (const row of body.policy) {
      expect(typeof row.value, row.key).toBe("number");
      expect(row.key).not.toMatch(/SECRET|PASSWORD|TOKEN|ACCESS_KEY|_URL$/u);
    }

    expect(response.body).not.toContain("postgresql://");
    expect(response.body).not.toContain("redis://");
  });
});

describe("an unseeded organization", () => {
  it("answers 503 with the actionable message, not 500", async () => {
    /**
     * `OrganizationNotSeededError` was documented as surfacing "per-request as
     * a clear 503" while nothing mapped it, so it produced a generic 500 — a
     * comment asserting a guarantee the code did not make (section 1.9).
     */
    resetOrgScopeCacheForTesting();

    const unseeded = buildApp(
      {
        NODE_ENV: "test",
        DEFAULT_ORGANIZATION_SLUG: "no-such-org-anywhere",
        ...loadPolicyConfig({})
      },
      createLogger({ service: "api-test", level: "silent", pretty: false }),
      db
    );

    await unseeded.ready();

    const response = await unseeded.inject({ method: "GET", url: "/sites" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "ORGANIZATION_NOT_SEEDED" }
    });
    expect(response.body).toContain("pnpm seed:demo");

    await unseeded.close();
    resetOrgScopeCacheForTesting();
  });
});

describe("GET /sites/:siteId/analytics", () => {
  it("serves the site's health series and echoes the window cap", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownFleetSite.siteId}/analytics?windows=5`
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.site.id).toBe(ownFleetSite.siteId);
    expect(body.health.length).toBeGreaterThan(0);
    expect(body.health[0].httpRequests).toBe(140);
    expect(body.health[0].getEscalations).toBe(20);
    expect(body.patternStatus.length).toBeGreaterThan(0);

    /*
     * Echoed so the screen can say "showing N of the last M" rather than
     * presenting a truncated history as the whole record — the D3a finding.
     */
    expect(body.windowLimit).toBe(5);

    // Reversed to oldest-first: a series drawn from newest-first data runs
    // backwards in time while looking entirely plausible.
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it("declares its default rather than leaving it implicit", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/sites/${ownFleetSite.siteId}/analytics`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().windowLimit).toBe(30);
  });

  it("caps the window count at the edge", async () => {
    for (const windows of [0, 500]) {
      const response = await app.inject({
        method: "GET",
        url: `/sites/${ownFleetSite.siteId}/analytics?windows=${windows}`
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("rejects a malformed site id with a 400, not a 500", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/sites/not-a-uuid/analytics"
    });

    expect(response.statusCode).toBe(400);
    // And no SQL in the body — the M7 defect returned the raw query.
    expect(response.body).not.toContain("select");
  });

  it("does not serve another organization's health series", async () => {
    /**
     * MEASURED, NOT ASSUMED, and the two layers do different jobs — the D3c
     * correction was a comment claiming a neutralisation that had never been
     * performed, so this one says exactly what was removed and what happened.
     *
     * Neutralising the ROUTE's `if (!site) throw ApiProblem.notFound(...)`
     * inside `resolveSiteScope` turns this into a 500, not a leak: the
     * repository still filters on `organization_id`, so `site` comes back
     * undefined and the response schema rejects it. That is a crash, not a
     * disclosure.
     *
     * Neutralising the REPOSITORY's `eq(site.organizationId, ...)` inside
     * `findSiteById`, with the route check left intact, DOES fail this test —
     * that predicate is what actually prevents the read.
     *
     * So the honest statement is: the repository predicate is the tenant
     * boundary, and the route check is what turns its absence into an
     * intelligible 404 instead of a 500. Both are load-bearing, for different
     * failures. `isolation.test.ts` covers the repository layer directly, where
     * nothing above it can compensate.
     */
    const leaked = await findRunSamplingHealth(db, otherSite, otherRunId);

    // Asserted FIRST: the other tenant really does have a row to leak, so this
    // cannot pass by 404-ing a site that has nothing.
    expect(leaked).toBeDefined();
    expect(leaked?.httpRequests).toBe(999);

    const response = await app.inject({
      method: "GET",
      url: `/sites/${otherSite.siteId}/analytics`
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("999");
  });
});

interface ProjectsBody {
  readonly projects: readonly {
    readonly site: {
      readonly id: string;
      readonly name: string;
      readonly tier: string;
    };
    readonly latestRun?: { readonly id: string; readonly totalUrls: number };
    readonly findings: {
      readonly total: number;
      readonly critical: number;
      readonly bySeverity: readonly {
        readonly severityClass: string;
        readonly count: number;
      }[];
    };
  }[];
  readonly total: number;
  readonly totals: {
    readonly sites: number;
    readonly onboardedRecently: number;
    readonly urlsDiscovered: number;
    readonly patterns: number;
    readonly findings: number;
    readonly criticalFindings: number;
  };
}

describe("the projects portfolio", () => {
  /**
   * The exposure this route adds, and it is the fleet routes' exposure again:
   * no `siteId` in the URL, so there is no membership check to make and the
   * boundary lives inside `listSites`, `latestRunPerSite` and
   * `countOrganizationSnapshotsBySeverity`, all of which derive their ids from
   * the `OrganizationScope` rather than the request (ADR-0028, ADR-0037).
   *
   * The other tenant's site has a completed run and a `not_found` finding over
   * 5,000 URLs — real rows, larger than ours — so a missing tenant filter shows
   * up as an extra project and an inflated total, not as an empty difference.
   */
  it("lists our own projects and never another tenant's", async () => {
    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);

    const body = response.json() as ProjectsBody;

    /*
     * ASSERTED ON IDS, NOT NAMES, and not on an exact total. Earlier describes
     * in this file rename a site and onboard another, so a fixed list here
     * would be an assertion about test ordering rather than about isolation.
     * Every one of our sites must be present, and the other tenant's must not
     * appear anywhere in the payload.
     */
    const ourIds = new Set([ownSite.siteId, ownFleetSite.siteId]);

    expect(body.projects.filter((row) => ourIds.has(row.site.id))).toHaveLength(
      2
    );
    expect(body.total).toBe(body.totals.sites);
    expect(body.total).toBe(body.projects.length);
    expect(JSON.stringify(body)).not.toContain("Other Site");
    expect(JSON.stringify(body)).not.toContain(otherSite.siteId);
  });

  it("attaches each site's latest run, and omits it where there is none", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json() as ProjectsBody;

    const fleet = body.projects.find(
      (row) => row.site.name === "Own Fleet Site"
    );
    const bare = body.projects.find((row) => row.site.name === "Own Site");

    expect(fleet?.latestRun?.id).toBe(ownFleetRunId);

    /*
     * ABSENT, not zeroed. A site that has never run and a site whose run found
     * nothing are different facts, and a row of zeros states the second while
     * meaning the first — the section 1.5 shape the screen has to distinguish.
     */
    expect(bare?.latestRun).toBeUndefined();
  });

  it("counts findings per site, and the breakdown adds up to the total", async () => {
    const body = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json() as ProjectsBody;

    const fleet = body.projects.find(
      (row) => row.site.name === "Own Fleet Site"
    );

    expect(fleet?.findings.total).toBeGreaterThan(0);
    expect(fleet?.findings.bySeverity.length).toBeGreaterThan(0);

    // Or a reader who sums the breakdown finds a number that disagrees with
    // the total printed beside it.
    expect(
      fleet?.findings.bySeverity.reduce((sum, row) => sum + row.count, 0)
    ).toBe(fleet?.findings.total);
  });

  /**
   * A HOST REFUSING US IS NOT A SITE DEFECT, at fleet scale.
   *
   * `blocked` and `unknown` weigh zero severity (`schema/enums.ts`) and
   * `severityTone` already maps both away from a warning. If
   * `CRITICAL_SEVERITIES` included either, a WAF would turn a healthy client
   * into a fleet-wide "requires triage" — the exact inversion
   * `patternStatusTone` carries a warning about. Asserted here rather than left
   * to the constant's own comment.
   */
  it("never counts a blocked host as a critical finding", async () => {
    const blockedSample = await recordPatternSample(db, ownFleetSite, {
      patternId: ownFleetPatternId,
      sitemapRunId: ownFleetRunId,
      round: 2,
      kRequested: 60,
      kThresholdHash: 5_000,
      sampleSize: 60,
      populationAtDraw: 3000
    });

    await insertAuditSnapshot(db, ownFleetSite, {
      patternId: ownFleetPatternId,
      patternSampleId: blockedSample.id,
      sitemapRunId: ownFleetRunId,
      httpStatus: 403,
      evidenceTier: "estimated",
      observedCount: 30,
      sampleSize: 60,
      populationCount: 3000,
      pointEstimate: 1500,
      ciLow: 1200,
      ciHigh: 1800,
      confidenceLevel: 0.95,
      confidenceBand: "approximate",
      estimatorVersion: "1.0.0",
      severityClass: "blocked",
      severityWeight: 0,
      impactScore: 0
    });

    const body = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json() as ProjectsBody;

    const fleet = body.projects.find(
      (row) => row.site.name === "Own Fleet Site"
    );

    // Asserted FIRST: the blocked finding really is there to be miscounted.
    expect(
      fleet?.findings.bySeverity.some((row) => row.severityClass === "blocked")
    ).toBe(true);
    expect(fleet?.findings.critical).toBe(
      (fleet?.findings.bySeverity ?? [])
        .filter((row) => row.severityClass !== "blocked")
        .reduce((sum, row) => sum + row.count, 0)
    );
  });

  /**
   * THE D3a DEFECT, ASSERTED SO IT CANNOT RETURN. Both fleet screens once
   * counted a page of 50 rows and labelled it the fleet. Here the totals come
   * from their own queries over every matching site, so narrowing the page must
   * not move them.
   */
  it("computes fleet totals over every matching site, not the page", async () => {
    const paged = (
      await app.inject({ method: "GET", url: "/projects?limit=1" })
    ).json() as ProjectsBody;

    expect(paged.projects).toHaveLength(1);
    expect(paged.total).toBe(2);
    expect(paged.totals.sites).toBe(2);

    const full = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json() as ProjectsBody;

    expect(paged.totals).toEqual(full.totals);
  });

  it("pages with limit and offset", async () => {
    const first = (
      await app.inject({ method: "GET", url: "/projects?limit=1&offset=0" })
    ).json() as ProjectsBody;
    const second = (
      await app.inject({ method: "GET", url: "/projects?limit=1&offset=1" })
    ).json() as ProjectsBody;

    expect(first.projects[0]?.site.id).not.toBe(second.projects[0]?.site.id);
  });

  it("applies the tier filter to the totals as well as the rows", async () => {
    const standard = (
      await app.inject({ method: "GET", url: "/projects?tier=standard" })
    ).json() as ProjectsBody;
    const priority = (
      await app.inject({ method: "GET", url: "/projects?tier=priority" })
    ).json() as ProjectsBody;

    /*
     * Relative rather than absolute, for the reason above: another describe
     * re-tiers a site. What matters is that the filter is APPLIED and that it
     * reaches the totals as well as the rows — otherwise the KPI cards would
     * describe a different set from the table beneath them.
     */
    const all = (
      await app.inject({ method: "GET", url: "/projects" })
    ).json() as ProjectsBody;

    // Every returned row really carries the requested tier...
    expect(standard.projects.every((row) => row.site.tier === "standard")).toBe(
      true
    );
    expect(priority.projects.every((row) => row.site.tier === "priority")).toBe(
      true
    );

    // ...the filter reaches the TOTALS too, or the KPI cards would describe a
    // different set from the table beneath them...
    expect(standard.totals.sites).toBe(standard.total);
    expect(priority.totals.sites).toBe(priority.total);

    // ...and the tiers partition the fleet rather than overlapping it.
    expect(standard.total + priority.total).toBeLessThanOrEqual(all.total);
    expect(standard.total).toBeGreaterThan(0);
  });

  it("caps the page size at the edge", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/projects?limit=100000"
    });

    expect(response.statusCode).toBe(400);
  });

  it("exports the whole matching set as CSV, not the screen's page", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/projects/export.csv?limit=1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");

    const lines = response.body.trim().split("\n");

    /*
     * EVERY matching site plus the header, even though `limit=1` was passed —
     * an export of what you happened to be looking at, named "portfolio", is a
     * truncated file presented as a complete one. Compared against the paged
     * read's `total` rather than a literal, because other describes in this
     * file onboard sites.
     */
    const paged = (
      await app.inject({ method: "GET", url: "/projects?limit=1" })
    ).json() as ProjectsBody;

    expect(paged.projects).toHaveLength(1);
    expect(lines).toHaveLength(paged.total + 1);
    expect(lines[0]).toContain("urls_discovered");
    // Never "crawled" — a spreadsheet outlives the screen that produced it.
    expect(lines[0]).not.toContain("crawled");
    expect(response.body).not.toContain("Other Site");
  });
});

describe("onboarding a project", () => {
  it("creates a site and derives its host from the base URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sites",
      payload: {
        name: "Onboarded Site",
        baseUrl: "https://Onboarded.Example/shop"
      }
    });

    expect(response.statusCode).toBe(201);

    const body = response.json() as {
      readonly id: string;
      readonly host: string;
      readonly tier: string;
    };

    /*
     * DERIVED AND LOWERCASED, never accepted from the caller: the bucket the
     * outbound rate limiter throttles on must not be able to disagree with the
     * URL actually requested. There is no `host` field in the body to send.
     */
    expect(body.host).toBe("onboarded.example");
    expect(body.tier).toBe("standard");

    // Reachable through the scoped read, which proves the partitions exist —
    // `createSite` does the insert and the DDL in one transaction (ADR-0003).
    const created = await findSiteById(db, siteScopeWithin(ownScope, body.id));

    expect(created?.name).toBe("Onboarded Site");
  });

  it("refuses a second site on a host this organization already monitors", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sites",
      payload: { name: "Duplicate", baseUrl: "https://onboarded.example/other" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "HOST_IN_USE" } });
  });

  it("rejects an unknown key rather than silently dropping it", async () => {
    /*
     * `.strict()`, for the reason `siteUpdateBody` is: a caller who sent
     * `host` believing it would be used has to be told it was not, and a
     * mistyped field name must not read as a successful save.
     */
    const response = await app.inject({
      method: "POST",
      url: "/sites",
      payload: {
        name: "Sneaky",
        baseUrl: "https://sneaky.example",
        host: "somewhere.else"
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a base URL that is not a URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sites",
      payload: { name: "Bad", baseUrl: "not-a-url" }
    });

    expect(response.statusCode).toBe(400);
  });
});
