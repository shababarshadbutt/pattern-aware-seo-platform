import { createLogger, getConfig } from "@pattern-aware/shared";
import { type Job, Worker } from "bullmq";
import { Redis } from "ioredis";

// Fail fast and loudly on bad configuration, before anything connects.
const config = getConfig();
const logger = createLogger({
  service: "worker",
  level: config.LOG_LEVEL,
  pretty: config.NODE_ENV === "development"
});

// BullMQ requires this to be null rather than a retry count: a blocking command
// that gives up mid-wait leaves the worker silently not consuming.
const connection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});

// Placeholder consumer. The real pipeline lands in M5:
//   sitemap-discovery -> download -> parse -> pattern-extract
//     -> sample-plan -> http-verify -> estimate
//
// Queue names there are namespaced per site and tier ("{tier}:{siteId}:{stage}")
// rather than shared, so one site's job volume cannot starve another's. Do not
// add a second queue on the flat name below.
const worker = new Worker(
  "sitemap-discovery",
  (job: Job) => {
    logger.info({ jobId: job.id, jobName: job.name }, "processing job");

    return Promise.resolve({ ok: true });
  },
  { connection }
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "job completed");
});

worker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, err: error }, "job failed");
});

logger.info({ queue: "sitemap-discovery" }, "worker started");

// Close the worker before the Redis connection so an in-flight job finishes and
// releases its lock; killing the connection first would leave the job stalled
// until BullMQ's lock expiry reclaims it.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutdown signal received, closing worker");

    worker
      .close()
      .then(async () => {
        await connection.quit();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "worker failed to close cleanly");
        process.exit(1);
      });
  });
}
