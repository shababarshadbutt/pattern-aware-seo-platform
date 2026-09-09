import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOrganization } from "./repositories/organization.js";
import {
  listPatternsByPopulation,
  upsertPatterns
} from "./repositories/pattern.js";
import {
  sumPatternPopulation,
  upsertPatternPopulations
} from "./repositories/pattern-population.js";
import { createSite } from "./repositories/site.js";
import { upsertSitemapFiles } from "./repositories/sitemap-file.js";
import { startRun } from "./repositories/sitemap-run.js";
import type { SiteScope } from "./scope.js";
import { createTestDatabase, type TestDatabase } from "./test-harness.js";

/**
 * Regression coverage for the bulk-write bind-parameter ceiling (Phase 2A,
 * A2).
 *
 * Before `chunk.ts`, `upsertPatternPopulations` issued one `INSERT ...
 * VALUES` for its entire input. That table binds 4 parameters per row, so
 * more than 16,383 rows in a single call exceeded Postgres's 65,535-parameter
 * ceiling and failed outright — a real shape at 50-90M-URL scale, where a
 * site's pattern count times its file count routinely exceeds that. These
 * tests build exactly that cardinality against a real database rather than
 * asserting against the chunking helper in isolation.
 */

let harness: TestDatabase;
let orgScope: Awaited<ReturnType<typeof createOrganization>>["scope"];

beforeAll(async () => {
  harness = await createTestDatabase();

  const org = await createOrganization(harness.db, {
    name: "Bulk Write Fixtures",
    slug: "bulk-write-fixtures"
  });

  orgScope = org.scope;
}, 60_000);

afterAll(async () => {
  await harness?.destroy();
});

/**
 * Each test gets its own site rather than sharing one, so
 * `uq_sitemap_run_one_active_per_site` (a run is never finished here - these
 * tests exercise the write path, not the run lifecycle) cannot make one
 * test's in-flight run block the next test's `startRun`.
 */
async function newSiteScope(name: string): Promise<SiteScope> {
  const created = await createSite(harness.db, orgScope, {
    name,
    baseUrl: `https://${name}.bulk-write.test`
  });

  return created.scope;
}

describe("upsertPatternPopulations chunking", () => {
  it("writes more than 20,000 population rows in one call without hitting Postgres's bind-parameter ceiling", async () => {
    const scope = await newSiteScope("population-chunking");
    const runId = (
      await startRun(harness.db, scope, { workerId: "bulk-write-test" })
    ).id;

    const PATTERN_COUNT = 150;
    const FILE_COUNT = 150; // 150 x 150 = 22,500 rows > 20,000, and > the
    // 16,383-row ceiling a naive single INSERT would hit at 4 columns/row.

    await upsertPatterns(
      harness.db,
      scope,
      runId,
      Array.from({ length: PATTERN_COUNT }, (_, i) => ({
        template: `/bulk/${i}/{param}`,
        segmentCount: 3,
        populationCount: FILE_COUNT,
        fileCount: FILE_COUNT
      }))
    );

    const files = await upsertSitemapFiles(
      harness.db,
      scope,
      runId,
      Array.from({ length: FILE_COUNT }, (_, i) => ({
        url: `https://bulk-write.test/sitemap-${i}.xml`,
        fileOrdinal: i + 1
      }))
    );

    const patterns = await listPatternsByPopulation(
      harness.db,
      scope,
      runId,
      PATTERN_COUNT
    );

    expect(patterns.length).toBe(PATTERN_COUNT);
    expect(files.length).toBe(FILE_COUNT);

    const rows = patterns.flatMap((pattern) =>
      files.map((file) => ({
        patternId: pattern.id,
        sitemapFileId: file.id,
        urlCount: 1
      }))
    );

    expect(rows.length).toBe(PATTERN_COUNT * FILE_COUNT);
    expect(rows.length).toBeGreaterThan(20_000);

    const written = await upsertPatternPopulations(harness.db, scope, rows);

    expect(written).toBe(rows.length);

    const [firstPattern] = patterns;

    if (firstPattern === undefined) {
      throw new Error("expected at least one pattern from the fixture above");
    }

    // Not just "it didn't throw" - every row actually landed, split across
    // however many chunks that took.
    const total = await sumPatternPopulation(
      harness.db,
      scope,
      firstPattern.id
    );

    expect(total).toBe(FILE_COUNT);
  }, 120_000);
});

describe("upsertPatterns chunking", () => {
  it("accumulates correctly across chunk boundaries, not just within one chunk", async () => {
    const scope = await newSiteScope("pattern-chunking");
    const runId = (
      await startRun(harness.db, scope, { workerId: "bulk-write-test-2" })
    ).id;

    // 12,000 distinct templates forces more than one chunk at the 6-columns
    // -per-row default (60,000 / 6 = 10,000 rows/chunk), so this exercises
    // the loop across a chunk boundary rather than staying inside one.
    const TEMPLATE_COUNT = 12_000;

    const patterns = Array.from({ length: TEMPLATE_COUNT }, (_, i) => ({
      template: `/many/${i}/{param}`,
      segmentCount: 2,
      populationCount: 1,
      fileCount: 1
    }));

    const written = await upsertPatterns(harness.db, scope, runId, patterns);

    expect(written).toBe(TEMPLATE_COUNT);

    const stored = await listPatternsByPopulation(
      harness.db,
      scope,
      runId,
      TEMPLATE_COUNT
    );

    expect(stored.length).toBe(TEMPLATE_COUNT);

    // Additive-on-conflict semantics must still hold across a second call
    // that lands in a different chunk than the first (last template in the
    // input, so its row was written by the final chunk of the prior call).
    const secondPass = await upsertPatterns(harness.db, scope, runId, [
      {
        template: `/many/${TEMPLATE_COUNT - 1}/{param}`,
        segmentCount: 2,
        populationCount: 5,
        fileCount: 1
      }
    ]);

    expect(secondPass).toBe(1);

    const refreshed = await listPatternsByPopulation(
      harness.db,
      scope,
      runId,
      TEMPLATE_COUNT
    );
    const last = refreshed.find(
      (p) => p.template === `/many/${TEMPLATE_COUNT - 1}/{param}`
    );

    expect(last?.populationCount).toBe(1 + 5);
  }, 120_000);
});
