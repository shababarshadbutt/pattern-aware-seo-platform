-- NOT NULL with no default, deliberately.
--
-- This will fail on a table that already holds rows, and failing is correct.
-- file_ordinal is the only link between a stored sample candidate and the bytes
-- it was drawn from, so a backfilled guess (say, row order) would not be
-- unknown-but-harmless — it would silently re-point existing candidates at
-- different files, and resolution would return real URLs from the wrong one.
-- A run that predates this column has no recoverable ordinal, so the honest
-- outcome is to re-run it rather than to invent one.
ALTER TABLE "sitemap_file" ADD COLUMN "file_ordinal" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sitemap_file_run_ordinal" ON "sitemap_file" USING btree ("site_id","sitemap_run_id","file_ordinal");