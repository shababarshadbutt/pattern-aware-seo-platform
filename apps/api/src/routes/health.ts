import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";

/**
 * Liveness endpoint.
 *
 * Deliberately checks nothing downstream: the load balancer uses this to decide
 * whether to keep routing to this task, and a health check that failed because
 * Postgres was briefly slow would take the whole API out over a dependency
 * blip. Dependency readiness gets its own endpoint once there are dependencies
 * worth reporting on (M1).
 */
export function registerHealthRoutes(
  app: ApiInstance,
  config: ApiConfig
): void {
  app.get("/health", () => ({
    status: "ok",
    service: "api",
    environment: config.NODE_ENV,
    version: config.APP_VERSION ?? "0.0.0-dev"
  }));
}
