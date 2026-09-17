import {
  ATTACH_REQUESTS_QUEUE,
  type AttachRequestPayload
} from "@pattern-aware/pipeline";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * The API's one and only reach into Redis/BullMQ.
 *
 * Deliberately not part of `SettingsConfig`/`buildApp`'s general config
 * parameter — `REDIS_URL` has no default, so widening the config every route
 * receives to require it would force every test building that config to also
 * hold a Redis URL, undoing the exact fix `api-config.ts` documents twice
 * already (§1.13: a monolithic dependency meeting a consumer that needs
 * less than the whole). This is injected as its own optional parameter,
 * the same way `db: Database` already is, so a test can simply omit it and
 * `POST /sites/:siteId/runs` responds `503` rather than requiring Redis to
 * exist for a suite that has never needed it.
 */
export interface RunTrigger {
  /** Post an attach-and-start request. See `ATTACH_REQUESTS_QUEUE`'s docblock. */
  readonly requestRun: (payload: AttachRequestPayload) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createRunTrigger(redisUrl: string): RunTrigger {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(ATTACH_REQUESTS_QUEUE, { connection });

  return {
    async requestRun(payload) {
      await queue.add("attach-request", payload, {
        /**
         * THE SAME RETRY/BACKOFF POLICY AS EVERY STAGE QUEUE (see
         * `SitePipeline#enqueue`), and for the same reason: `startRun` has
         * already reserved this run's row as `running` — that is what makes a
         * concurrent second call answer 409 — before this message is ever
         * sent. If the attach request itself were lost (a Redis blip between
         * the API and the broker, the worker process restarting mid-delivery)
         * with no retry, the run would sit `running` forever with nothing
         * ever having attached a `Worker` to consume it: no BullMQ job ever
         * fails, so `SitePipeline`'s own exhausted-retries handler never
         * fires, and the run would wait out the stale-run sweeper's full
         * heartbeat threshold before anything noticed — minutes of silent
         * "running" for a run that was never actually started. Retrying this
         * one message is far cheaper than that wait.
         */
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 }
      });
    },
    async close() {
      await queue.close();
      await connection.quit();
    }
  };
}
