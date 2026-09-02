import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { patternStatusEnum } from "./enums.js";
import { sitemapFile, sitemapRun } from "./ingestion.js";
import { site } from "./tenancy.js";

/**
 * A URL template that many URLs collapse onto — the product's unit of work.
 * PARTITIONED BY LIST (site_id).
 */
export const pattern = pgTable(
  "pattern",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    sitemapRunId: uuid("sitemap_run_id").notNull(),
    /** For example `/product/{param}/reviews`. */
    template: text("template").notNull(),
    segmentCount: integer("segment_count").notNull(),
    /**
     * COUNTED, never estimated — this is the denominator every extrapolation
     * divides by, and it is obtained by streaming the sitemap rather than by
     * sampling. The rendering contract (ADR-0008) forbids ever showing this
     * with a `~` or an interval.
     */
    populationCount: bigint("population_count", { mode: "number" })
      .notNull()
      .default(0),
    /** How many files this pattern's URLs are spread across. */
    fileCount: integer("file_count").notNull().default(0),
    status: patternStatusEnum("status").notNull().default("unsampled"),
    /** Machine-readable why for `blocked` / `needs_review`. */
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.id], name: "pk_pattern" }),
    foreignKey({
      columns: [t.siteId],
      foreignColumns: [site.id],
      name: "fk_pattern_site"
    }),
    // Composite: a pattern cannot belong to one site and a run from another.
    foreignKey({
      columns: [t.siteId, t.sitemapRunId],
      foreignColumns: [sitemapRun.siteId, sitemapRun.id],
      name: "fk_pattern_sitemap_run"
    }),
    uniqueIndex("uq_pattern_run_template").on(
      t.siteId,
      t.sitemapRunId,
      t.template
    ),
    // Patterns are read largest-first almost everywhere: population is the first
    // term of the impact score, and a big pattern is where a small error rate
    // turns into a large number of affected URLs.
    index("idx_pattern_population").on(t.siteId, t.populationCount.desc()),
    index("idx_pattern_status").on(t.siteId, t.status),
    check("ck_pattern_population_nonnegative", sql`population_count >= 0`)
  ]
);

/**
 * Which files hold a pattern's URLs, and how many in each.
 * PARTITIONED BY LIST (site_id).
 *
 * THIS IS THE TABLE THE LEGACY ENGINE DOES NOT HAVE, and its absence is stated
 * plainly in the legacy code itself: `patternPopulationPool.ts` notes that
 * enumeration "reads every <loc> of every file in the session ... the only way
 * to do it, since nothing records a pattern-to-file index."
 *
 * With this index, resolving a sampled URL is a targeted read of one file at a
 * known ordinal instead of a full rescan of the population. That is what lets
 * the min-heap store a 12-byte `(hash, file, ordinal)` triple rather than URL
 * strings (ADR-0002), and it is why the sampling path never needs the whole
 * population in memory.
 */
export const patternPopulation = pgTable(
  "pattern_population",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    sitemapFileId: uuid("sitemap_file_id").notNull(),
    urlCount: integer("url_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.id], name: "pk_pattern_population" }),
    foreignKey({
      columns: [t.siteId, t.patternId],
      foreignColumns: [pattern.siteId, pattern.id],
      name: "fk_pattern_population_pattern"
    }),
    foreignKey({
      columns: [t.siteId, t.sitemapFileId],
      foreignColumns: [sitemapFile.siteId, sitemapFile.id],
      name: "fk_pattern_population_sitemap_file"
    }),
    // Ingestion upserts on this key, which is what makes a resumed parse merge
    // with what the crashed one already wrote instead of double-counting.
    uniqueIndex("uq_pattern_population_pattern_file").on(
      t.siteId,
      t.patternId,
      t.sitemapFileId
    ),
    // "Which files do I need to open to resolve this pattern's sample?"
    index("idx_pattern_population_pattern").on(t.siteId, t.patternId),
    check("ck_pattern_population_url_count_positive", sql`url_count > 0`)
  ]
);
