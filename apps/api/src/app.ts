import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config, Logger } from "@pattern-aware/shared";
import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";

import { registerHealthRoutes } from "./routes/health.js";

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
 */
export function buildApp(config: Config, logger: Logger): ApiInstance {
  const app = Fastify({ loggerInstance: logger });

  registerHealthRoutes(app, config);

  return app;
}
