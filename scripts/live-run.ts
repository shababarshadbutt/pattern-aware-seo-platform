import { argv } from "node:process";
import { Readable } from "node:stream";

import {
  countPatternsByStatus,
  createDatabase,
  createOrganization,
  createSite,
  findActiveRun,
  findOrganizationBySlug,
  findRunSamplingHealth,
  finishRun,
  listPatternsByPopulation,
  listSitemapFiles,
  listSites,
  listSnapshotsByImpact,
  type SiteScope,
  siteScopeWithin,
  startRun,
  systemOrganizationScope
} from "@pattern-aware/database";
import {
  type PipelineDeps,
  type PipelineStage,
  runDiscover,
  runIngest,
  runStage,
  type SitemapResponse
} from "@pattern-aware/pipeline";
import {
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "@pattern-aware/sampling";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import { LocalDiskFileStore } from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";

/**
 * Runs the real pipeline against a real sitemap, in one process, on demand.
 *
 * WHY THIS EXISTS AT ALL. Nothing in this repo could start a measured run.
 * `startRun` had callers only in tests and in `seed-demo.ts` — which fabricates
 * evidence and stamps `is_dry_run` to say so — and `attachSite` in
 * `apps/worker` has never had a caller, so the worker process starts, logs
 * "awaiting site attachments", and waits forever. A live audit was therefore
 * unreachable by any route, script or queue.
 *
 * WHY IT DRIVES THE STAGES DIRECTLY rather than enqueuing through BullMQ. The
 * pipeline does not self-chain end to end: `discover` enqueues nothing, and
 * nothing enqueues `finalize`, because a fan-in that knows every `estimate` has
 * finished does not exist. Only `ingest -> verify` and `verify -> estimate`
 * hand work on. A job pushed onto the real queue would run discovery and stop,
 * so a driver has to own the chain either way — and owning it here keeps the
 * whole run in one process, in order, where a failure is legible. Redis and
 * BullMQ are consequently the ONE layer this does not exercise; that gap is
 * stated rather than papered over.
 *
 * SAFETY, since this points requests at somebody else's production server.
 * The per-host rate limiter and the circuit breaker are constructed from the
 * same validated config the worker reads, so both are genuinely in force. The
 * daily request caps are NOT — no counter exists in any table or Redis key
 * (ADR-0030) — which is why `--max-requests` is a guard belonging to this
 * script and is described as such rather than as the platform enforcing its
 * own config. Nothing here reads robots.txt, because nothing in this platform
 * does.
 *
 *   pnpm live:run --sitemap https://example.com/sitemap.xml            # plan only
 *   pnpm live:run --sitemap https://example.com/sitemap.xml --probe    # measure
 */

/** Matches the worker's, so a live run identifies itself the same way. */
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)";

/**
 * A ceiling on total probes before this script will send any.
 *
 * THIS SCRIPT'S GUARD, not the platform's. `HTTP_PER_SITE_DAILY_REQUEST_CAP`
 * is validated at startup and applied by nothing, so a first live run against
 * an unfamiliar origin has no backstop at all. Deliberately low enough that a
 * large site trips it and forces a decision rather than sailing past.
 */
const DEFAULT_MAX_REQUESTS = 5_000;

interface Options {
  readonly sitemapUrl: string;
  readonly siteName: string | undefined;
  readonly tier: "standard" | "priority" | "bulk";
  readonly probe: boolean;
  readonly maxRequests: number;
  readonly userAgent: string;
  readonly orgSlug: string;
}

/** Read one `--flag value` pair, or undefined when the flag is absent. */
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);

  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function parseOptions(): Options {
  const sitemapUrl = flag("sitemap");

  if (sitemapUrl === undefined || sitemapUrl === "") {
    throw new Error(
      "--sitemap <url> is required, e.g. --sitemap https://example.com/sitemap.xml"
    );
  }

  // Parsed here so a typo fails before anything touches the database.
  new URL(sitemapUrl);

  const tier = flag("tier") ?? "standard";

  if (tier !== "standard" && tier !== "priority" && tier !== "bulk") {
    throw new Error(`--tier must be standard, priority or bulk (got ${tier})`);
  }

  const maxRequests = Number(flag("max-requests") ?? DEFAULT_MAX_REQUESTS);

  if (!Number.isInteger(maxRequests) || maxRequests < 1) {
    throw new Error("--max-requests must be a positive integer");
  }

  return {
    sitemapUrl,
    siteName: flag("name"),
    tier,
    probe: argv.includes("--probe"),
    maxRequests,
    userAgent: flag("user-agent") ?? DEFAULT_USER_AGENT,
    orgSlug:
      flag("org") ?? process.env.DEFAULT_ORGANIZATION_SLUG ?? "asapsemi-demo"
  };
}

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

