import {
  type Database,
  finishRun,
  heartbeatRun,
  jobSiteScope,
  type SiteScope
} from "@pattern-aware/database";
import {
  type EnqueueStage,
  PIPELINE_STAGES,
  type PipelineDeps,
  type PipelineStage,
  queueName,
  runStage,
  type SiteTier
} from "@pattern-aware/pipeline";
import type { SampleBudget } from "@pattern-aware/sampling";
import type { Logger } from "@pattern-aware/shared";
import type {
  OversizeThresholds,
  SitemapFileStore
} from "@pattern-aware/sitemap";
import type {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

/**
 * One site's five queues, and the workers that drain them.
 *
 * WHY PER SITE RATHER THAN PER STAGE. A queue named only for its stage puts
 * every site's jobs in one line, so one 90-million-URL site's ingest floods it
 * and every other site waits behind that flood. Namespacing by
 * `{tier}:{siteId}:{stage}` is what makes that impossible — but BullMQ has no
 * wildcard consumer, so someone has to hold a `Worker` per queue, which is what
 * this class is.
 *
 * THE CEILING, stated rather than discovered later: five workers and five
 * queues per site means a process cannot hold all 650 sites at once. It does
 * not need to. The request budget allows roughly twenty site audits a day, so
 * the supervisor attaches to sites with a run in flight and detaches when the
 * run ends — a hundred workers, not three thousand. A fleet that outgrows that
 * needs a queue-per-tier with per-site fairness inside it (BullMQ's group
 * support, or a scheduler), and that is a decision to take with real numbers
 * rather than pre-emptively.
 */

/**
 * Every stage payload carries `sitemapRunId` (see `payloads.ts`'s shared
 * `runContext`), but a job's `data` is untyped at this layer — the worker
 * dispatches by queue name, not by a payload it has already validated. Reads
 * defensively rather than parsing the whole payload again, since heartbeat
 * and failure handling only ever need this one field.
 */
function runIdFromJobData(data: unknown): string | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "sitemapRunId" in data &&
    typeof (data as { sitemapRunId: unknown }).sitemapRunId === "string"
  ) {
    return (data as { sitemapRunId: string }).sitemapRunId;
  }

  return undefined;
}

export interface SitePipelineOptions {
  readonly connection: Redis;
  readonly db: Database;
  readonly store: SitemapFileStore;
  readonly logger: Logger;
  readonly organizationId: string;
  readonly siteId: string;
  readonly tier: SiteTier;
  readonly fetchSitemap: PipelineDeps["fetchSitemap"];
  readonly rateLimiter: HostRateLimiter;
  readonly circuitBreaker: HostCircuitBreaker;
  readonly sampleBudget: SampleBudget;
  readonly oversizeThresholds: OversizeThresholds;
  /** Jobs this process will run at once, across this site's stages. */
  readonly concurrency?: number;
}

export class SitePipeline {
  readonly #queues = new Map<PipelineStage, Queue>();
  readonly #workers: Worker[] = [];
  readonly #scope: SiteScope;
  readonly #logger: Logger;
  readonly #options: SitePipelineOptions;

