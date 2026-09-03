import type { Config } from "@pattern-aware/shared";
import {
  type Database,
  findRunSamplingHealth,
  findSiteById,
  listRuns,
  listSites,
  siteScopeWithin
} from "@pattern-aware/database";

import type { ApiInstance } from "../app.js";
import { resolveDefaultOrgScope } from "../org-scope.js";

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
  app.get("/sites", async () => {
    const orgScope = await resolveDefaultOrgScope(db, config);
    const sites = await listSites(db, orgScope);

    return { sites };
  });

  app.get<{ Params: { siteId: string } }>(
    "/sites/:siteId",
    async (request, reply) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      const site = await findSiteById(db, siteScope);

      if (!site) {
        reply.code(404);
        return { error: "site not found" };
      }

      const runs = await listRuns(db, siteScope, 1);
      const latestRun = runs[0];
      const samplingHealth = latestRun
        ? await findRunSamplingHealth(db, siteScope, latestRun.id)
        : undefined;

      return { site, latestRun, samplingHealth };
    }
  );
}
