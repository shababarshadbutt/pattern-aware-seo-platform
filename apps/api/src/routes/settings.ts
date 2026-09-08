import { type Database, findOrganization } from "@pattern-aware/database";

import type { SettingsConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import {
  POLICY_LIMIT_KEYS,
  POLICY_LIMITS,
  SITE_POLICY_COLUMNS
} from "../policy-manifest.js";
import { errorResponse, settingsResponse } from "../schemas.js";

/**
 * Read-only platform settings: who we are acting as, and what limits apply.
 *
 * This route is the first caller `findOrganization` has ever had — it has been
 * exported from packages/database since M1 with nothing reading it, because
 * `resolveDefaultOrgScope` keeps only the organization's id and discards its
 * name and slug.
 *
 * NOTHING HERE IS EDITABLE, and that is a property of the API rather than an
 * omission on the screen: there is no mutation route anywhere, and there is no
 * auth to scope one to (ADR-0026).
 */
export function registerSettingsRoutes(
  app: ApiInstance,
  db: Database,
  config: SettingsConfig
): void {
  app.get(
    "/settings",
    {
      schema: {
        response: {
          200: settingsResponse,
          404: errorResponse,
          503: errorResponse
        }
      }
    },
    async () => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const organization = await findOrganization(db, orgScope);

      if (!organization) {
        /*
         * Reachable only if the organization row is deleted between
         * `resolveDefaultOrgScope` memoising its id and this read. Distinct
         * from the 503 that means "never seeded": the scope was valid once.
         */
        throw ApiProblem.notFound(
          "ORGANIZATION_NOT_FOUND",
          "The configured organization no longer exists."
        );
      }

      return {
        organization,
        /**
         * Built by INDEXING the manifest, never by naming a key literally.
         *
         * If this route wrote `config.HTTP_BUDGET_HALT_FRACTION`, the
         * enforcement guard would see a reference to a limit the manifest calls
         * unenforced and fail — correctly, because it cannot tell serving a
         * number from applying one. Indexing keeps the guard's signal clean.
         */
        policy: POLICY_LIMIT_KEYS.map((key) => ({
          key,
          label: POLICY_LIMITS[key].label,
          unit: POLICY_LIMITS[key].unit,
          enforcedAt: POLICY_LIMITS[key].enforcedAt,
          value: config[key]
        })),
        siteColumns: Object.entries(SITE_POLICY_COLUMNS).map(([key, meta]) => ({
          key,
          label: meta.label,
          unit: meta.unit,
          enforcedAt: meta.enforcedAt
        }))
      };
    }
  );
}