  public constructor(options: SitePipelineOptions) {
    this.#options = options;
    this.#scope = jobSiteScope({
      organizationId: options.organizationId,
      siteId: options.siteId
    });
    this.#logger = options.logger.child({
      siteId: options.siteId,
      tier: options.tier
    });

    for (const stage of PIPELINE_STAGES) {
      const name = queueName({
        tier: options.tier,
        siteId: options.siteId,
        stage
      });

      this.#queues.set(
        stage,
        new Queue(name, { connection: options.connection })
      );
    }
  }

  /** Start draining every stage. */
  public start(): void {
    const deps = this.#buildDeps();

    for (const stage of PIPELINE_STAGES) {
      const name = queueName({
        tier: this.#options.tier,
        siteId: this.#options.siteId,
        stage
      });

      const concurrency = this.#options.concurrency ?? 1;

      if (stage === "estimate" && concurrency !== 1) {
        /**
         * THE INVARIANT `checkRunCompletion` DEPENDS ON, not a resource limit
         * to relax casually. `estimate.ts`'s fan-in decides "has this run
         * finished" with a count comparison rather than a distributed lock,
         * and that is only safe because exactly one `estimate` job for a
         * given site is ever in flight at a time — two running concurrently
         * could both read the same "not yet done" count and neither would
         * ever see the other's completion, or both could fire `finalize`.
         * Raising this needs a real compare-and-set in `checkRunCompletion`
         * first, not just a config change here.
         */
        throw new Error(
          `estimate concurrency must stay 1 per site; got ${concurrency}. See the comment above this check before changing it.`
        );
      }

      const worker = new Worker(
        name,
        async (job: Job) =>
          runStage(
            stage,
            /**
             * A FRESH OBJECT PER JOB, not the shared `deps` directly.
             * `reportProgress` belongs to one job, not to the whole site the
             * way `enqueue`/`rateLimiter` do, so it has to close over THIS
             * job rather than being set once when the site was attached.
             */
            {
              ...deps,
              reportProgress: async (fraction) => {
                await job.updateProgress(fraction);
              }
            },
            this.#scope,
            job.data
          ),
        {
          connection: this.#options.connection,
          /**
           * One job at a time per stage by default.
           *
           * Ingest holds a pattern trie and a per-pattern sample heap for a
           * whole site; two concurrent ingests for one site would double that
           * against a memory budget sized for one. Verification's parallelism
           * belongs to the per-host rate limiter, not to job concurrency —
           * running four verify jobs at once would not send requests faster,
           * it would just queue them inside the limiter.
           */
          concurrency
        }
      );

      worker.on("failed", (job, error) => {
        this.#logger.error(
          { stage, jobId: job?.id, attempts: job?.attemptsMade, err: error },
          "pipeline stage failed"
        );

        void this.#handleExhaustedRetries(stage, job, error);
      });

      worker.on("completed", (job) => {
        this.#logger.debug(
          { stage, jobId: job.id },
          "pipeline stage completed"
        );

        void this.#heartbeat(job);
      });

      this.#workers.push(worker);
    }

    this.#logger.info(
      { stages: PIPELINE_STAGES.length },
      "site pipeline attached"
    );
  }

  /** Kick off a run by enqueuing its first stage. */
  public async startRun(payload: {
    readonly sitemapRunId: string;
    readonly sitemapUrl: string;
    readonly baseUrl: string;
    readonly expectedHost: string;
  }): Promise<void> {
    await this.#enqueue()("discover", {
      siteId: this.#options.siteId,
      sitemapRunId: payload.sitemapRunId,
      sitemapUrl: payload.sitemapUrl,
      baseUrl: payload.baseUrl,
      expectedHost: payload.expectedHost
    });
  }

  /**
   * Stop consuming, letting in-flight jobs finish.
   *
   * Workers close before the queues they read: closing a queue's connection
   * first would leave a running job unable to renew its lock, so BullMQ would
   * reclaim it as stalled and hand a duplicate to another worker.
   */
  public async stop(): Promise<void> {
    await Promise.all(this.#workers.map(async (worker) => worker.close()));
    await Promise.all([...this.#queues.values()].map(async (q) => q.close()));

    this.#logger.info("site pipeline detached");
  }

  /**
   * Keep this run's heartbeat current after every stage that completes for
   * it. Feeds the stale-run sweeper's only signal: a run whose heartbeat
   * stops moving — because the worker process holding it died, not because
   * any single job failed cleanly — is what the sweeper (`apps/worker/src/
   * stale-run-sweeper.ts`) eventually notices and fails.
   */
  async #heartbeat(job: Job): Promise<void> {
    const runId = runIdFromJobData(job.data);

    if (runId === undefined) {
      return;
    }

    await heartbeatRun(this.#options.db, this.#scope, runId).catch(
      (error: unknown) => {
        this.#logger.warn({ jobId: job.id, err: error }, "heartbeat failed");
      }
    );
  }

  /**
   * The event-driven half of run failure. BullMQ's own retries (see
   * `#enqueue`) absorb a transient failure; once they are exhausted for a
   * job, the run this job belonged to is failed immediately rather than left
   * `running` until the heartbeat sweeper's slower timeout catches it —
   * which matters because the sweeper cannot distinguish "the worker died"
   * from "a job is legitimately still working," so its timeout has to be
   * generous. A clean failure signal like this one should not wait for it.
   */
  async #handleExhaustedRetries(
    stage: PipelineStage,
    job: Job | undefined,
    error: unknown
  ): Promise<void> {
    if (job === undefined) {
      return;
    }

    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts) {
      // More retries remain; BullMQ will hand this job out again.
      return;
    }

    const runId = runIdFromJobData(job.data);

    if (runId === undefined) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    await finishRun(this.#options.db, this.#scope, runId, {
      status: "failed",
      statusReason: `STAGE_EXHAUSTED_RETRIES:${stage}:${message.slice(0, 200)}`
    }).catch((finishError: unknown) => {
      this.#logger.error(
        { jobId: job.id, err: finishError },
        "failed to mark run failed after exhausted retries"
      );
    });
  }

  #buildDeps(): PipelineDeps {
    return {
      db: this.#options.db,
      store: this.#options.store,
      logger: this.#logger,
      fetchSitemap: this.#options.fetchSitemap,
      enqueue: this.#enqueue(),
      rateLimiter: this.#options.rateLimiter,
      circuitBreaker: this.#options.circuitBreaker,
      sampleBudget: this.#options.sampleBudget,
      oversizeThresholds: this.#options.oversizeThresholds
    };
  }

  /**
   * Hand a follow-on job to this site's own queue for that stage.
   *
   * Bound to this site, so a stage physically cannot enqueue into another
   * tenant's lane even if its payload said so — which is the other half of the
   * guard `assertScopeMatchesPayload` provides on the way in.
   */
  #enqueue(): EnqueueStage {
    return async (stage, payload) => {
      const queue = this.#queues.get(stage);

      if (queue === undefined) {
        throw new Error(`no queue for stage ${stage}`);
      }

      await queue.add(stage, payload, {
        /**
         * Retries are bounded and backed off. A stage that fails for a reason
         * retrying cannot fix — a changed sitemap, a malformed payload — should
         * not occupy a worker indefinitely, and the handlers that know a failure
         * is permanent log it and return rather than throwing.
         */
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 }
      });
    };
  }
}
