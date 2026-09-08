import {
  type Database,
  listOrganizationSnapshotsByImpact
} from "@pattern-aware/database";

import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { withImpactBounds } from "../findings.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import { errorResponse, fleetQuery, issuesResponse } from "../schemas.js";

/**
 * Every site's findings in one organization, worst first.
 *
 * The fleet counterpart to the per-pattern evidence screen: its question is
 * "which of my sites needs attention", which no per-site route can answer.
 *
 * There is no `siteId` in the path and therefore no membership check to make —
 * which is exactly why the tenant boundary has to be somewhere else.
 * `listOrganizationSnapshotsByImpact` resolves the site ids from the
 * `OrganizationScope` itself, so this route cannot be pointed at another
 * tenant's data by anything a caller sends (ADR-0028). Contrast the pattern
 * routes, where a caller-supplied `siteId` makes `assertSiteInOrg`
 * load-bearing.
 *
 * Findings go through `withImpactBounds` for the same reason they do there:
 * impact is `point_estimate × severity_weight` and ADR-0008 does not exempt it
 * from carrying an interval.
 */
export function registerIssueRoutes(
  app: ApiInstance,
  db: Database,
  config: ApiConfig
): void {
  app.get(
    "/issues",
    {
      schema: {
        querystring: fleetQuery,
        response: {
          200: issuesResponse,
          400: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      const findings = await listOrganizationSnapshotsByImpact(db, orgScope, {
        limit: request.query.limit
      });

      return { issues: findings.map(withImpactBounds) };
    }
  );
}
