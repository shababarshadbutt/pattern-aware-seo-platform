import {
  type Database,
  findRunSamplingHealth,
  findSiteById,
  listRuns,
  listSites,
  siteScopeWithin
} from "@pattern-aware/database";
import type { Config } from "@pattern-aware/shared";

import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import {
  errorResponse,
  siteDetailResponse,
  siteParams,
  sitesResponse
} from "../schemas.js";

/**
 * Sites list + single-site overview.
 *
 * Both routes resolve the organization scope on every request rather than
 * once at startup: `resolveDefaultOrgScope` is memoised internally, so this
 * costs nothing after the first successful lookup, and it means the API
 * comes up fine before `pnpm seed:demo` has run — the first request after
 * seeding just starts working instead of needing a restart.
 */
export function registerSiteRoutes(
  app: ApiInstance,
  db: Database,
  config: Config
): void {
  app.get(
    "/sites",
    { schema: { response: { 200: sitesResponse, 503: errorResponse } } },
    async () => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      return { sites: await listSites(db, orgScope) };
    }
  );

  app.get(
    "/sites/:siteId",
    {
      schema: {
        params: siteParams,
        response: {
          200: siteDetailResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      /**
       * THE ORGANIZATION-MEMBERSHIP CHECK, and it has to happen here.
       *
       * `siteScopeWithin` carries the organization across but cannot verify
       * that the site belongs to it — its own doc says the caller owes that
       * check and that `findSiteById` performs it, because that query filters
       * on both ids. A site belonging to another organization therefore finds
       * nothing rather than returning their data.
       */
      const site = await findSiteById(db, siteScope);

      if (!site) {
        throw ApiProblem.notFound("SITE_NOT_FOUND", "No such site.");
      }

      const runs = await listRuns(db, siteScope, 1);
      const latestRun = runs[0];

      return {
        site,
        latestRun,
        samplingHealth: latestRun
          ? await findRunSamplingHealth(db, siteScope, latestRun.id)
          : undefined
      };
    }
  );
}
