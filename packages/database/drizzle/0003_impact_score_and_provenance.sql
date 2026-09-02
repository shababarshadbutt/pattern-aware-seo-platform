CREATE TYPE "public"."finding_source" AS ENUM('http_sample');--> statement-breakpoint
CREATE TYPE "public"."severity_class" AS ENUM('gone', 'not_found', 'soft_not_found', 'server_error', 'redirect_chain', 'redirect_single', 'ok', 'blocked', 'unknown');--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD COLUMN "finding_source" "finding_source" DEFAULT 'http_sample' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD COLUMN "severity_class" "severity_class" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD COLUMN "severity_weight" numeric(4, 3) DEFAULT '0.000' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD COLUMN "impact_score" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_snapshot_site_impact" ON "audit_snapshot" USING btree ("site_id","impact_score" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "ck_audit_snapshot_impact_sane" CHECK (
        impact_score >= 0
        and severity_weight >= 0
        and severity_weight <= 1
        and impact_score <= point_estimate
      );--> statement-breakpoint
ALTER TABLE "audit_snapshot" ADD CONSTRAINT "ck_audit_snapshot_refusal_has_no_impact" CHECK (
        severity_class not in ('blocked', 'unknown', 'ok')
        or (impact_score = 0 and severity_weight = 0)
      );