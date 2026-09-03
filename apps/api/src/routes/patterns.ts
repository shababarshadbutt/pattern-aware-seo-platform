import {
  type AuditSnapshotRow,
  type Database,
  findPatternById,
  findSiteById,
  findSnapshotsByPattern,
  latestPatternSample,
  listObservations,
  listPatternsByPopulation,
  listRuns,
  type SiteScope,
  siteScopeWithin
} from "@pattern-aware/database";
import type { Config } from "@pattern-aware/shared";

import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import {
  errorResponse,
  patternDetailResponse,
  patternParams,
  patternsResponse,
  siteParams
} from "../schemas.js";

/**
 * The run these screens read from.
 *
 * "Latest" is not always the right run to show: a run that is still `pending`
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

  return runs.find(
    (run) => run.status === "complete" || run.status === "degraded"
  )?.id;
}

/**
 * Impact, as the estimated quantity it is.
 *
 * `impact_score` is `point_estimate × severity_weight`, so its interval is the
 * estimate's interval under the same weighting — exactly what `scoreImpact`
 * computes as `scoreLow`/`scoreHigh`. Derived here rather than persisted:
 * every input is already on the row, so two more columns would add a migration
 * and a second place for the same number to drift.
 *
 * Sending it matters because ADR-0008 forbids rendering an estimate without
 * its interval, and impact was being rendered as a bare figure.
 */
function withImpactBounds(snapshot: AuditSnapshotRow): AuditSnapshotRow & {
  readonly impactLow: number;
  readonly impactHigh: number;
} {
  return {
    ...snapshot,
    impactLow: snapshot.ciLow * snapshot.severityWeight,
    impactHigh: snapshot.ciHigh * snapshot.severityWeight
  };
}

/**
 * Confirm the site exists AND belongs to the resolved organization.
 *
 * Every route below reads rows keyed on `siteId`, and the repositories for
 * runs, patterns, samples and observations all filter on `site_id` alone —
 * correctly, since a `SiteScope` is supposed to have been vouched for already.
 * `siteScopeWithin` explicitly does not vouch for it: it carries the
 * organization across but cannot check membership, and says so. Without this
 * call a caller-supplied `siteId` reads another organization's data. Latent
 * today because one organization exists; a cross-tenant read the moment that
 * changes.
 */
async function assertSiteInOrg(
  db: Database,
  siteScope: SiteScope
): Promise<void> {
  if (!(await findSiteById(db, siteScope))) {
    throw ApiProblem.notFound("SITE_NOT_FOUND", "No such site.");
  }
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
  app.get(
    "/sites/:siteId/patterns",
    {
      schema: {
        params: siteParams,
        response: {
          200: patternsResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      await assertSiteInOrg(db, siteScope);

      const runId = await latestCompleteRunId(db, siteScope);

      if (!runId) {
        /**
         * NOT a 404. The site exists; it has no finished run yet. Returning
         * "not found" made a freshly-onboarded site look identical to a typo
         * in the URL, and the screen could not tell the reader which it was.
         */
        return { sitemapRunId: null, patterns: [] };
      }

      return {
        sitemapRunId: runId,
        patterns: await listPatternsByPopulation(db, siteScope, runId, 200)
      };
    }
  );

  app.get(
    "/sites/:siteId/patterns/:patternId",
    {
      schema: {
        params: patternParams,
        response: {
          200: patternDetailResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      await assertSiteInOrg(db, siteScope);

      const pattern = await findPatternById(
        db,
        siteScope,
        request.params.patternId
      );

      if (!pattern) {
        throw ApiProblem.notFound("PATTERN_NOT_FOUND", "No such pattern.");
      }

      const sample = await latestPatternSample(db, siteScope, pattern.id);
      const findings = await findSnapshotsByPattern(db, siteScope, pattern.id);

      return {
        pattern,
        latestSample: sample,
        findings: findings.map(withImpactBounds),
        observations: sample
          ? await listObservations(db, siteScope, sample.id, 200)
          : []
      };
    }
  );
}
