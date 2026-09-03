import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config, Logger } from "@pattern-aware/shared";
import type { Database } from "@pattern-aware/database";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";

import { registerHealthRoutes } from "./routes/health.js";
import { registerPatternRoutes } from "./routes/patterns.js";
import { registerSiteRoutes } from "./routes/sites.js";

/**
 * This API's Fastify instance type.
 *
 * Spelled out rather than using the bare `FastifyInstance` default because
 * handing Fastify our own pino instance narrows its logger generic, and the
 * default alias resolves to `FastifyBaseLogger` — which is a supertype, so the
 * two are not interchangeable in a declared signature.
 */
export type ApiInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger
>;

/**
 * Build the Fastify instance without starting it.
 *
 * Separated from the bootstrap in index.ts so integration tests can drive the
 * API through `app.inject()` without binding a port or racing another test for
 * it — and so config and logger arrive as arguments rather than being read from
 * module-global state a test cannot control.
 *
 * Takes `db` as a parameter for the same reason: a test can hand this a
 * scoped test-harness database instead of the real pool, and nothing here
 * reaches for global state to find one.
 */
export function buildApp(
  config: Config,
  logger: Logger,
  db: Database
): ApiInstance {
  const app = Fastify({ loggerInstance: logger });

  // apps/web (port 3000) and this API (port 3001) are different origins in
  // dev, so the browser needs an explicit allow rather than same-origin
  // defaults. Wide open for now — there is no cookie/credential auth yet to
  // scope this down to (M7 will tighten it alongside real auth).
  void app.register(cors, { origin: true });

  registerHealthRoutes(app, config);
  registerSiteRoutes(app, db, config);
  registerPatternRoutes(app, db, config);

  return app;
}
