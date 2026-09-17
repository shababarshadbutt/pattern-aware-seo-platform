import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { internalDatabase } from "./client.js";
import { createOrganization } from "./repositories/organization.js";
import { createSite } from "./repositories/site.js";
import { findStaleRuns, startRun } from "./repositories/sitemap-run.js";
import type { OrganizationScope } from "./scope.js";
import { createTestDatabase, type TestDatabase } from "./test-harness.js";

/**
 * `findStaleRuns`'s NULL-heartbeat edge, proven directly rather than through
 * `apps/worker`'s `sweepStaleRuns` — that wrapper has no way to produce a
 * `running` row with a null heartbeat, since `startRun` (its only route to
 * `running`) always stamps `heartbeat_at` in the same insert. Reaching that
 * state at all requires the raw update below, which only this package can do
 * without punching a hole in the opaque `Database` type for everyone else.
 *
 * See `findStaleRuns`'s own docblock for the decision this asserts: a
 * `running` row with a null heartbeat is treated as stale immediately, not
 * left to age past the threshold — because SQL's `NULL < x` is `NULL`, which
 * a bare comparison would silently exclude forever.
 *
 * EACH TEST GETS ITS OWN SITE, deliberately, rather than sharing one from
 * `beforeAll`. `uq_sitemap_run_one_active_per_site` allows exactly one
 * pending/running run per site, and the first test below leaves its run
 * `running` on purpose (that is the state under test) rather than closing it
 * out — so a second test starting another run on that SAME site would race
 * that constraint and fail with `ActiveRunExistsError`, a fixture-ordering
 * bug rather than anything `findStaleRuns` did wrong. A fresh site per test
 * costs nothing and removes the coupling entirely.
 */

let harness: TestDatabase;
let orgScope: OrganizationScope;

beforeAll(async () => {
  harness = await createTestDatabase();

  const org = await createOrganization(harness.db, {
    name: "Heartbeat Fixtures",
    slug: `heartbeat-fixtures-${Date.now()}`
  });

  orgScope = org.scope;
});

afterAll(async () => {
  await harness.destroy();
});

describe("findStaleRuns", () => {
  it("catches a running run whose heartbeat is NULL, not just an old one", async () => {
    const siteScope = (
      await createSite(harness.db, orgScope, {
        name: "Heartbeat Null Running Site",
        baseUrl: "https://heartbeat-null-running.test"
      })
    ).scope;

    const run = await startRun(harness.db, siteScope, {
      workerId: "heartbeat-null-test"
    });

    // A threshold of one hour: if NULL were compared like any other value,
    // this run — whose heartbeat was just stamped by `startRun` — would not
    // be anywhere near stale under it. Proves the NULL branch fires
    // independently of the age comparison, not merely alongside it.
    const beforeNulling = await findStaleRuns(harness.db, 60 * 60 * 1000);

    expect(beforeNulling.map((r) => r.id)).not.toContain(run.id);

    // Reach the NULL-heartbeat state directly. No repository function
    // produces it — `startRun` always sets `heartbeat_at`, by design — so
    // this is the one place in the codebase allowed to do it with raw SQL.
    await internalDatabase(harness.db).execute(sql`
      update sitemap_run set heartbeat_at = null
      where id = ${run.id} and site_id = ${siteScope.siteId}
    `);

    const stale = await findStaleRuns(harness.db, 60 * 60 * 1000);

    expect(stale.map((r) => r.id)).toContain(run.id);
  });

  it("does not treat a NULL heartbeat on a non-running run as stale", async () => {
    // `findStaleRuns` is guarded on `status = 'running'` first — a null
    // heartbeat elsewhere (a status this schema does not currently produce
    // outside `running`, but the guard is the thing that would matter if one
    // ever existed) must not widen the sweep beyond in-flight runs.
    const siteScope = (
      await createSite(harness.db, orgScope, {
        name: "Heartbeat Null Non-Running Site",
        baseUrl: "https://heartbeat-null-non-running.test"
      })
    ).scope;

    const run = await startRun(harness.db, siteScope, {
      workerId: "heartbeat-null-non-running-test"
    });

    await internalDatabase(harness.db).execute(sql`
      update sitemap_run set status = 'complete', heartbeat_at = null
      where id = ${run.id} and site_id = ${siteScope.siteId}
    `);

    const stale = await findStaleRuns(harness.db, 0);

    expect(stale.map((r) => r.id)).not.toContain(run.id);
  });
});
