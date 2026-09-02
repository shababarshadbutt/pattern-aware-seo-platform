--> HAND-EDITED AFTER GENERATION. DO NOT REGENERATE OVER THIS FILE.
--
-- drizzle-kit produced everything below from src/schema, but Drizzle cannot
-- express declarative partitioning, so the PARTITION BY LIST ("site_id")
-- clauses on sitemap_file, pattern, pattern_population, pattern_sample,
-- sample_observation and audit_snapshot were added by hand. Re-running
-- `drizzle-kit generate` against an unchanged schema will not touch this file;
-- deleting and regenerating it WILL silently drop the partitioning that
-- ADR-0003 exists to guarantee. Never run `drizzle-kit push` on this project
-- for the same reason. See ADR-0010.
--
-- No partitions are created here. They are created per site at onboarding by
-- createSitePartitions() in src/partitions.ts, so a fresh database starts with
-- the parent tables only.

CREATE TYPE "public"."confidence_band" AS ENUM('confident', 'approximate', 'low');--> statement-breakpoint
CREATE TYPE "public"."evidence_tier" AS ENUM('counted', 'estimated', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."file_parse_status" AS ENUM('pending', 'downloading', 'parsing', 'parsed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."http_method" AS ENUM('HEAD', 'GET');--> statement-breakpoint
CREATE TYPE "public"."pattern_status" AS ENUM('unsampled', 'sampling', 'measured', 'blocked', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('pending', 'running', 'complete', 'degraded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sample_method" AS ENUM('min_heap_by_hash');--> statement-breakpoint
CREATE TYPE "public"."site_tier" AS ENUM('standard', 'priority', 'bulk');--> statement-breakpoint
CREATE TABLE "audit_snapshot" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"pattern_sample_id" uuid NOT NULL,
	"sitemap_run_id" uuid NOT NULL,
	"http_status" integer NOT NULL,
	"evidence_tier" "evidence_tier" NOT NULL,
	"observed_count" integer NOT NULL,
	"sample_size" integer NOT NULL,
	"population_count" bigint NOT NULL,
	"point_estimate" bigint NOT NULL,
	"ci_low" bigint NOT NULL,
	"ci_high" bigint NOT NULL,
	"confidence_level" numeric(4, 3) DEFAULT '0.950' NOT NULL,
	"confidence_band" "confidence_band" NOT NULL,
	"estimator_version" text NOT NULL,
	"strata" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_audit_snapshot" PRIMARY KEY("site_id","id"),
	CONSTRAINT "ck_audit_snapshot_counts_sane" CHECK (
      observed_count >= 0
      and sample_size >= 0
      and population_count >= 0
      and observed_count <= sample_size
      and sample_size <= population_count
    ),
	CONSTRAINT "ck_audit_snapshot_interval_contains_estimate" CHECK (ci_low <= point_estimate and point_estimate <= ci_high and ci_low >= 0 and ci_high <= population_count),
	CONSTRAINT "ck_audit_snapshot_no_degenerate_interval" CHECK (sample_size >= population_count or ci_low < ci_high),
	CONSTRAINT "ck_audit_snapshot_evidence_tier_matches_coverage" CHECK (
        (evidence_tier = 'counted' and sample_size >= population_count)
        or (evidence_tier = 'estimated' and sample_size < population_count)
        or (evidence_tier = 'blocked' and observed_count = 0 and point_estimate = 0)
      )
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pattern" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"sitemap_run_id" uuid NOT NULL,
	"template" text NOT NULL,
	"segment_count" integer NOT NULL,
	"population_count" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"status" "pattern_status" DEFAULT 'unsampled' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_pattern" PRIMARY KEY("site_id","id"),
	CONSTRAINT "ck_pattern_population_nonnegative" CHECK (population_count >= 0)
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "pattern_population" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"sitemap_file_id" uuid NOT NULL,
	"url_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_pattern_population" PRIMARY KEY("site_id","id"),
	CONSTRAINT "ck_pattern_population_url_count_positive" CHECK (url_count > 0)
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "pattern_sample" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"sitemap_run_id" uuid NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"method" "sample_method" DEFAULT 'min_heap_by_hash' NOT NULL,
	"k_requested" integer NOT NULL,
	"k_threshold_hash" bigint NOT NULL,
	"sample_size" integer NOT NULL,
	"population_at_draw" bigint NOT NULL,
	"stratum_count" integer DEFAULT 1 NOT NULL,
	"drawn_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_pattern_sample" PRIMARY KEY("site_id","id"),
	CONSTRAINT "ck_pattern_sample_round_positive" CHECK (round >= 1),
	CONSTRAINT "ck_pattern_sample_size_within_population" CHECK (sample_size >= 0 and sample_size <= population_at_draw)
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "sample_observation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"pattern_id" uuid NOT NULL,
	"pattern_sample_id" uuid NOT NULL,
	"sitemap_file_id" uuid,
	"loc_ordinal" integer,
	"url_hash" bigint NOT NULL,
	"url" text NOT NULL,
	"stratum_label" text,
	"http_status" integer,
	"method_used" "http_method",
	"escalated_to_get" boolean DEFAULT false NOT NULL,
	"is_soft_404" boolean DEFAULT false NOT NULL,
	"error_reason" text,
	"response_ms" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_sample_observation" PRIMARY KEY("site_id","id")
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "sampling_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"sitemap_run_id" uuid,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"patterns_total" integer DEFAULT 0 NOT NULL,
	"patterns_low_confidence" integer DEFAULT 0 NOT NULL,
	"patterns_expanded" integer DEFAULT 0 NOT NULL,
	"patterns_blocked" integer DEFAULT 0 NOT NULL,
	"patterns_needs_review" integer DEFAULT 0 NOT NULL,
	"samples_drawn" integer DEFAULT 0 NOT NULL,
	"http_requests" integer DEFAULT 0 NOT NULL,
	"get_escalations" integer DEFAULT 0 NOT NULL,
	"circuit_breaks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sampling_health_window_ordered" CHECK (window_start < window_end)
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"host" text NOT NULL,
	"tier" "site_tier" DEFAULT 'standard' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"daily_request_cap" integer,
	"min_request_interval_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sitemap_file" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"sitemap_run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"filename" text,
	"parse_status" "file_parse_status" DEFAULT 'pending' NOT NULL,
	"url_count" integer DEFAULT 0 NOT NULL,
	"byte_size" bigint,
	"is_gzip" boolean DEFAULT false NOT NULL,
	"parse_error" text,
	"parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_sitemap_file" PRIMARY KEY("site_id","id")
) PARTITION BY LIST ("site_id");
--> statement-breakpoint
CREATE TABLE "sitemap_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"is_dry_run" boolean DEFAULT false NOT NULL,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"total_files" integer DEFAULT 0 NOT NULL,
	"parsed_files" integer DEFAULT 0 NOT NULL,
	"total_urls" bigint DEFAULT 0 NOT NULL,
	"total_patterns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "fk_audit_snapshot_pattern" FOREIGN KEY ("site_id","pattern_id") REFERENCES "public"."pattern"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "fk_audit_snapshot_pattern_sample" FOREIGN KEY ("site_id","pattern_sample_id") REFERENCES "public"."pattern_sample"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "fk_audit_snapshot_sitemap_run" FOREIGN KEY ("sitemap_run_id") REFERENCES "public"."sitemap_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "fk_pattern_site" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "fk_pattern_sitemap_run" FOREIGN KEY ("sitemap_run_id") REFERENCES "public"."sitemap_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_population" ADD CONSTRAINT "fk_pattern_population_pattern" FOREIGN KEY ("site_id","pattern_id") REFERENCES "public"."pattern"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_population" ADD CONSTRAINT "fk_pattern_population_sitemap_file" FOREIGN KEY ("site_id","sitemap_file_id") REFERENCES "public"."sitemap_file"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_sample" ADD CONSTRAINT "fk_pattern_sample_pattern" FOREIGN KEY ("site_id","pattern_id") REFERENCES "public"."pattern"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_sample" ADD CONSTRAINT "fk_pattern_sample_sitemap_run" FOREIGN KEY ("sitemap_run_id") REFERENCES "public"."sitemap_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_observation" ADD CONSTRAINT "fk_sample_observation_pattern_sample" FOREIGN KEY ("site_id","pattern_sample_id") REFERENCES "public"."pattern_sample"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_observation" ADD CONSTRAINT "fk_sample_observation_pattern" FOREIGN KEY ("site_id","pattern_id") REFERENCES "public"."pattern"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sample_observation" ADD CONSTRAINT "fk_sample_observation_site" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sampling_health" ADD CONSTRAINT "fk_sampling_health_site" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sampling_health" ADD CONSTRAINT "fk_sampling_health_sitemap_run" FOREIGN KEY ("sitemap_run_id") REFERENCES "public"."sitemap_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "fk_site_organization" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_file" ADD CONSTRAINT "fk_sitemap_file_site" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_file" ADD CONSTRAINT "fk_sitemap_file_sitemap_run" FOREIGN KEY ("sitemap_run_id") REFERENCES "public"."sitemap_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_run" ADD CONSTRAINT "fk_sitemap_run_site" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_snapshot_pattern_status_computed" ON "audit_snapshot" USING btree ("site_id","pattern_id","http_status","computed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_snapshot_site_estimate" ON "audit_snapshot" USING btree ("site_id","point_estimate" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_slug" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pattern_run_template" ON "pattern" USING btree ("site_id","sitemap_run_id","template");--> statement-breakpoint
CREATE INDEX "idx_pattern_population" ON "pattern" USING btree ("site_id","population_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pattern_status" ON "pattern" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pattern_population_pattern_file" ON "pattern_population" USING btree ("site_id","pattern_id","sitemap_file_id");--> statement-breakpoint
CREATE INDEX "idx_pattern_population_pattern" ON "pattern_population" USING btree ("site_id","pattern_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pattern_sample_pattern_round" ON "pattern_sample" USING btree ("site_id","pattern_id","round");--> statement-breakpoint
CREATE INDEX "idx_pattern_sample_pattern_drawn" ON "pattern_sample" USING btree ("site_id","pattern_id","drawn_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sample_observation_sample_url_hash" ON "sample_observation" USING btree ("site_id","pattern_sample_id","url_hash");--> statement-breakpoint
CREATE INDEX "idx_sample_observation_sample" ON "sample_observation" USING btree ("site_id","pattern_sample_id");--> statement-breakpoint
CREATE INDEX "idx_sample_observation_pattern_observed" ON "sample_observation" USING btree ("site_id","pattern_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sampling_health_site_run_window" ON "sampling_health" USING btree ("site_id","sitemap_run_id","window_start");--> statement-breakpoint
CREATE INDEX "idx_sampling_health_site_window" ON "sampling_health" USING btree ("site_id","window_end" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_site_organization_host" ON "site" USING btree ("organization_id","host");--> statement-breakpoint
CREATE INDEX "idx_site_organization_id" ON "site" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_site_active_tier" ON "site" USING btree ("tier") WHERE "site"."deleted_at" is null and "site"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sitemap_file_run_url" ON "sitemap_file" USING btree ("site_id","sitemap_run_id","url");--> statement-breakpoint
CREATE INDEX "idx_sitemap_file_run_parse_status" ON "sitemap_file" USING btree ("site_id","sitemap_run_id","parse_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sitemap_run_one_active_per_site" ON "sitemap_run" USING btree ("site_id") WHERE "sitemap_run"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "idx_sitemap_run_site_started" ON "sitemap_run" USING btree ("site_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_sitemap_run_heartbeat" ON "sitemap_run" USING btree ("heartbeat_at") WHERE "sitemap_run"."status" = 'running';