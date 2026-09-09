import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import {
  countPatternsByStatus,
  createDatabase,
  createOrganization,
  createSite,
  findRunSamplingHealth,
  listPatternsByPopulation,
  listSitemapFiles,
  startRun
} from "@pattern-aware/database";
import {
  type PipelineDeps,
  type PipelineStage,
  runDiscover,
  runIngest,
  runStage
} from "@pattern-aware/pipeline";
import {
  DEFAULT_SAMPLE_BUDGET,
  type SampleBudget
} from "@pattern-aware/sampling";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import {
  DEFAULT_OVERSIZE_THRESHOLDS,
  generateSyntheticCorpus,
  LocalDiskFileStore,
  type OversizeThresholds
} from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import pg from "pg";

/**
 * Phase 2A scale-certification harness — MODE "direct" only.
 *
 * The only benchmark that existed before this (`packages/sitemap`'s
 * `scale.bench.test.ts`) measures the SAX-parse-and-trie pass in isolation:
 * no Postgres, no HTTP, no verification, no BullMQ. This drives the real
 * stage functions (`runDiscover` -> `runIngest` -> `runVerify`/`runEstimate`
 * via `runStage` -> `runFinalize`) against a REAL local Postgres and a real
 * local HTTP server serving a generated synthetic corpus — the same
 * production-shaped driving `scripts/live-run.ts` uses for a real site,
 * pointed at a corpus this machine controls instead of somebody else's
 * server, with the whole run instrumented for memory, CPU, disk and Postgres
 * footprint.
 *
 * NOT BUILT THIS ROUND: a "queued" mode driving the same corpus through real
 * BullMQ/Redis (`apps/worker`'s actual `SitePipeline` wiring) to capture
 * queue depth, failed-job counts and Redis memory. That is scoped as a
 * fast-follow, not silently dropped — see the Phase 2A plan. Every number
 * this script prints is a measurement of the pipeline's own stage functions
 * plus Postgres; nothing here exercises Redis or BullMQ.
 *
 * Usage:
 *   pnpm benchmark:scale --urls 1000000
 *   pnpm benchmark:scale --urls 25000000 --urls-per-file 50000
 */

interface Options {
  readonly totalUrls: number;
  readonly urlsPerFile: number;
  readonly seed: number;
  readonly gzipRatio: number;
}

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);

  return index === -1 ? undefined : argv[index + 1];
}

function parseOptions(): Options {
  return {
    totalUrls: Number(flag("urls") ?? 1_000_000),
    urlsPerFile: Number(flag("urls-per-file") ?? 50_000),
    seed: Number(flag("seed") ?? 1),
    gzipRatio: Number(flag("gzip-ratio") ?? 0.25)
  };
}

function heading(text: string): void {
  console.log(`\n${text}\n${"=".repeat(text.length)}`);
}

