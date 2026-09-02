-- HAND-REORDERED AFTER GENERATION.
--
-- drizzle-kit emitted the composite foreign keys BEFORE the unique constraint
-- they reference, so the migration failed on the first ADD: Postgres requires
-- a foreign key's target columns to be covered by a unique or primary key
-- constraint that already exists. Drops first, then the target, then the keys.
--
-- WHY THESE KEYS CHANGE. Every table referencing a run also carries `site_id`,
-- but only `(sitemap_run_id) -> sitemap_run(id)` was constrained. Nothing
-- stopped a row whose `site_id` disagreed with its run's — so a cross-site
-- reference was representable in a schema that claimed the opposite. Flagged by
-- automated review on PR #2. Pointing the keys at `(site_id, id)` makes the two
-- agree by construction rather than by convention.
--
-- `sampling_health.sitemap_run_id` stays nullable for cross-run daily rollups.
-- Postgres's default MATCH SIMPLE skips the check when any column is NULL, so a
-- rollup row is unconstrained — intended, not an oversight.

ALTER TABLE "audit_snapshot" DROP CONSTRAINT "fk_audit_snapshot_sitemap_run";
--> statement-breakpoint
ALTER TABLE "pattern" DROP CONSTRAINT "fk_pattern_sitemap_run";
--> statement-breakpoint
ALTER TABLE "pattern_sample" DROP CONSTRAINT "fk_pattern_sample_sitemap_run";
--> statement-breakpoint
ALTER TABLE "sampling_health" DROP CONSTRAINT "fk_sampling_health_sitemap_run";
--> statement-breakpoint
ALTER TABLE "sitemap_file" DROP CONSTRAINT "fk_sitemap_file_sitemap_run";
--> statement-breakpoint
ALTER TABLE "sitemap_run" ADD CONSTRAINT "uq_sitemap_run_site_id" UNIQUE("site_id","id");
--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "fk_audit_snapshot_sitemap_run" FOREIGN KEY ("site_id","sitemap_run_id") REFERENCES "public"."sitemap_run"("site_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "fk_pattern_sitemap_run" FOREIGN KEY ("site_id","sitemap_run_id") REFERENCES "public"."sitemap_run"("site_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pattern_sample" ADD CONSTRAINT "fk_pattern_sample_sitemap_run" FOREIGN KEY ("site_id","sitemap_run_id") REFERENCES "public"."sitemap_run"("site_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sampling_health" ADD CONSTRAINT "fk_sampling_health_sitemap_run" FOREIGN KEY ("site_id","sitemap_run_id") REFERENCES "public"."sitemap_run"("site_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "sitemap_file" ADD CONSTRAINT "fk_sitemap_file_sitemap_run" FOREIGN KEY ("site_id","sitemap_run_id") REFERENCES "public"."sitemap_run"("site_id","id") ON DELETE no action ON UPDATE no action;
