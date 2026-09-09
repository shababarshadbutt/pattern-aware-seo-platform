ALTER TABLE "audit_snapshot" ALTER COLUMN "impact_score" SET DATA TYPE numeric(20, 3);--> statement-breakpoint
ALTER TABLE "audit_snapshot" ALTER COLUMN "impact_score" SET DEFAULT '0.000';