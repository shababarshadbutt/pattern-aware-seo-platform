import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { internalDatabase } from "./client.js";
import { PARTITIONED_TABLES, partitionName } from "./partitions.js";
import { createOrganization } from "./repositories/organization.js";
import {
  listPatternsByPopulation,
  upsertPatterns
} from "./repositories/pattern.js";
import { createSite, findSiteById, listSites } from "./repositories/site.js";
import { startRun } from "./repositories/sitemap-run.js";
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
}, 60_000);

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
        insert into sitemap_file (site_id, sitemap_run_id, url)
        values (${acmeSite.siteId}, ${rivalRunId}, 'https://parts.acme-aviation.test/s.xml')
      `)
    ).rejects.toThrow();
  });

  it("still accepts a row whose site and run agree", async () => {
    const db = internalDatabase(harness.db);

    await expect(
      db.execute(sql`
        insert into sitemap_file (site_id, sitemap_run_id, url)
        values (${acmeSite.siteId}, ${acmeRunId}, 'https://parts.acme-aviation.test/ok.xml')
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
});
