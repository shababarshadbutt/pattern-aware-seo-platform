import {
  type Database,
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
import type { Logger } from "@pattern-aware/shared";
import type { SitemapFileStore } from "@pattern-aware/sitemap";
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

      const worker = new Worker(
        name,
        async (job: Job) => runStage(stage, deps, this.#scope, job.data),
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
          concurrency: this.#options.concurrency ?? 1
        }
      );

      worker.on("failed", (job, error) => {
        this.#logger.error(
          { stage, jobId: job?.id, attempts: job?.attemptsMade, err: error },
          "pipeline stage failed"
        );
      });

      worker.on("completed", (job) => {
        this.#logger.debug(
          { stage, jobId: job.id },
          "pipeline stage completed"
        );
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
  }): Promise<void> {
    await this.#enqueue()("discover", {
      siteId: this.#options.siteId,
      sitemapRunId: payload.sitemapRunId,
      sitemapUrl: payload.sitemapUrl
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

  #buildDeps(): PipelineDeps {
    return {
      db: this.#options.db,
      store: this.#options.store,
      logger: this.#logger,
      fetchSitemap: this.#options.fetchSitemap,
      enqueue: this.#enqueue(),
      rateLimiter: this.#options.rateLimiter,
      circuitBreaker: this.#options.circuitBreaker
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
