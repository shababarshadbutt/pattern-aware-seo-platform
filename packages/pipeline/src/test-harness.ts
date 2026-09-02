import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDatabase,
  type Database,
  runMigrations
} from "@pattern-aware/database";
import pg from "pg";

/**
 * A throwaway migrated Postgres for this package's end-to-end run.
 *
 * WHY THIS IS NOT IMPORTED FROM packages/database. That package has an
 * equivalent harness, and reusing it would mean publishing a second subpath
 * from its `exports` map — which `compile-guards.test.ts` asserts against by
 * name. The guard's own comment says it is asserted there rather than "left to
 * whoever reviews that change", so widening it is a decision to raise, not one
 * to take while wiring a pipeline. The single-entry-point rule (ADR-0004) is
 * the load-bearing part of the tenant-isolation design and is worth more than
 * the forty lines saved here.
 *
 * Drift is limited by construction: migrations run through the package's own
 * public `runMigrations`, and the handle comes from its public
 * `createDatabase`. What is duplicated is only the CREATE/DROP DATABASE
 * scaffolding around them.
 */

const MIGRATIONS_FOLDER = fileURLToPath(
  new URL("../../database/drizzle", import.meta.url)
);

const DEFAULT_ADMIN_URL =
  "postgresql://seo_platform:password@localhost:5432/postgres";

function adminConnectionString(): string {
  if (process.env.DATABASE_URL === undefined) {
    try {
      // Turborepo runs tests from the package directory and Vitest has no
      // --env-file, so the repo-root .env is loaded explicitly. A no-op in CI,
      // which sets DATABASE_URL directly.
      process.loadEnvFile(
        fileURLToPath(new URL("../../../.env", import.meta.url))
      );
    } catch {
      // No .env checked out; fall through to the default below.
    }
  }

  const configured = process.env.DATABASE_URL;

  if (configured === undefined || configured === "") {
    return DEFAULT_ADMIN_URL;
  }

  // Same server, `postgres` database: CREATE DATABASE cannot run from inside
  // the database being created.
  const url = new URL(configured);

  url.pathname = "/postgres";

  return url.toString();
}

export interface PipelineTestDatabase {
  readonly db: Database;
  readonly name: string;
  destroy(): Promise<void>;
}

/** Create a migrated, empty database with a name no other run will reuse. */
export async function createPipelineTestDatabase(): Promise<PipelineTestDatabase> {
  const name = `psp_pipeline_${randomBytes(8).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminConnectionString() });

  await admin.connect();

  try {
    // Identifier is hex from randomBytes, so there is nothing to escape.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const connectionString = new URL(adminConnectionString());

  connectionString.pathname = `/${name}`;

  await runMigrations({
    connectionString: connectionString.toString(),
    migrationsFolder: MIGRATIONS_FOLDER
  });

  const handle = createDatabase({
    connectionString: connectionString.toString(),
    maxConnections: 4
  });

  let destroyed = false;

  return {
    db: handle.db,
    name,
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
