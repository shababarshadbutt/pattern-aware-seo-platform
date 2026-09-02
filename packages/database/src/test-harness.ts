import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  createDatabase,
  type Database,
  type DatabaseHandle
} from "./client.js";
import { runMigrations } from "./migrate.js";

/**
 * Throwaway databases for integration tests.
 *
 * The coding standards (section 1.10) require database-touching code to run
 * against real Postgres rather than a mocked query layer, and this package is
 * the strongest case for that rule in the codebase: partitioning, composite
 * foreign keys into partitioned parents, partial unique indexes and CHECK
 * constraints are the whole point of the schema, and a mock reproduces none of
 * them. A test suite that passed against a mock would tell us nothing about the
 * thing being built.
 *
 * Each suite gets its own database rather than sharing one with truncation
 * between tests, because these tests create and drop partitions — DDL that
 * would otherwise have suites interfering with each other when run in parallel.
 */

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

const DEFAULT_ADMIN_URL =
  "postgresql://seo_platform:password@localhost:5432/postgres";

/**
 * Pull DATABASE_URL from the repo-root .env when the environment has not
 * already supplied one.
 *
 * Tests are run by Turborepo from each package directory, and Vitest has no
 * equivalent of the `--env-file` flag the apps use, so without this every
 * developer would have to export DATABASE_URL by hand before `pnpm test`. CI
 * sets the variable directly and this is a no-op there.
 */
function loadRootEnvOnce(): void {
  if (process.env.DATABASE_URL !== undefined) {
    return;
  }

  try {
    process.loadEnvFile(
      fileURLToPath(new URL("../../../.env", import.meta.url))
    );
  } catch {
    // No .env checked out; fall through to DEFAULT_ADMIN_URL.
  }
}

function adminConnectionString(): string {
  loadRootEnvOnce();

  const configured = process.env.DATABASE_URL;

  if (configured === undefined || configured === "") {
    return DEFAULT_ADMIN_URL;
  }

  // Same server, `postgres` database — CREATE DATABASE cannot run from inside
  // the database being created.
  const url = new URL(configured);

  url.pathname = "/postgres";

  return url.toString();
}

function databaseUrlFor(name: string): string {
  const admin = new URL(adminConnectionString());

  admin.pathname = `/${name}`;

  return admin.toString();
}

export interface TestDatabase extends DatabaseHandle {
  readonly db: Database;
  readonly name: string;
  /** Drop the whole database. Safe to call twice. */
  destroy(): Promise<void>;
}

/**
 * Create a migrated, empty database.
 *
 * The name is random rather than derived from the suite so two runs of the same
 * suite — a watch-mode rerun overlapping its predecessor, say — cannot collide.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `psp_test_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminConnectionString() });

  await admin.connect();

  try {
    // Identifier is hex from randomBytes, so there is nothing to escape.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const connectionString = databaseUrlFor(name);

  await runMigrations({
    connectionString,
    migrationsFolder: MIGRATIONS_FOLDER
  });

  const handle = createDatabase({ connectionString, maxConnections: 4 });
  let destroyed = false;

  return {
    db: handle.db,
    name,
    close: handle.close,
    destroy: async () => {
      if (destroyed) {
        return;
      }

      destroyed = true;
      await handle.close();

      const cleanup = new pg.Client({
        connectionString: adminConnectionString()
      });

      await cleanup.connect();

      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    }
  };
}
