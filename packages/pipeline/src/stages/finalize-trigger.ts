import {
  countPatternsByStatus,
  findRunById,
  type SiteScope
} from "@pattern-aware/database";

import type { PipelineDeps } from "../deps.js";

/**
 * The fan-in `estimate` and `finalize` need and neither stage's own file ever
 * had: nothing counts "every pattern's verify-and-estimate has finished for
 * this run" and enqueues `finalize` once it has.
 *
 * SAFE WITHOUT A LOCK, not because nothing could race but because nothing
 * does: `SitePipeline` runs the `estimate` queue at concurrency 1 per site
 * (`apps/worker/src/site-pipeline.ts`), so two `estimate` jobs for one site
 * are never actually in flight together, and this function's other caller —
 * `verify`'s unresolvable-candidates path — reaches a DIFFERENT pattern each
 * time it's called, so the two callers can't double-fire for the same
 * pattern either. If that concurrency is ever raised, this stops being true
 * and needs a real compare-and-set instead of a count comparison.
 *
 * THE DENOMINATOR IS `total_patterns`, not a count of `verify` jobs enqueued.
 * Every pattern for a run ends up in a terminal status one way or another:
 * `verify` sets `measured`/`blocked`/`needs_review` for a pattern it actually
 * probed, and `ingest` itself sets `needs_review` immediately for a pattern
 * whose sample had no resolvable candidates (see `drawSamples`). So once the
 * count of patterns in a terminal status reaches `total_patterns`, every
 * pattern that will EVER finish has finished — there is no third outcome left
 * to wait for.
 *
 * CALLED FROM TWO PLACES, deliberately. `estimate`'s own completion is the
 * common case, but a pattern that comes back fully unresolvable never reaches
 * `estimate` at all (`verify` returns early rather than enqueuing it) — and
 * if that happens to be the LAST pattern a run is waiting on, nothing would
 * ever re-check completion unless `verify`'s early-return path also calls
 * this. Idempotent either way: calling it once more than strictly necessary
 * just repeats a count query that finds nothing new to finish.
 */
export async function checkRunCompletion(
  deps: PipelineDeps,
  scope: SiteScope,
  input: { readonly siteId: string; readonly sitemapRunId: string }
): Promise<void> {
  const run = await findRunById(deps.db, scope, input.sitemapRunId);

  if (run === undefined || run.totalPatterns === 0) {
    // Either the run is not visible in this scope (should not happen — the
    // caller already wrote to it under the same scope moments ago) or ingest
    // has not yet recorded a pattern count at all. Either way there is
    // nothing this check can safely conclude yet.
    return;
  }

  const counts = await countPatternsByStatus(
    deps.db,
    scope,
    input.sitemapRunId
  );
  const terminal = new Set(["measured", "blocked", "needs_review"]);
  const done = counts
    .filter((entry) => terminal.has(entry.status))
    .reduce((total, entry) => total + entry.count, 0);

  if (done >= run.totalPatterns) {
    await deps.enqueue("finalize", {
      siteId: input.siteId,
      sitemapRunId: input.sitemapRunId
    });
  }
}