function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatMs(ms: number): string {
  if (ms < 1_000) {
    return `${ms.toFixed(0)} ms`;
  }

  return `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * Peak RSS across the whole run, sampled periodically.
 *
 * `process.memoryUsage().rss` only reports the CURRENT resident set; Node
 * exposes no "high water mark" of its own, so the only way to observe a peak
 * (rather than whatever RSS happens to be at the one moment you looked) is to
 * poll it continuously and keep the maximum, exactly the technique
 * `scale.bench.test.ts` relies on implicitly by checking RSS right after the
 * heaviest allocation. A run against real Postgres and real HTTP has more
 * moving parts than a pure in-process parse, so this polls throughout rather
 * than at one checkpoint.
 */
class PeakRssTracker {
  #peak = 0;
  #timer: ReturnType<typeof setInterval> | undefined;

  public start(intervalMs = 250): void {
    this.#sample();
    this.#timer = setInterval(() => this.#sample(), intervalMs);
    this.#timer.unref();
  }

  public stop(): number {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
    }

    this.#sample();

    return this.#peak;
  }

  #sample(): void {
    this.#peak = Math.max(this.#peak, process.memoryUsage().rss);
  }
}

/** Total bytes under a directory, recursively. Used for on-disk footprint. */
async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        try {
          total += (await stat(path)).size;
        } catch {
          // File removed mid-walk; not worth failing a benchmark over.
        }
      }
    }
  }

  await walk(root);

  return total;
}

/** Bytes of relations for one site's partitions across the platform's 6 partitioned tables. */
async function measurePostgresFootprint(
  connectionString: string,
  siteId: string
): Promise<{
  readonly totalBytes: number;
  readonly rowsByTable: Record<string, number>;
}> {
  const client = new pg.Client({ connectionString });

  await client.connect();

  try {
    /**
     * A raw, read-only diagnostic connection — deliberately NOT going through
     * `@pattern-aware/database`'s opaque `Database` type. That type exists to
     * make an unscoped TENANT QUERY a compile error in application code; this
     * is neither application code nor a tenant query, it is an operator
     * reading `pg_catalog` sizes the way `psql`'s `\dt+` would, for a
     * benchmark report. See ADR references in docs/decisions.md on why the
     * opaque type's one sanctioned exception (`packages/database/testing`) is
     * for a migrated-pool test harness, not for scripts — this avoids that
     * subpath entirely rather than borrowing it for something it was not
     * scoped for.
     */
    // Matches `partitionName()` in packages/database/src/partitions.ts
    // exactly: `${table}_p_${siteId with hyphens stripped}`.
    const partitionNamePattern = `%_p_${siteId.replaceAll("-", "")}`;

    const sizeResult = await client.query<{ total_bytes: string }>(
      `select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as total_bytes
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like $1`,
      [partitionNamePattern]
    );

    const rowsResult = await client.query<{
      table_name: string;
      row_count: string;
    }>(
      `select
         regexp_replace(c.relname, '_p_[0-9a-f]+$', '') as table_name,
         coalesce(sum(s.n_live_tup), 0)::bigint as row_count
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_stat_user_tables s on s.relid = c.oid
       where n.nspname = 'public' and c.relname like $1
       group by table_name`,
      [partitionNamePattern]
    );

    const rowsByTable: Record<string, number> = {};

    for (const row of rowsResult.rows) {
      rowsByTable[row.table_name] = Number(row.row_count);
    }

    return {
      totalBytes: Number(sizeResult.rows[0]?.total_bytes ?? 0),
      rowsByTable
    };
  } finally {
    await client.end();
  }
}

/** Serves a generated synthetic corpus, plus a synthetic 200 for every page-verification request. */
function startCorpusServer(corpusDir: string): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly requestCount: () => number;
}> {
  return new Promise((resolve) => {
    let requests = 0;

    const server = createServer((request, response) => {
      requests += 1;

      const path = (request.url ?? "/").split("?")[0] ?? "/";

      // Anything shaped like a generated sitemap file is served from disk;
      // everything else is a page-verification request (HEAD-first, GET on
      // suspicion) answered with a cheap synthetic 200.
      if (/^\/sitemap(-index)?[^/]*\.xml(\.gz)?$/u.test(path)) {
        const filePath = join(corpusDir, path.slice(1));
        const isGzip = path.endsWith(".gz");

        response.writeHead(200, {
          "content-type": "application/xml",
          ...(isGzip ? { "content-encoding": "identity" } : {})
        });

        import("node:fs")
          .then(({ createReadStream }) => {
            createReadStream(filePath).pipe(response);
          })
          .catch(() => {
            response.writeHead(500);
            response.end();
          });

        return;
      }

      if (request.method === "HEAD") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end();

        return;
      }

      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<!doctype html><html><body><h1>ok</h1><p>${"synthetic ".repeat(20)}</p></body></html>`
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;

      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestCount: () => requests
      });
    });
  });
}

