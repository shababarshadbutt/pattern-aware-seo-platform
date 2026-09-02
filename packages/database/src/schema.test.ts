import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { internalDatabase } from "./client.js";
import { PARTITIONED_TABLES } from "./partitions.js";
import { createTestDatabase, type TestDatabase } from "./test-harness.js";

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await harness?.destroy();
});

interface RelationRow extends Record<string, unknown> {
  readonly relname: string;
  readonly relkind: string;
  readonly partkeydef: string | null;
}

async function relations(): Promise<readonly RelationRow[]> {
  const result = await internalDatabase(harness.db).execute<RelationRow>(sql`
    select c.relname, c.relkind::text as relkind, pg_get_partkeydef(c.oid) as partkeydef
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname not like 'psp_%'
    order by c.relname
  `);

  return result.rows;
}

describe("migrations", () => {
  // The plainest form of the M1 acceptance criterion: the migration set applies
  // to an empty Postgres 16 without manual intervention. createTestDatabase()
  // runs it, so reaching this test at all is most of the proof.
  it("apply cleanly to an empty database", async () => {
    const names = (await relations()).map((r) => r.relname);

    expect(names).toEqual([
      "audit_snapshot",
      "organization",
      "pattern",
      "pattern_population",
      "pattern_sample",
      "sample_observation",
      "sampling_health",
      "site",
      "sitemap_file",
      "sitemap_run"
    ]);
  });

  /**
   * The partitioning is added by hand to the generated SQL, because Drizzle
   * cannot express it (ADR-0010). That makes it exactly the kind of thing a
   * regeneration would silently drop, so it is asserted rather than assumed.
   */
  it("declare every large table as partitioned by site_id", async () => {
    const partitioned = (await relations())
      .filter((r) => r.relkind === "p")
      .map((r) => r.relname);

    expect(partitioned.sort()).toEqual([...PARTITIONED_TABLES].sort());

    for (const row of await relations()) {
      if (row.relkind === "p") {
        expect(row.partkeydef).toBe("LIST (site_id)");
      }
    }
  });

  /**
   * PARTITIONED_TABLES drives per-site partition creation. If a partitioned
   * table is added to the schema and not to that list, new sites silently get no
   * partition for it and every insert fails at runtime — far from the cause.
   * This is the guard against the two drifting apart.
   */
  it("keep PARTITIONED_TABLES in step with the database", async () => {
    const actual = (await relations())
      .filter((r) => r.relkind === "p")
      .map((r) => r.relname)
      .sort();

    expect([...PARTITIONED_TABLES].sort()).toEqual(actual);
  });

  it("start with no partitions, so onboarding is what creates them", async () => {
    const result = await internalDatabase(harness.db).execute<{
      count: string;
    }>(sql`
      select count(*)::text as count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relispartition
    `);

    expect(result.rows[0]?.count).toBe("0");
  });
});
