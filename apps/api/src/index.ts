import { createDatabase } from "@pattern-aware/database";
import { createLogger, getConfig } from "@pattern-aware/shared";

import { buildApp } from "./app.js";

// Fail fast and loudly on bad configuration, before anything binds a port.
const config = getConfig();
const logger = createLogger({
  service: "api",
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development"
});

const { db, close: closeDatabase } = createDatabase({
  connectionString: config.DATABASE_URL
});

const app = buildApp(config, logger, db);

// Drain in-flight requests before exiting so a deploy does not sever a response
// mid-write. Registered before listen so a signal during startup is still
// handled. The pool closes after the app so an in-flight request's last query
// still has a live connection to finish on.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutdown signal received, closing api");

    app
      .close()
      .then(() => closeDatabase())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "api failed to close cleanly");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
} catch (error) {
  logger.error({ err: error }, "api failed to start");
  process.exit(1);
}
