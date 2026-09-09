import type { Config, PolicyConfig } from "@pattern-aware/shared";

/**
 * The config the API actually reads — two keys, not the whole environment.
 *
 * Declared narrowly and in its own module for two reasons. First, `buildApp`
 * previously took the full `Config`, so constructing it in a test meant
 * validating every variable the platform has, including `REDIS_URL`, which no
 * route touches — the same composition failure §1.13 records twice already: a
 * monolithic validator meeting a consumer that needs less than the whole. A
 * structural subset means the real `Config` still satisfies this at the call
 * site in `index.ts`, while a test hands over a two-field literal.
 *
 * Second, it lives here rather than in `app.ts` so `org-scope.ts` can name it
 * without importing from the module that imports it.
 *
 * `index.ts` still reads the full validated `Config` at the process edge, for
 * the things a process genuinely needs: DATABASE_URL, API_PORT, LOG_LEVEL.
 */
export type ApiConfig = Pick<
  Config,
  | "NODE_ENV"
  | "DEFAULT_ORGANIZATION_SLUG"
  | "BASIC_AUTH_USER"
  | "BASIC_AUTH_PASSWORD"
  | "APP_VERSION"
>;

/**
 * `ApiConfig` plus the operational limits the Settings route serves.
 *
 * A SEPARATE TYPE, and `ApiConfig` above is deliberately left alone. Only
 * `buildApp` and `registerSettingsRoutes` need the limits; `org-scope.ts` and
 * `health.ts` must keep needing exactly two fields, because the narrowness is
 * the §1.13 fix rather than a stylistic preference.
 *
 * Widening `buildApp` costs its callers nothing. The real `Config` is a
 * structural superset, so `index.ts` still passes what it always did, and a
 * test spreads `loadPolicyConfig({})` — which parses an empty environment,
 * since every policy key is defaulted. So the suite still cannot be made to
 * depend on `REDIS_URL`, which is the invariant that mattered.
 */
export type SettingsConfig = ApiConfig & PolicyConfig;