/**
 * The site row for this host, reusing an existing one rather than failing.
 *
 * Reuse is what makes a second run against the same host a TREND rather than a
 * new site with no history — the whole reason `site` is a durable entity and
 * not an artifact of one run. `uq_site_organization_host` would refuse the
 * duplicate anyway; catching it and resolving the existing row is the
 * difference between that constraint being a wall and being the intended path.
 */
async function resolveSite(
  db: Parameters<typeof listSites>[0],
  orgScope: Parameters<typeof listSites>[1],
  input: {
    readonly host: string;
    readonly name: string;
    readonly baseUrl: string;
    readonly tier: Options["tier"];
  }
): Promise<SiteScope> {
  const sites = await listSites(db, orgScope, { includeInactive: true });
  const existing = sites.find((site) => site.host === input.host);

  if (existing !== undefined) {
    console.log(`Reusing site ${existing.id} (${existing.name})`);

    return siteScopeWithin(orgScope, existing.id);
  }

  const created = await createSite(db, orgScope, {
    name: input.name,
    baseUrl: input.baseUrl,
    tier: input.tier
  });

  console.log(`Created site ${created.row.id} (${created.row.name})`);

  return created.scope;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const connectionString = process.env.DATABASE_URL;

  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env");
  }

  /**
   * The operational limits ONLY.
   *
   * `loadPolicyConfig` is a mask over the full schema, so this reads every
   * sampling bound, rate and breaker threshold with one definition of every
   * default — and cannot reach `REDIS_URL`, which this script provably does
   * not need. Calling `getConfig()` here would make a script that touches no
   * queue refuse to start without a Redis URL, which is the composition
   * failure §1.13 has now recorded three times.
   */
  const policy = loadPolicyConfig();
  const { db, close } = createDatabase({ connectionString });

  const logger = createLogger({
    service: "live-run",
    /*
     * Deliberately not quieter than `info`. The §1.5 "succeeded but
     * suspiciously" warnings — an index naming no children, a file that parsed
     * to zero URLs — are the most valuable output a first live run produces,
     * and they are warn-level structured logs, not return values.
     */
    level: "info",
    pretty: true
  });

  const parsed = new URL(options.sitemapUrl);
  const origin = parsed.origin;
  const host = parsed.host.toLowerCase();

  try {
    const found = await findOrganizationBySlug(db, options.orgSlug);
    let orgScope = found ? systemOrganizationScope(found.id) : undefined;

    if (orgScope === undefined) {
      const created = await createOrganization(db, {
        name: options.orgSlug,
        slug: options.orgSlug
      });

      orgScope = created.scope;
      console.log(`Created organization ${created.row.id}`);
    }

    const scope = await resolveSite(db, orgScope, {
      host,
      name: options.siteName ?? host,
      baseUrl: origin,
      tier: options.tier
    });

    const active = await findActiveRun(db, scope);

    if (active !== undefined) {
      throw new Error(
        [
          `site ${scope.siteId} already has run ${active.id} in flight (${active.status}).`,
          "One active run per site is a database constraint, not a preference.",
          "If it is a leftover from an interrupted run, close that run before retrying."
        ].join("\n")
      );
    }

    const store = new LocalDiskFileStore(
      process.env.SITEMAP_STORE_ROOT ?? ".sitemaps"
    );

    const rateLimiter = new HostRateLimiter({
      requestsPerSecond: policy.HTTP_PER_HOST_REQUESTS_PER_SECOND,
      concurrency: policy.HTTP_PER_HOST_CONCURRENCY
    });

    const circuitBreaker = new HostCircuitBreaker({
      openAfter429: policy.HTTP_CIRCUIT_BREAK_AFTER_429,
      openAfter403: policy.HTTP_CIRCUIT_BREAK_AFTER_403,
      cooldownMs: policy.HTTP_CIRCUIT_COOLDOWN_MS
    });

    const sampleBudget: SampleBudget = {
      sampleRate: DEFAULT_SAMPLE_BUDGET.sampleRate,
      minSample: policy.SAMPLE_MIN_SIZE,
      maxFirstRound: policy.SAMPLE_MAX_FIRST_ROUND,
      maxExpanded: policy.SAMPLE_MAX_EXPANDED,
      maxExpansionFactor: policy.SAMPLE_MAX_EXPANSION_FACTOR,
      maxPopulationFraction: policy.SAMPLE_MAX_POPULATION_FRACTION,
      minPerStratum: policy.SAMPLE_MIN_PER_STRATUM
    };

    /**
     * Follow-on jobs, collected rather than executed.
     *
     * The same `EnqueueStage` contract BullMQ satisfies in the worker, so the
     * stages cannot tell the difference — and holding the queue here is what
     * lets the probe budget be counted and shown BEFORE any of it is spent.
     */
    const pending: {
      stage: PipelineStage;
      payload: Record<string, unknown>;
    }[] = [];

    const deps: PipelineDeps = {
      db,
      store,
      logger,
      rateLimiter,
      circuitBreaker,
      sampleBudget,
      enqueue: async (stage, payload) => {
        pending.push({ stage, payload });
      },
      fetchSitemap: async (url: string): Promise<SitemapResponse> => {
        const response = await fetch(url, {
          headers: { "user-agent": options.userAgent }
        });

        return {
          status: response.status,
          headers: new Map(
            response.headers as unknown as Iterable<[string, string]>
          ),
          body:
            response.body === null
              ? Readable.from([])
              : Readable.fromWeb(
                  response.body as Parameters<typeof Readable.fromWeb>[0]
                )
        };
      }
    };

    const run = await startRun(db, scope, {
      workerId: "live-run-script",
      /*
       * A MEASURED run, not manufactured evidence. `seed-demo.ts` stamps this
       * true precisely so seeded rows stay distinguishable from real ones at
       * the data layer; a live run must therefore stamp it false.
       */
      isDryRun: false
    });

    console.log(`Started run ${run.id} against ${options.sitemapUrl}`);

    heading("1. discover");

    const discovered = await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id,
      sitemapUrl: options.sitemapUrl
    });

    console.log(`  root element   ${discovered.rootElement}`);
    console.log(`  files          ${discovered.fileCount}`);
    console.log(`  suspicious     ${discovered.suspiciouslyEmpty}`);

    if (discovered.suspiciouslyEmpty || discovered.fileCount === 0) {
      /*
       * A document that parsed and named nothing. Not an empty site and not an
       * error — the shape a CDN error page takes once it has parsed as valid
       * XML. Cancelled rather than published as a run that "found zero URLs",
       * which would be a claim about the client's site.
       */
      await finishRun(db, scope, run.id, { status: "cancelled" });

      console.log(
        "\nDiscovery found no files. Run cancelled rather than published as an empty site."
      );

      return;
    }

    heading("2. ingest (one streaming pass)");

    const ingested = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id,
      baseUrl: origin,
      expectedHost: host
    });

    console.log(`  files parsed   ${ingested.filesParsed}`);
    console.log(`  files failed   ${ingested.filesFailed}`);
    console.log(`  urls counted   ${ingested.totalUrls}`);
    console.log(`  patterns       ${ingested.patternCount}`);
    console.log(`  samples drawn  ${ingested.samplesDrawn}`);

    const patterns = await listPatternsByPopulation(db, scope, run.id, 50);

    heading(
      "3. patterns extracted (top 50 by population, COUNTED not estimated)"
    );

    for (const row of patterns) {
      console.log(
        `  ${String(row.populationCount).padStart(10)}  ${row.template}`
      );
    }

    /**
     * The planned cost, summed from the jobs rather than guessed.
     *
     * `plannedSampleSize` is what the escalation cap is budgeted against, so
     * this is a FLOOR: an escalated check costs a HEAD plus a GET, and a
     * second sampling round costs more again.
     */
    const plannedProbes = pending.reduce(
      (total, job) => total + Number(job.payload.plannedSampleSize ?? 0),
      0
    );

    heading("4. probe budget");

    console.log(`  patterns to verify   ${pending.length}`);
    console.log(`  planned probes       ${plannedProbes} (a floor)`);
    console.log(
      `  rate ceiling         ${policy.HTTP_PER_HOST_REQUESTS_PER_SECOND} req/s, ${policy.HTTP_PER_HOST_CONCURRENCY} concurrent — IN FORCE`
    );
    console.log(
      `  est. wall clock      ~${Math.ceil(
        plannedProbes / policy.HTTP_PER_HOST_REQUESTS_PER_SECOND
      )}s at that ceiling`
    );
    console.log(
      `  daily caps           NOT ENFORCED (ADR-0030) — this script's guard is ${options.maxRequests}`
    );

    if (!options.probe) {
      await finishRun(db, scope, run.id, { status: "cancelled" });

      console.log(
        [
          "",
          "Plan only — not one page was requested, and the run is cancelled so it",
          "cannot be mistaken for an audit. Patterns and populations above are real.",
          "",
          "To measure, re-run with --probe:",
          `  pnpm live:run --sitemap ${options.sitemapUrl} --probe`
        ].join("\n")
      );

      return;
    }

    if (plannedProbes > options.maxRequests) {
      await finishRun(db, scope, run.id, { status: "cancelled" });

      throw new Error(
        [
          `planned ${plannedProbes} probes, over this script's --max-requests guard of ${options.maxRequests}.`,
          "Run cancelled before sending anything.",
          "Raise the guard deliberately if that much traffic is acceptable at this origin."
        ].join("\n")
      );
    }

    heading("5. verify and estimate");

    let jobsRun = 0;

    /*
     * Drained FIFO through `runStage` — the same dispatch the worker uses, so
     * a stage cannot behave differently here than it would in production.
     */
    for (let job = pending.shift(); job !== undefined; job = pending.shift()) {
      await runStage(job.stage, deps, scope, job.payload);
      jobsRun += 1;

      if (jobsRun % 10 === 0) {
        console.log(`  ${jobsRun} jobs done, ${pending.length} queued`);
      }
    }

    console.log(`  ${jobsRun} stage jobs completed`);

    heading("6. finalize");

    const finalized = await runStage("finalize", deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id
    });

    console.log(JSON.stringify(finalized, null, 2));

    heading("7. what landed in the database");

    const files = await listSitemapFiles(db, scope, run.id);
    const statuses = await countPatternsByStatus(db, scope, run.id);
    const health = await findRunSamplingHealth(db, scope, run.id);
    const findings = await listSnapshotsByImpact(db, scope, {
      sitemapRunId: run.id,
      limit: 10
    });

    console.log(`  sitemap_file rows    ${files.length}`);

    for (const status of statuses) {
      console.log(
        `  patterns ${status.status.padEnd(14)} ${String(status.count).padStart(5)}  (${status.populationCount} urls)`
      );
    }

    if (health !== undefined) {
      console.log(`  http requests        ${health.httpRequests} (a floor)`);
      console.log(`  get escalations      ${health.getEscalations}`);
      console.log(`  patterns expanded    ${health.patternsExpanded}`);
      console.log(`  low confidence       ${health.patternsLowConfidence}`);
    }

    heading("8. top findings by impact");

    if (findings.length === 0) {
      console.log("  none — no pattern produced a publishable claim");
    }

    for (const finding of findings) {
      const point = (Number(finding.pointEstimate) * 100).toFixed(1);
      const low = (Number(finding.ciLow) * 100).toFixed(1);
      const high = (Number(finding.ciHigh) * 100).toFixed(1);

      console.log(
        `  ${finding.severityClass.padEnd(18)}http ${String(finding.httpStatus).padEnd(5)}` +
          `~${point}% [${low}-${high}%] ${finding.confidenceBand.padEnd(12)}${finding.patternTemplate}`
      );
    }

    console.log(
      [
        "",
        "Verify in the UI:",
        `  /runs/${run.id}`,
        `  /sites/${scope.siteId}`,
        `  /sites/${scope.siteId}/patterns`,
        "  /issues",
        "  /projects"
      ].join("\n")
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nlive-run failed:\n${error instanceof Error ? error.message : String(error)}`
  );
  process.exitCode = 1;
});
