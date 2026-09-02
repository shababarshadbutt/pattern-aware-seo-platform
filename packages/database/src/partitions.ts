import { sql } from "drizzle-orm";

import {
  type Database,
  type InternalDatabase,
  internalDatabase
} from "./client.js";

/**
 * The narrowest thing this module needs: something that can run a statement.
 *
 * Typed structurally rather than as `InternalDatabase` so the same helpers work
 * inside a Drizzle transaction, which is what lets site onboarding create the
 * row and its partitions atomically.
 */
export type SqlExecutor = Pick<InternalDatabase, "execute">;

/**
 * Every table declared `PARTITION BY LIST (site_id)` in the migrations.
 *
 * Onboarding a site creates one partition of each. If a new partitioned table is
 * added to the schema and not added here, that table gets no partition for new
 * sites and every insert against it fails at runtime — so
 * `partitions.test.ts` asserts this list matches what the database actually
 * reports as partitioned, rather than trusting the two to be kept in step.
 */
export const PARTITIONED_TABLES = [
  "sitemap_file",
  "pattern",
  "pattern_population",
  "pattern_sample",
  "sample_observation",
  "audit_snapshot"
] as const;

export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

/**
 * Hex-and-dashes only.
 *
 * Partition bounds and table identifiers cannot be bound parameters — Postgres
 * takes them as literal syntax — so this is the one place in the codebase that
 * interpolates a value into SQL, against the standards' blanket rule (section
 * 2.3). Validating against this pattern first is what makes it safe: a string
 * that matches contains nothing but `[0-9a-f]` and `-`, so there is no quote to
 * close and no statement to append. Anything else throws before touching the
 * database.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when a value that will reach DDL is not a well-formed UUID. */
export class InvalidPartitionKeyError extends Error {
  public override readonly name = "InvalidPartitionKeyError";
}

function assertUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new InvalidPartitionKeyError(
      `Refusing to build partition DDL from a value that is not a UUID: ${JSON.stringify(value)}`
    );
  }

  return value.toLowerCase();
}

/**
 * The child table name for one site's slice of one parent.
 *
 * Dashes are stripped because they are legal in a quoted identifier but make
 * every `\dt` listing harder to read. The longest result —
 * `sample_observation_p_<32 hex>` at 53 characters — stays inside Postgres's
 * 63-byte identifier limit, which is why the UUID is not truncated.
 */
export function partitionName(table: PartitionedTable, siteId: string): string {
  return `${table}_p_${assertUuid(siteId).replaceAll("-", "")}`;
}

async function createOne(
  db: SqlExecutor,
  table: PartitionedTable,
  siteId: string
): Promise<void> {
  const child = partitionName(table, siteId);

  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS "${child}" PARTITION OF "${table}" FOR VALUES IN ('${assertUuid(siteId)}')`
    )
  );
}

/**
 * Create this site's partition of every partitioned table.
 *
 * Call inside the same transaction as the `site` insert — Postgres DDL is
 * transactional, so a site and its storage either both exist or neither does.
 * A site row without partitions would accept no patterns at all, and would fail
 * at ingestion time rather than at onboarding time where the cause is obvious.
 *
 * Idempotent, so a retried onboarding is safe.
 *
 * DELIBERATELY NO DEFAULT PARTITION on any parent. A default partition would
 * silently absorb rows for a site whose partition is missing: they would be
 * hard to find, they would defeat partition pruning for every query against
 * that table, and detaching them later requires a full scan. Failing the insert
 * loudly is the better outcome.
 */
export async function createSitePartitions(
  db: Database,
  siteId: string
): Promise<void> {
  await createSitePartitionsWith(internalDatabase(db), siteId);
}

/**
 * As {@link createSitePartitions}, but against an executor the caller already
 * holds — a transaction, in practice. This is the form site onboarding uses.
 */
export async function createSitePartitionsWith(
  executor: SqlExecutor,
  siteId: string
): Promise<void> {
  for (const table of PARTITIONED_TABLES) {
    await createOne(executor, table, siteId);
  }
}

/**
 * Drop this site's partitions and everything in them.
 *
 * Irreversible and unguarded, so it is not part of ordinary site deletion —
 * `site.deleted_at` handles that, and keeping the data is what makes a
 * soft-deleted site restorable. This exists for test teardown and for a
 * deliberate, audited hard-delete.
 */
export async function dropSitePartitions(
  db: Database,
  siteId: string
): Promise<void> {
  const internal: SqlExecutor = internalDatabase(db);

  // Reverse order: children before the tables they reference.
  for (const table of [...PARTITIONED_TABLES].reverse()) {
    await internal.execute(
      sql.raw(`DROP TABLE IF EXISTS "${partitionName(table, siteId)}"`)
    );
  }
}
