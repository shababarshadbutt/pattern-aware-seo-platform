import {
  type Database,
  failStaleRun,
  findStaleRuns
} from "@pattern-aware/database";
import type { Logger } from "@pattern-aware/shared";

/**
 * The stale-run recovery path that the schema has always described
 * (`heartbeat_at`, `idx_sitemap_run_heartbeat`) but that nothing implemented.
 *
 * This is the SLOW backstop, not the primary failure signal —
 * `SitePipeline`'s own `worker.on("failed", ...)` handler fails a run
 * immediately once BullMQ's retries are exhausted for one of its jobs. What
 * this catches is the case that handler cannot: the WORKER PROCESS itself
 * dying (killed, crashed, OOM), where no "failed" event ever fires because
 * nothing is left running to fire it. A run stuck this way would otherwise
 * hold `uq_sitemap_run_one_active_per_site`'s slot forever, silently
 * preventing its site from ever being audited again.
 *
 * A fleet-wide read with no `SiteScope`, deliberately: `findStaleRuns` names
 * exactly why in its own docblock. It returns ids only, never site content,
 * and this function's only write is failing a run by id — it cannot become a
 * second way to read another tenant's data.
 */
export async function sweepStaleRuns(
  db: Database,
  logger: Logger,
  thresholdMs: number
): Promise<number> {
  const stale = await findStaleRuns(db, thresholdMs);

  let failed = 0;

  for (const run of stale) {
    const didFail = await failStaleRun(
      db,
      run.id,
      `STALE_HEARTBEAT: no heartbeat for over ${thresholdMs}ms`
    );

    if (didFail) {
      failed += 1;

      logger.warn(
        { runId: run.id, siteId: run.siteId, thresholdMs },
        "run swept as stale — no heartbeat, worker likely died mid-run"
      );
    }
  }

  return failed;
}