async function main(): Promise<void> {
  const options = parseOptions();
  const connectionString = process.env.DATABASE_URL;

  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env");
  }

  const policy = loadPolicyConfig();
  const { db, close } = createDatabase({ connectionString });

  const logger = createLogger({
    service: "benchmark-scale",
    level: "warn",
    pretty: true
  });

  const corpusDir = await mkdtemp(join(tmpdir(), "psp-scale-bench-corpus-"));
  const storeRoot = await mkdtemp(join(tmpdir(), "psp-scale-bench-store-"));

  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    urls: options.totalUrls,
    urlsPerFile: options.urlsPerFile
  };

  try {
    heading(
      `0. generating synthetic corpus (${options.totalUrls.toLocaleString()} URLs)`
    );

    const genStart = performance.now();

    const generated = generateSyntheticCorpus({
      outDir: corpusDir,
      totalUrls: options.totalUrls,
      urlsPerFile: options.urlsPerFile,
      seed: options.seed,
      gzipRatio: options.gzipRatio,
      baseUrl: "http://placeholder.invalid" // rewritten below once the port is known
    });

    console.log(
      `  generated ${generated.files} files, ${generated.urls.toLocaleString()} urls in ${formatMs(performance.now() - genStart)}`
    );

    // The generator bakes `baseUrl` into every <loc>, but the local server's
    // port is only known after it starts — so the corpus is regenerated once
    // the real base URL is known. Cheap relative to a 25M-URL parse.
    const { server, baseUrl, requestCount } =
      await startCorpusServer(corpusDir);

    generateSyntheticCorpus({
      outDir: corpusDir,
      totalUrls: options.totalUrls,
      urlsPerFile: options.urlsPerFile,
      seed: options.seed,
      gzipRatio: options.gzipRatio,
      baseUrl
    });

    const org = await createOrganization(db, {
      name: `Scale Benchmark ${Date.now()}`,
      slug: `scale-benchmark-${Date.now()}`
    });

    const site = await createSite(db, org.scope, {
      name: "Scale Benchmark Site",
      baseUrl
    });

    const scope = site.scope;

    const sampleBudget: SampleBudget = {
      sampleRate: DEFAULT_SAMPLE_BUDGET.sampleRate,
      minSample: policy.SAMPLE_MIN_SIZE,
      maxFirstRound: policy.SAMPLE_MAX_FIRST_ROUND,
      maxExpanded: policy.SAMPLE_MAX_EXPANDED,
      maxExpansionFactor: policy.SAMPLE_MAX_EXPANSION_FACTOR,
      maxPopulationFraction: policy.SAMPLE_MAX_POPULATION_FRACTION,
      minPerStratum: policy.SAMPLE_MIN_PER_STRATUM
    };

    // Same composition `apps/worker/src/index.ts` builds — Phase 2A wires
    // only the file-count hard limit; URL-based limits stay at Infinity.
    const oversizeThresholds: OversizeThresholds = {
      ...DEFAULT_OVERSIZE_THRESHOLDS,
      hardLimitFiles: policy.POPULATION_HARD_LIMIT_FILES
    };

    const pending: {
      stage: PipelineStage;
      payload: Record<string, unknown>;
    }[] = [];

    const deps: PipelineDeps = {
      db,
      store: new LocalDiskFileStore(storeRoot),
      logger,
      rateLimiter: new HostRateLimiter({
        requestsPerSecond: policy.HTTP_PER_HOST_REQUESTS_PER_SECOND,
        concurrency: policy.HTTP_PER_HOST_CONCURRENCY
      }),
      circuitBreaker: new HostCircuitBreaker({
        openAfter429: policy.HTTP_CIRCUIT_BREAK_AFTER_429,
        openAfter403: policy.HTTP_CIRCUIT_BREAK_AFTER_403,
        cooldownMs: policy.HTTP_CIRCUIT_COOLDOWN_MS
      }),
      sampleBudget,
      oversizeThresholds,
      enqueue: async (stage, payload) => {
        pending.push({ stage, payload });
      },
      fetchSitemap: async (url: string) => {
        const response = await fetch(url);

        return {
          status: response.status,
          headers: new Map(
            response.headers as unknown as Iterable<[string, string]>
          ),
          body:
            response.body === null
              ? (async function* () {})()
              : (async function* (): AsyncIterable<Uint8Array> {
                  const reader = (
                    response.body as ReadableStream<Uint8Array>
                  ).getReader();

                  for (;;) {
                    const { done, value } = await reader.read();

                    if (done) {
                      return;
                    }

                    if (value !== undefined) {
                      yield value;
                    }
                  }
                })()
        };
      }
    };

    const run = await startRun(db, scope, {
      workerId: "benchmark-scale",
      isDryRun: false
    });

    console.log(`  site ${scope.siteId}, run ${run.id}, server ${baseUrl}`);

    const rss = new PeakRssTracker();

    rss.start();

    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const timings: Record<string, number> = {};

    heading("1. discover");

    const discoverStart = performance.now();

    const discovered = await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id,
      sitemapUrl: `${baseUrl}/sitemap-index.xml`,
      baseUrl,
      expectedHost: new URL(baseUrl).hostname
    });

    timings.discoverMs = performance.now() - discoverStart;
    console.log(
      `  root=${discovered.rootElement} files=${discovered.fileCount} in ${formatMs(timings.discoverMs)}`
    );

    heading("2. ingest (one streaming pass)");

    const ingestStart = performance.now();

    const ingested = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id,
      baseUrl,
      expectedHost: new URL(baseUrl).hostname
    });

    timings.ingestMs = performance.now() - ingestStart;

    const ingestPeakRssBytes = process.memoryUsage().rss;
    const diskPeakBytes = await directorySizeBytes(storeRoot);

    console.log(`  files parsed     ${ingested.filesParsed}`);
    console.log(`  files failed     ${ingested.filesFailed}`);
    console.log(`  urls counted     ${ingested.totalUrls}`);
    console.log(`  patterns         ${ingested.patternCount}`);
    console.log(`  samples drawn    ${ingested.samplesDrawn}`);
    console.log(
      `  oversize stop    ${ingested.oversizeStopReason ?? "(none)"}`
    );
    console.log(`  duration         ${formatMs(timings.ingestMs)}`);
    console.log(
      `  throughput       ${(ingested.totalUrls / (timings.ingestMs / 1_000)).toFixed(0)} urls/s`
    );
    console.log(`  RSS at this point ${formatMb(ingestPeakRssBytes)}`);
    console.log(`  disk (store root) ${formatMb(diskPeakBytes)}`);

    heading("3. verify + estimate (draining the drawn samples)");

    /**
     * `runDiscover` unconditionally enqueues its own "ingest" follow-on job
     * (that is the real `discover -> ingest` hand-off `pipeline.e2e.test.ts`
     * asserts on) — but this script already ran `runIngest` manually above,
     * exactly the way BullMQ normally would from that same enqueue. Draining
     * `pending` FIFO without filtering would re-run that stale "ingest" job
     * and hit `IngestAlreadyAggregatedError` on the very first iteration
     * (confirmed while writing this). Only "verify"/"estimate"/"finalize"
     * are drained here; "discover"/"ingest" entries are stage hand-offs this
     * script already performed by calling the function directly.
     */
    const verifyStart = performance.now();
    let jobsRun = 0;
    let skipped = 0;

    for (let job = pending.shift(); job !== undefined; job = pending.shift()) {
      if (job.stage === "discover" || job.stage === "ingest") {
        skipped += 1;

        continue;
      }

      await runStage(job.stage, deps, scope, job.payload);
      jobsRun += 1;

      if (jobsRun % 25 === 0) {
        console.log(`  ${jobsRun} jobs done, ${pending.length} queued`);
      }
    }

    if (skipped > 0) {
      console.log(
        `  (skipped ${skipped} discover/ingest hand-off job(s) already run directly above)`
      );
    }

    timings.verifyEstimateMs = performance.now() - verifyStart;
    console.log(
      `  ${jobsRun} stage jobs completed in ${formatMs(timings.verifyEstimateMs)}`
    );

    heading("4. finalize");

    const finalizeStart = performance.now();

    const finalized = await runStage("finalize", deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: run.id
    });

    timings.finalizeMs = performance.now() - finalizeStart;
    console.log(JSON.stringify(finalized, null, 2));

    const totalWallMs = performance.now() - wallStart;
    const peakRssBytes = rss.stop();
    const cpuUsage = process.cpuUsage(cpuStart);
    const finalDiskBytes = await directorySizeBytes(storeRoot);

    heading("5. what landed in the database");

    const files = await listSitemapFiles(db, scope, run.id);
    const statuses = await countPatternsByStatus(db, scope, run.id);
    const health = await findRunSamplingHealth(db, scope, run.id);
    const patterns = await listPatternsByPopulation(db, scope, run.id, 10);

    console.log(`  sitemap_file rows    ${files.length}`);

    for (const status of statuses) {
      console.log(
        `  patterns ${status.status.padEnd(14)} ${String(status.count).padStart(6)} (${status.populationCount} urls)`
      );
    }

    if (health !== undefined) {
      console.log(`  http requests (floor) ${health.httpRequests}`);
      console.log(`  get escalations       ${health.getEscalations}`);
      console.log(`  patterns expanded     ${health.patternsExpanded}`);
    }

    heading("6. postgres footprint for this site's partitions");

    const pgFootprint = await measurePostgresFootprint(
      connectionString,
      scope.siteId
    );

    console.log(`  total relation size  ${formatMb(pgFootprint.totalBytes)}`);

    for (const [table, rows] of Object.entries(pgFootprint.rowsByTable)) {
      console.log(`  ${table.padEnd(24)} ${rows.toLocaleString()} rows`);
    }

    heading("SUMMARY");

    console.log(
      `  urls requested        ${options.totalUrls.toLocaleString()}`
    );
    console.log(
      `  urls counted          ${ingested.totalUrls.toLocaleString()}`
    );
    console.log(`  wall clock (total)    ${formatMs(totalWallMs)}`);
    console.log(`    discover            ${formatMs(timings.discoverMs)}`);
    console.log(`    ingest              ${formatMs(timings.ingestMs)}`);
    console.log(
      `    verify+estimate     ${formatMs(timings.verifyEstimateMs)}`
    );
    console.log(`    finalize            ${formatMs(timings.finalizeMs)}`);
    console.log(
      `  ingest throughput     ${(ingested.totalUrls / (timings.ingestMs / 1_000)).toFixed(0)} urls/s`
    );
    console.log(`  peak RSS (whole run)  ${formatMb(peakRssBytes)}`);
    console.log(`  RSS right after ingest ${formatMb(ingestPeakRssBytes)}`);
    console.log(
      `  CPU time (user+sys)   ${formatMs((cpuUsage.user + cpuUsage.system) / 1_000)}`
    );
    console.log(`  disk peak (post-ingest) ${formatMb(diskPeakBytes)}`);
    console.log(`  disk final (post-run) ${formatMb(finalDiskBytes)}`);
    console.log(`  postgres total size   ${formatMb(pgFootprint.totalBytes)}`);
    console.log(`  pattern count         ${ingested.patternCount}`);
    console.log(`  samples drawn         ${ingested.samplesDrawn}`);
    console.log(
      `  http requests served  ${requestCount()} (sitemap fetches + verification checks, from the local server's own counter)`
    );

    Object.assign(report, {
      completedAt: new Date().toISOString(),
      urlsCounted: ingested.totalUrls,
      filesParsed: ingested.filesParsed,
      filesFailed: ingested.filesFailed,
      oversizeStopReason: ingested.oversizeStopReason ?? null,
      patternCount: ingested.patternCount,
      samplesDrawn: ingested.samplesDrawn,
      timingsMs: timings,
      totalWallMs,
      ingestThroughputUrlsPerSec:
        ingested.totalUrls / (timings.ingestMs / 1_000),
      peakRssBytes,
      ingestPeakRssBytes,
      cpuUserMicros: cpuUsage.user,
      cpuSystemMicros: cpuUsage.system,
      diskPeakBytes,
      finalDiskBytes,
      postgres: pgFootprint,
      httpRequestsServed: requestCount(),
      samplingHealth: health ?? null,
      patternStatusCounts: statuses,
      topPatterns: patterns.map((p) => ({
        template: p.template,
        populationCount: p.populationCount
      }))
    });

    // `import.meta.url`'s directory is already `scripts/`, so the repo root
    // is one `..` up from there, not from `dirname()` of it (that bug wrote
    // the first two real reports one level above the repo entirely).
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const reportDir = join(scriptsDir, "..", "docs", "benchmarks");

    mkdirSync(reportDir, { recursive: true });

    const reportPath = join(
      reportDir,
      `${new Date().toISOString().slice(0, 10)}-${options.totalUrls}-urls-scale.json`
    );

    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\nReport written to ${reportPath}`);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  } finally {
    await close();
    await rm(corpusDir, { recursive: true, force: true });
    await rm(storeRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nbenchmark-scale failed:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`
  );
  process.exitCode = 1;
});
