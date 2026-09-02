import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

declare const databaseBrand: unique symbol;

/**
 * An opaque database handle.
 *
 * The public type deliberately exposes NO query methods. Outside this package,
 * `db.select(...)` does not typecheck — there is no way to reach the tables
 * except through a repository function, and every repository function demands a
 * `SiteScope`. That is what makes "an unscoped query is a compile error" a real
 * property rather than a convention someone remembers on a good day (ADR-0004).
 *
 * Repositories inside this package recover the real Drizzle instance with
 * {@link internalDatabase}.
 */
export type Database = {
  readonly [databaseBrand]: true;
};

/** The real handle. Never exported from the package's public surface. */
export type InternalDatabase = NodePgDatabase<typeof schema>;

/** Widen the real handle to the opaque one. Package-internal. */
export function opaqueDatabase(db: InternalDatabase): Database {
  return db as unknown as Database;
}

/**
 * Recover the real handle inside a repository.
 *
 * The cast is safe because {@link opaqueDatabase} is the only way a `Database`
 * is ever produced, and it is not exported outside this package.
 */
export function internalDatabase(db: Database): InternalDatabase {
  return db as unknown as InternalDatabase;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  /**
   * Ceiling on this process's connections.
   *
   * Sized per worker type rather than left at the driver default, because a
   * population scan spinning up connections is exactly what starves the API of
   * them — the pool budgeting M7 formalises. Postgres has one global connection
   * limit and every process here competes for it.
   */
  readonly maxConnections?: number;
  /** Emit generated SQL. Useful against a test database, noisy anywhere else. */
  readonly logQueries?: boolean;
}

export interface DatabaseHandle {
  readonly db: Database;
  /** Drain the pool. Call on shutdown so a deploy does not sever live queries. */
  close(): Promise<void>;
}

/**
 * Open a connection pool and return the opaque handle repositories accept.
 *
 * Call once per process at startup and pass the result down; creating a second
 * pool doubles this process's share of a global connection limit without
 * anything reporting that it happened.
 */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10
  });

  const db = drizzle(pool, {
    schema,
    logger: options.logQueries ?? false
  });

  return {
    db: opaqueDatabase(db),
    close: async () => {
      await pool.end();
    }
  };
}
