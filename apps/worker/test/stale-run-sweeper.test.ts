import {
  createOrganization,
  createSite,
  findRunById,
  finishRun,
  startRun
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger } from "@pattern-aware/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepStaleRuns } from "../src/stale-run-sweeper.js";

/**
 * The recovery path the schema has always described (`heartbeat_at`,
 * `idx_sitemap_run_heartbeat`) but that nothing implemented until now — see
 * `sweepStaleRuns`'s own docblock for why this is the backstop for a WORKER
 * PROCESS dying mid-run, not a duplicate of `SitePipeline`'s event-driven
 * failure handling.
 *
 * A real Postgres, no Redis and no HTTP — the sweeper is pure database logic.
 */

let harness: TestDatabase;
const logger = createLogger({
  service: "sweeper-test",
  level: "silent",
  pretty: false
});

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness.destroy();
});

describe("sweepStaleRuns", () => {
  it("fails a running run whose heartbeat has gone quiet, and frees its slot", async () => {
    const org = await createOrganization(harness.db, {
      name: "Sweeper Org",
      slug: `sweeper-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Stale Site",
      baseUrl: "https://stale.example"
    });

    const run = await startRun(harness.db, site.scope, {
      workerId: "sweeper-test"
    });

    /**
     * A THRESHOLD OF ZERO, not a real wait. `startRun` stamps `heartbeat_at`
     * at `now()`; by the time this line executes, even a single round trip
     * to Postgres has already made that timestamp older than 0ms. Real
     * deployments use a threshold measured in minutes — see
     * `HEARTBEAT_STALE_THRESHOLD_MS` — this just proves the mechanism
     * without an actual multi-minute wait.
     */
    const failedCount = await sweepStaleRuns(harness.db, logger, 0);

    expect(failedCount).toBeGreaterThanOrEqual(1);

    const after = await findRunById(harness.db, site.scope, run.id);

    expect(after?.status).toBe("failed");
    expect(after?.statusReason).toContain("STALE_HEARTBEAT");

    // The slot is freed: a new run can now be started for this site.
    const secondRun = await startRun(harness.db, site.scope, {
      workerId: "sweeper-test-2"
    });

    expect(secondRun.id).not.toBe(run.id);
  });

  it("leaves a run alone when its heartbeat is comfortably within the threshold", async () => {
    const org = await createOrganization(harness.db, {
      name: "Sweeper Org Healthy",
      slug: `sweeper-healthy-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Healthy Site",
      baseUrl: "https://healthy.example"
    });

    const run = await startRun(harness.db, site.scope, {
      workerId: "sweeper-test"
    });

    // A generous threshold: this run's heartbeat is seconds old, not hours.
    await sweepStaleRuns(harness.db, logger, 60 * 60 * 1000);

    const after = await findRunById(harness.db, site.scope, run.id);

    expect(after?.status).toBe("running");
  });

  it("does not overwrite a run that finished between the read and the write", async () => {
    /**
     * `failStaleRun`'s own `WHERE status = 'running'` guard, exercised: a run
     * already `complete` by the time the sweep gets to it must not be
     * stamped `failed` over top of a real result.
     */
    const org = await createOrganization(harness.db, {
      name: "Sweeper Org Race",
      slug: `sweeper-race-${Date.now()}`
    });

    const site = await createSite(harness.db, org.scope, {
      name: "Finished Site",
      baseUrl: "https://finished.example"
    });

    const run = await startRun(harness.db, site.scope, {
      workerId: "sweeper-test"
    });

    await finishRun(harness.db, site.scope, run.id, { status: "complete" });

    await sweepStaleRuns(harness.db, logger, 0);

    const after = await findRunById(harness.db, site.scope, run.id);

    expect(after?.status).toBe("complete");
  });
});
