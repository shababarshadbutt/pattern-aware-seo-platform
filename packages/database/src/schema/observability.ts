import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import {
  confidenceBandEnum,
  evidenceTierEnum,
  findingSourceEnum,
  severityClassEnum
} from "./enums.js";
import { sitemapRun } from "./ingestion.js";
import { pattern } from "./pattern.js";
import { patternSample } from "./sampling.js";
import { site } from "./tenancy.js";

/**
 * A published claim and everything that produced it. APPEND-ONLY.
 * PARTITIONED BY LIST (site_id).
 *
 * The action plan's requirement is that a statement like "13.8M URLs estimated
 * affected" stays defensible months later. That means the claim cannot be
 * recomputed on read from tables that have since moved on: the denominator, the
 * sample size, the estimator version and the per-stratum breakdown all have to
 * be frozen alongside the number. This table is that freeze, and it is what the
 * evidence page's expand panel reads.
 *
 * The most recent row per (pattern, http_status) is also the current estimate,
 * so there is no separate mutable estimates table to drift out of agreement
 * with the audit trail.
 */
export const auditSnapshot = pgTable(
  "audit_snapshot",
  {
    id: uuid("id").notNull().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    patternId: uuid("pattern_id").notNull(),
    patternSampleId: uuid("pattern_sample_id").notNull(),
    sitemapRunId: uuid("sitemap_run_id").notNull(),
    /** The status class this claim is about — 404, 500, and so on. */
    httpStatus: integer("http_status").notNull(),
    evidenceTier: evidenceTierEnum("evidence_tier").notNull(),
    /** Hits observed in the sample. */
    observedCount: integer("observed_count").notNull(),
    /** n */
    sampleSize: integer("sample_size").notNull(),
    /** N */
    populationCount: bigint("population_count", { mode: "number" }).notNull(),
    pointEstimate: bigint("point_estimate", { mode: "number" }).notNull(),
    ciLow: bigint("ci_low", { mode: "number" }).notNull(),
    ciHigh: bigint("ci_high", { mode: "number" }).notNull(),
    confidenceLevel: numeric("confidence_level", { precision: 4, scale: 3 })
      .notNull()
      .default("0.950"),
    confidenceBand: confidenceBandEnum("confidence_band").notNull(),
    /**
     * Which implementation of the maths produced this. Without it, a later fix
     * to the estimator silently makes old and new rows incomparable while
     * looking identical.
     */
    estimatorVersion: text("estimator_version").notNull(),
    /** Per-stratum breakdown: label, population, sampled, hits, bounds. */
    strata: jsonb("strata"),
    /** Which intelligence source produced this. See `finding_source`. */
    findingSource: findingSourceEnum("finding_source")
      .notNull()
      .default("http_sample"),
    severityClass: severityClassEnum("severity_class")
      .notNull()
      .default("unknown"),
    /**
     * The weight actually applied, frozen with the claim.
     *
     * Stored rather than looked up at read time because the weights are a
     * business decision that will be revised, and a claim published under the
     * old table has to stay reconstructible. Reading the current table would
     * silently restate history.
     */
    severityWeight: numeric("severity_weight", { precision: 4, scale: 3 })
      .notNull()
      .default("0.000"),
    /**
     * `point_estimate × severity_weight`, persisted.
     *
     * Denormalised deliberately. Ranking the fleet's patterns by impact is the
     * analyst's primary query, and computing it at read time means weighting
     * millions of rows on every page load. Frozen with the weight above, so the
     * ordering a report showed is the ordering it can still show later.
     *
     * NUMERIC, NOT BIGINT — corrected in migration 0006. The score is a count
     * of URLs multiplied by a weight in (0, 1], so it is fractional by
     * construction: three gone URLs at severity 0.9 is 2.7. As a bigint that
     * insert simply failed, and the obvious patch — rounding — is worse than
     * the bug. Rounding sends a 3-URL pattern at severity 0.15 to zero, which
     * ranks a real finding as no finding at all, and small broken families are
     * precisely what this system exists to stop losing in an average.
     */
    impactScore: numeric("impact_score", { precision: 20, scale: 3 })
      .notNull()
      .default("0.000"),
    computedAt: timestamp("computed_at", { withTimezone: true })
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
    primaryKey({ columns: [t.siteId, t.id], name: "pk_audit_snapshot" }),
    foreignKey({
      columns: [t.siteId, t.patternId],
      foreignColumns: [pattern.siteId, pattern.id],
      name: "fk_audit_snapshot_pattern"
    }),
    foreignKey({
      columns: [t.siteId, t.patternSampleId],
      foreignColumns: [patternSample.siteId, patternSample.id],
      name: "fk_audit_snapshot_pattern_sample"
    }),
    // Composite: a published claim cannot belong to one site and a run from
    // another. This table is the audit trail, so a mismatch here would corrupt
    // the provenance of the number itself.
    foreignKey({
      columns: [t.siteId, t.sitemapRunId],
      foreignColumns: [sitemapRun.siteId, sitemapRun.id],
      name: "fk_audit_snapshot_sitemap_run"
    }),
    // "Latest claim for this pattern and status" — the evidence page's query.
    index("idx_audit_snapshot_pattern_status_computed").on(
      t.siteId,
      t.patternId,
      t.httpStatus,
      t.computedAt.desc()
    ),
    // Impact ranking across a whole site reads point estimates largest-first.
    index("idx_audit_snapshot_site_estimate").on(
      t.siteId,
      t.pointEstimate.desc()
    ),
    // The impact queue's ordering. Separate from the estimate index because
    // severity reorders them: a small number of gone pages outranks a larger
    // number of single redirects.
    index("idx_audit_snapshot_site_impact").on(t.siteId, t.impactScore.desc()),

    /**
     * ONE CLAIM PER OUTCOME PER DRAW, and this is what makes a redelivered
     * `estimate` job a safe no-op rather than a duplicate row.
     *
     * `estimate` writes one row per distinct `http_status` tallied from a
     * draw's observations (the docblock above calls this out: "ONE SNAPSHOT
     * ROW PER OUTCOME, not per pattern"), so the natural key is the draw plus
     * the outcome, not the draw alone. `insertAuditSnapshot` upserts on this
     * key with `ON CONFLICT DO NOTHING` — a retried job re-computes the same
     * claim and finds it already there, rather than appending a second row
     * that would double-count in every rollup reading this table.
     */
    uniqueIndex("uq_audit_snapshot_sample_status").on(
      t.siteId,
      t.patternSampleId,
      t.httpStatus
    ),

    check(
      "ck_audit_snapshot_counts_sane",
      sql`
      observed_count >= 0
      and sample_size >= 0
      and population_count >= 0
      and observed_count <= sample_size
      and sample_size <= population_count
    `
    ),
    check(
      "ck_audit_snapshot_interval_contains_estimate",
      sql`ci_low <= point_estimate and point_estimate <= ci_high and ci_low >= 0 and ci_high <= population_count`
    ),

    /**
     * THE DEGENERATE-INTERVAL GUARD.
     *
     * A sample that did not cover the whole population may never claim a
     * zero-width interval. This is the exact defect found in the legacy
     * estimator during Phase 0: its normal approximation computes
     * `1.96 * sqrt(variance)`, and with zero observed hits the variance is zero,
     * so the interval collapses to [0, 0] — the system reporting certainty that
     * there are no errors on the basis of a 1% sample.
     *
     * The action plan lists this as the highest-value paging alert in the
     * system. A CHECK constraint is strictly better than an alert: the estimator
     * cannot write the bad row in the first place, so the failure surfaces as a
     * failing insert in a test run rather than as a client-facing number that
     * was wrong for a week. Wilson bounds with finite-population correction
     * (ADR-0001) satisfy this by construction — including the n = N case, which
     * is exempt below because there the interval SHOULD collapse: that
     * population was counted, not estimated.
     */
    check(
      "ck_audit_snapshot_no_degenerate_interval",
      sql`sample_size >= population_count or ci_low < ci_high`
    ),

    /**
     * The rendering contract from ADR-0008, enforced at the point of storage
     * rather than left to the component layer: a `counted` claim is only honest
     * when the sample covered the whole population, and a `blocked` claim must
     * not smuggle in a non-zero number, because there was no measurement.
     */
    check(
      "ck_audit_snapshot_impact_sane",
      sql`
        impact_score >= 0
        and severity_weight >= 0
        and severity_weight <= 1
        and impact_score <= point_estimate
      `
    ),

    /**
     * A refusal may never carry impact.
     *
     * `blocked` means the host would not let us look, and `unknown` means the
     * outcome could not be classified. Either scored as damage would let a WAF
     * or a network blip promote a healthy site to the top of the triage queue —
     * the single most misleading thing this product could do.
     */
    check(
      "ck_audit_snapshot_refusal_has_no_impact",
      sql`
        severity_class not in ('blocked', 'unknown', 'ok')
        or (impact_score = 0 and severity_weight = 0)
      `
    ),

    check(
      "ck_audit_snapshot_evidence_tier_matches_coverage",
      sql`
        (evidence_tier = 'counted' and sample_size >= population_count)
        or (evidence_tier = 'estimated' and sample_size < population_count)
        or (evidence_tier = 'blocked' and observed_count = 0 and point_estimate = 0)
      `
    )
  ]
);

