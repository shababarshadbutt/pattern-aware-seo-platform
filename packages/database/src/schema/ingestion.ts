import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { fileParseStatusEnum, runStatusEnum } from "./enums.js";
import { site } from "./tenancy.js";

/**
 * One ingestion-and-audit pass over a site.
 *
 * This is the legacy `session` concept, kept because the per-run semantics were
 * right — what changed is that it now hangs off a durable `site` rather than
 * being the root of the world (ADR-0004).
 */
export const sitemapRun = pgTable(
  "sitemap_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    status: runStatusEnum("status").notNull().default("pending"),
    /**
     * Machine-readable why, for the non-`complete` statuses — for example
     * `OVERSIZE_HARD_LIMIT` or `HOST_REFUSED`. Read by the run-detail screen to
     * explain a `degraded` result in terms of which threshold was hit, rather
     * than leaving the reader to guess why the numbers look thin.
     */
    statusReason: text("status_reason"),
    /**
     * Discover, parse, extract and plan the sample, then stop before any HTTP.
     * Lets a site be pattern-profiled at full scale before anyone agrees to
     * point traffic at it (M2/M5).
     */
    isDryRun: boolean("is_dry_run").notNull().default(false),
    /**
     * Owner and liveness, for the stale sweeper. A run whose heartbeat has
     * expired is marked `failed` with its last completed file recorded, rather
     * than sitting in `running` forever and blocking the partial unique index
     * below.
     */
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    totalFiles: integer("total_files").notNull().default(0),
    parsedFiles: integer("parsed_files").notNull().default(0),
    /**
     * Counted, never estimated. Counting is a streaming operation that stays
     * cheap at any size, so this stays honest even for a run that hit the
     * oversize hard limit and stopped before sampling.
     */
    totalUrls: bigint("total_urls", { mode: "number" }).notNull().default(0),
    totalPatterns: integer("total_patterns").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    foreignKey({
      columns: [t.siteId],
      foreignColumns: [site.id],
      name: "fk_sitemap_run_site"
    }),
    /**
     * At most one in-flight run per site, enforced by the database rather than a
     * check-then-act in the enqueue path.
     *
     * Two overlapping runs on one site would double the request rate arriving at
     * the client's origin, which is the single thing the whole sampling design
     * exists to avoid. The legacy schema learned this the same way and guards
     * triage runs identically (migration 040).
     */
    uniqueIndex("uq_sitemap_run_one_active_per_site")
      .on(t.siteId)
      .where(sql`${t.status} in ('pending', 'running')`),
    /**
     * Redundant against the primary key on `id` alone, and deliberately so.
     *
     * It exists to be the target of a COMPOSITE foreign key. Every table that
     * references a run also carries `site_id`, and with only
     * `(sitemap_run_id) -> sitemap_run(id)` constrained, nothing stopped a row
     * whose `site_id` disagreed with its run's — so a cross-site reference was
     * representable in a schema that claimed otherwise. Pointing those keys at
     * `(site_id, id)` makes the two agree by construction. See ADR-0004.
     *
     * A UNIQUE CONSTRAINT rather than a unique index, because that is what
     * Postgres requires a foreign key to reference.
     */
    unique("uq_sitemap_run_site_id").on(t.siteId, t.id),
    index("idx_sitemap_run_site_started").on(t.siteId, t.startedAt.desc()),
    // The stale sweeper's only query shape.
    index("idx_sitemap_run_heartbeat")
      .on(t.heartbeatAt)
      .where(sql`${t.status} = 'running'`)
  ]
);

/**
 * One file within a run. PARTITIONED BY LIST (site_id).
 *
 * Partitioned even though the action plan's original list named only four
 * tables: at the 50,000-file hard limit across 650 sites this reaches tens of
 * millions of rows, which is squarely the growth profile the plan's own
 * reasoning says to partition from creation rather than retrofit. It also costs
 * nothing here — `pattern_population`, the only table referencing it, is
 * already partitioned and already carries `site_id`, so the composite foreign
 * key is free.
 */
export const sitemapFile = pgTable(
  "sitemap_file",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    sitemapRunId: uuid("sitemap_run_id").notNull(),
    url: text("url").notNull(),
    filename: text("filename"),
    parseStatus: fileParseStatusEnum("parse_status")
      .notNull()
      .default("pending"),
    urlCount: integer("url_count").notNull().default(0),
    byteSize: bigint("byte_size", { mode: "number" }),
    isGzip: boolean("is_gzip").notNull().default(false),
    parseError: text("parse_error"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    // A partitioned table's primary key must contain the partition key, so `id`
    // alone cannot be it. See ADR-0010 for why this overrides the "primary keys
    // are always id" convention in the coding standards.
    primaryKey({ columns: [t.siteId, t.id], name: "pk_sitemap_file" }),
    foreignKey({
      columns: [t.siteId],
      foreignColumns: [site.id],
      name: "fk_sitemap_file_site"
    }),
    // Composite: a file cannot belong to one site and a run from another.
    foreignKey({
      columns: [t.siteId, t.sitemapRunId],
      foreignColumns: [sitemapRun.siteId, sitemapRun.id],
      name: "fk_sitemap_file_sitemap_run"
    }),
    // Ingestion is idempotent on (run, url): re-running a crashed parse must not
    // duplicate files, which is what makes resume safe to retry.
    uniqueIndex("uq_sitemap_file_run_url").on(t.siteId, t.sitemapRunId, t.url),
    // "Give me the next unparsed file for this run" — the resume query.
    index("idx_sitemap_file_run_parse_status").on(
      t.siteId,
      t.sitemapRunId,
      t.parseStatus
    )
  ]
);
