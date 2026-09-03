import {
  createOrganization,
  createSite,
  type Database,
  finishRun,
  insertAuditSnapshot,
  listPatternsByPopulation,
  type OrganizationScope,
  recordPatternSample,
  type SiteScope,
  startRun,
  upsertPatterns
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger } from "@pattern-aware/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { resetOrgScopeCacheForTesting } from "../src/org-scope.js";

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

  resetOrgScopeCacheForTesting();

  /**
   * A two-field literal, not `loadConfig(process.env)`.
   *
   * `buildApp` takes only what it reads (see ApiConfig). Validating the whole
   * environment here would make this suite depend on REDIS_URL, which no route
   * touches — and it did, until the type was narrowed.
   */
  app = buildApp(
    { NODE_ENV: "test", DEFAULT_ORGANIZATION_SLUG: DEMO_SLUG },
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
    expect(response.json()).toEqual({ sitemapRunId: null, patterns: [] });
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
      { NODE_ENV: "test", DEFAULT_ORGANIZATION_SLUG: "no-such-org-anywhere" },
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