/**
 * Aggregated estimator and budget health for one site over one window.
 *
 * Written from Phase 1 rather than added with the observability stack in M7,
 * because these are the numbers that say whether the sampling engine is working
 * at all — the share of patterns stuck at LOW confidence, how often the sample
 * budget turns out to be miscalibrated, how much of the HEAD-first design is
 * being defeated by escalation. Discovering any of those retrospectively means
 * discovering that a month of published estimates were thin.
 *
 * Not partitioned: one row per site per run (plus daily rollups) stays in the
 * hundreds of thousands, far short of the growth that justifies it elsewhere.
 */
export const samplingHealth = pgTable(
  "sampling_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").notNull(),
    /** Null for a cross-run daily rollup. */
    sitemapRunId: uuid("sitemap_run_id"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    patternsTotal: integer("patterns_total").notNull().default(0),
    /** Interval too wide to act on. Alerts at >8% of a site's patterns for 24h. */
    patternsLowConfidence: integer("patterns_low_confidence")
      .notNull()
      .default(0),
    /** Needed an adaptive expansion — a signal that sample budgets are mis-set. */
    patternsExpanded: integer("patterns_expanded").notNull().default(0),
    /** Behind an open circuit. Never counted as unhealthy patterns. */
    patternsBlocked: integer("patterns_blocked").notNull().default(0),
    /** Hit the GET-escalation cap and stopped rather than burning budget. */
    patternsNeedsReview: integer("patterns_needs_review").notNull().default(0),
    samplesDrawn: integer("samples_drawn").notNull().default(0),
    httpRequests: integer("http_requests").notNull().default(0),
    getEscalations: integer("get_escalations").notNull().default(0),
    circuitBreaks: integer("circuit_breaks").notNull().default(0),
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
      name: "fk_sampling_health_site"
    }),
    /**
     * Composite, like the others. `sitemap_run_id` is nullable here for
     * cross-run daily rollups, and Postgres's default MATCH SIMPLE skips the
     * check when any column is NULL — so a rollup row is unconstrained, which
     * is the intended behaviour rather than an oversight.
     */
    foreignKey({
      columns: [t.siteId, t.sitemapRunId],
      foreignColumns: [sitemapRun.siteId, sitemapRun.id],
      name: "fk_sampling_health_sitemap_run"
    }),
    uniqueIndex("uq_sampling_health_site_run_window").on(
      t.siteId,
      t.sitemapRunId,
      t.windowStart
    ),
    index("idx_sampling_health_site_window").on(t.siteId, t.windowEnd.desc()),
    check("ck_sampling_health_window_ordered", sql`window_start < window_end`)
  ]
);
