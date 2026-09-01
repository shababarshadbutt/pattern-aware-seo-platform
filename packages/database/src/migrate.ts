import { fileURLToPath } from "node:url";

import { createLogger } from "@pattern-aware/shared";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createDatabase, internalDatabase } from "./client.js";

/**
 * Apply every pending migration.
 *
 * Drizzle Kit owns the journal, so this is the only sanctioned way the schema
 * changes. `drizzle-kit push` is never used on this project: it diffs the TS
 * schema against the live database and would recreate the partitioned tables as
 * ordinary ones, silently discarding the partitioning ADR-0003 exists to
 * guarantee. See ADR-0010.
 */
export async function runMigrations(options: {
  readonly connectionString: string;
  readonly migrationsFolder: string;
}): Promise<void> {
  const handle = createDatabase({
    connectionString: options.connectionString,
    maxConnections: 1
  });

  try {
    await migrate(internalDatabase(handle.db), {
      migrationsFolder: options.migrationsFolder
    });
  } finally {
    await handle.close();
  }
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Run as a script: `pnpm --filter @pattern-aware/database db:migrate`. */
if (process.argv[1] !== undefined && import.meta.url.startsWith("file:")) {
  const invokedDirectly =
    fileURLToPath(import.meta.url) === process.argv[1] ||
    process.argv[1].endsWith("migrate.ts");

  if (invokedDirectly) {
    const logger = createLogger({ service: "db-migrate", pretty: true });
    const connectionString = process.env.DATABASE_URL;

    if (connectionString === undefined || connectionString === "") {
      logger.error("DATABASE_URL is not set");
      process.exit(1);
    }

    try {
      await runMigrations({
        connectionString,
        migrationsFolder: MIGRATIONS_FOLDER
      });
      logger.info(
        { migrationsFolder: MIGRATIONS_FOLDER },
        "migrations applied"
      );
    } catch (error) {
      logger.error({ err: error }, "migrations failed");
      process.exit(1);
    }
  }
}
