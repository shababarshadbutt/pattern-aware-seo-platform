import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit owns the migration journal and the schema snapshot.
 *
 * `push` is deliberately never used on this project: it would create the
 * partitioned tables as ordinary ones, silently discarding the partitioning that
 * ADR-0003 exists to guarantee. Migrations are generated, then the partitioned
 * CREATE TABLE statements are completed by hand — see ADR-0010.
 */
export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://seo_platform:password@localhost:5432/seo_platform"
  },
  strict: true,
  verbose: true
});
