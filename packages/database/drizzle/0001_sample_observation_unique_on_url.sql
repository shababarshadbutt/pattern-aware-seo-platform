-- Correcting a mistake in 0000: sample_observation was unique on url_hash.
--
-- The hash is FNV-1a 32-bit and pattern populations reach tens of millions, so
-- collisions are not rare — they are constant. Worse, they concentrate exactly
-- where it matters: a draw keeps the ~1,200 SMALLEST hashes, which sit in a
-- narrow band at the bottom of the space, and several collisions among them are
-- expected by the birthday bound.
--
-- Under the old index the second URL of any colliding pair was rejected, so the
-- sample silently came back smaller than it was drawn — and a sample size that
-- disagrees with the draw makes every extrapolation from it wrong. The identity
-- of an observation is the URL; the hash is only how it was selected.
--
-- Written as a new migration rather than an edit to 0000, per
-- docs/CODING_STANDARDS.md section 2.4.

DROP INDEX "uq_sample_observation_sample_url_hash";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sample_observation_sample_url" ON "sample_observation" USING btree ("site_id","pattern_sample_id","url");--> statement-breakpoint
CREATE INDEX "idx_sample_observation_sample_url_hash" ON "sample_observation" USING btree ("site_id","pattern_sample_id","url_hash");