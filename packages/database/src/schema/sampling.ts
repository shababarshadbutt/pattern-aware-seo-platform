import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

import { httpMethodEnum, sampleMethodEnum } from "./enums.js";
import { sitemapRun } from "./ingestion.js";
import { pattern } from "./pattern.js";
import { site } from "./tenancy.js";

/**
 * One draw against a pattern. PARTITIONED BY LIST (site_id).
 *
 * A draw, not a sample set — the URLs live in `sample_observation`. Round 1 is
 * the first draw; rounds 2+ are adaptive expansions, and each is its own row so
 * "we looked harder here" is visible in the data rather than implied by a
 * changed count.
 *
 * `k_threshold_hash` is what makes the superset property checkable rather than
 * merely believed. The min-heap keeps the K smallest hashes, so every URL in the
 * draw has `url_hash <= k_threshold_hash`; a later expansion raising K can only
 * admit URLs above the old threshold, never evict one below it. Storing the
 * threshold means a reviewer can verify round 2 contains round 1 by comparing
 * two numbers, instead of re-deriving the hash function and hoping it has not
 * changed. See ADR-0002.
 */
export const patternSample = pgTable(
  "pattern_sample",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    sitemapRunId: uuid("sitemap_run_id").notNull(),
    /** 1 = first draw, 2+ = adaptive expansion. */
    round: integer("round").notNull().default(1),
    method: sampleMethodEnum("method").notNull().default("min_heap_by_hash"),
    /** The K asked for. */
    kRequested: integer("k_requested").notNull(),
    /**
     * The largest hash retained by the heap. FNV-1a is 32-bit unsigned, whose
     * maximum exceeds `integer`, hence `bigint`.
     */
    kThresholdHash: bigint("k_threshold_hash", { mode: "number" }).notNull(),
    /** What was actually drawn — below `k_requested` when the population is smaller. */
    sampleSize: integer("sample_size").notNull(),
    /**
     * N at the moment of the draw. Stored rather than read back from
     * `pattern.population_count` because a later run changes that number, and an
     * estimate has to stay reconstructible against the denominator it actually
     * used.
     */
    populationAtDraw: bigint("population_at_draw", {
      mode: "number"
    }).notNull(),
    stratumCount: integer("stratum_count").notNull().default(1),
    drawnAt: timestamp("drawn_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.id], name: "pk_pattern_sample" }),
    foreignKey({
      columns: [t.siteId, t.patternId],
      foreignColumns: [pattern.siteId, pattern.id],
      name: "fk_pattern_sample_pattern"
    }),
    foreignKey({
      columns: [t.sitemapRunId],
      foreignColumns: [sitemapRun.id],
      name: "fk_pattern_sample_sitemap_run"
    }),
    uniqueIndex("uq_pattern_sample_pattern_round").on(
      t.siteId,
      t.patternId,
      t.round
    ),
    index("idx_pattern_sample_pattern_drawn").on(
      t.siteId,
      t.patternId,
      t.drawnAt.desc()
    ),
    check("ck_pattern_sample_round_positive", sql`round >= 1`),
    check(
      "ck_pattern_sample_size_within_population",
      sql`sample_size >= 0 and sample_size <= population_at_draw`
    )
  ]
);

/**
 * One probed URL. APPEND-ONLY. PARTITIONED BY LIST (site_id).
 *
 * The legacy engine does the opposite and it costs it dearly: `samplePatternsJob`
 * runs `DELETE FROM sampled_urls WHERE pattern_id = $1` before every insert, so
 * each re-check destroys the previous one. That is exactly the history the
 * Phase 4 risk model needs to train on and the trend sparklines need to draw,
 * and it cannot be recovered later. Nothing updates or deletes rows here.
 *
 * `updated_at` exists only because the coding standards require it on every
 * table; on this table it is always equal to `created_at`.
 */
export const sampleObservation = pgTable(
  "sample_observation",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    patternSampleId: uuid("pattern_sample_id").notNull(),
    /**
     * Where this URL was found, so it can be re-resolved without a rescan. Both
     * are nullable because a URL may be re-probed later from a file that a newer
     * run has since removed.
     */
    sitemapFileId: uuid("sitemap_file_id"),
    locOrdinal: integer("loc_ordinal"),
    /** The FNV-1a hash that selected it. Compare against the draw's threshold. */
    urlHash: bigint("url_hash", { mode: "number" }).notNull(),
    url: text("url").notNull(),
    /** Which sub-pattern family this URL fell into, when the draw was stratified. */
    stratumLabel: text("stratum_label"),
    httpStatus: integer("http_status"),
    methodUsed: httpMethodEnum("method_used"),
    /**
     * Whether this probe cost a GET on top of its HEAD. Aggregated into the
     * per-pattern escalation share that trips the manual-review cap, and into
     * the fleet-wide escalation rate alert.
     */
    escalatedToGet: boolean("escalated_to_get").notNull().default(false),
    isSoft404: boolean("is_soft_404").notNull().default(false),
    /** Set when no status was obtained: timeout, DNS, TLS, refusal. */
    errorReason: text("error_reason"),
    responseMs: integer("response_ms"),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [
    primaryKey({ columns: [t.siteId, t.id], name: "pk_sample_observation" }),
    foreignKey({
      columns: [t.siteId, t.patternSampleId],
      foreignColumns: [patternSample.siteId, patternSample.id],
      name: "fk_sample_observation_pattern_sample"
    }),
    foreignKey({
      columns: [t.siteId, t.patternId],
      foreignColumns: [pattern.siteId, pattern.id],
      name: "fk_sample_observation_pattern"
    }),
    foreignKey({
      columns: [t.siteId],
      foreignColumns: [site.id],
      name: "fk_sample_observation_site"
    }),
    /**
     * One probe per URL per draw. Makes the writer idempotent under retry,
     * which an append-only table otherwise has no defence against.
     *
     * Keyed on the URL, NOT on `url_hash`. The hash is 32-bit and the
     * populations are tens of millions, so collisions are constant — and among
     * the ~1,200 smallest hashes a draw retains, several are expected. Two
     * distinct URLs sharing a hash are two real observations; a unique index on
     * the hash would reject the second and silently shrink the sample. This
     * mistake was made in migration 0000 and corrected in 0001.
     */
    uniqueIndex("uq_sample_observation_sample_url").on(
      t.siteId,
      t.patternSampleId,
      t.url
    ),
    index("idx_sample_observation_sample").on(t.siteId, t.patternSampleId),
    // Verifying the superset property means asking "which observations fall
    // below the previous draw's threshold hash?", which wants the hash indexed
    // even though it is not unique.
    index("idx_sample_observation_sample_url_hash").on(
      t.siteId,
      t.patternSampleId,
      t.urlHash
    ),
    // The Phase 4 feature query and the trend sparkline: this pattern's outcomes
    // over time.
    index("idx_sample_observation_pattern_observed").on(
      t.siteId,
      t.patternId,
      t.observedAt.desc()
    )
  ]
);
