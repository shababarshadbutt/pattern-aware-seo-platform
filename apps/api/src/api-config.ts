import type { Config } from "@pattern-aware/shared";

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
export type ApiConfig = Pick<Config, "NODE_ENV" | "DEFAULT_ORGANIZATION_SLUG">;
