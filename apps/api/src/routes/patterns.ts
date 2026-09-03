import type { Config } from "@pattern-aware/shared";
import {
  type Database,
  findPatternById,
  findSnapshotsByPattern,
  latestPatternSample,
  listObservations,
  listPatternsByPopulation,
  listRuns,
  type SiteScope,
  siteScopeWithin
} from "@pattern-aware/database";

import type { ApiInstance } from "../app.js";
import { resolveDefaultOrgScope } from "../org-scope.js";

/**
 * The run these screens read from.
 *
 * "Latest" is not always the right run to show: a run that is still `queued`
 * or `running` has no finished patterns yet, and a `failed` run's rows are
 * not trustworthy. `degraded` (finished with some patterns blocked/needs
 * review) is still a real result and belongs on screen, so it counts as
 * complete for this purpose. `listRuns` already orders newest first, so the
 * first match here is the most recent usable run.
 */
async function latestCompleteRunId(
  db: Database,
  siteScope: SiteScope
): Promise<string | undefined> {
  const runs = await listRuns(db, siteScope, 10);
  const complete = runs.find(
    (run) => run.status === "complete" || run.status === "degraded"
  );

  return complete?.id;
}

/**
 * Pattern list for a site's latest usable run, and single-pattern detail with
 * its sample evidence (individual observations + published findings).
 */
export function registerPatternRoutes(
  app: ApiInstance,
  db: Database,
  config: Config
): void {
  app.get<{ Params: { siteId: string } }>(
    "/sites/:siteId/patterns",
    async (request, reply) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      const runId = await latestCompleteRunId(db, siteScope);

      if (!runId) {
        reply.code(404);
        return { error: "no completed run for this site yet" };
      }

      const patterns = await listPatternsByPopulation(db, siteScope, runId, 200);

      return { sitemapRunId: runId, patterns };
    }
  );

  app.get<{ Params: { siteId: string; patternId: string } }>(
    "/sites/:siteId/patterns/:patternId",
    async (request, reply) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      const pattern = await findPatternById(
        db,
        siteScope,
        request.params.patternId
      );

      if (!pattern) {
        reply.code(404);
        return { error: "pattern not found" };
      }

      const sample = await latestPatternSample(db, siteScope, pattern.id);
      const findings = await findSnapshotsByPattern(db, siteScope, pattern.id);
      const observations = sample
        ? await listObservations(db, siteScope, sample.id, 200)
        : [];

      return { pattern, latestSample: sample, findings, observations };
    }
  );
}
