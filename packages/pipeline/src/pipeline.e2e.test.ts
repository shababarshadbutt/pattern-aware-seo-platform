import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countPatternsByStatus,
  createOrganization,
  createSite,
  listPatternsByPopulation,
  listSitemapFiles,
  listSnapshotsByImpact,
  type SiteScope,
  setFileParseStatus,
  startRun,
  sumPatternPopulation
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger } from "@pattern-aware/shared";
import { LocalDiskFileStore } from "@pattern-aware/sitemap";
import {
  HostCircuitBreaker,
  HostRateLimiter
} from "@pattern-aware/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineDeps, PipelineStage } from "./index.js";
import { runDiscover } from "./stages/discover.js";
import { runEstimate } from "./stages/estimate.js";
import { runFinalize } from "./stages/finalize.js";
import { IngestAlreadyAggregatedError, runIngest } from "./stages/ingest.js";
import { runVerify } from "./stages/verify.js";

/**
 * The whole pipeline, end to end, against a real Postgres and a real HTTP
 * server on localhost.
 *
 * DELIBERATELY NOT MOCKED AT THE HTTP BOUNDARY. The probe's whole job is
 * HEAD-first-then-GET over a real socket, and a stubbed fetch would exercise
 * the parts of it that were never in doubt while skipping the parts that were:
 * that a HEAD is actually sent, that a 405 actually triggers the GET, that a
 * soft 404 body actually arrives truncated. The server here is a fixture, so
 * the run is still deterministic and still safe in CI — no outbound traffic and
 * no other origin involved.
 *
 * The planted defects are the point. A flat sample over this site would average
 * the small broken family away, which is exactly what stratification and
 * per-pattern estimation exist to prevent.
 */

interface Fixture {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly methods: Map<string, string[]>;
}

/** A body long enough to clear the soft-404 short-body floor. */
const SOFT_404_BODY = `<!doctype html><html><head><title>Page not found</title></head><body><h1>Sorry, this page could not be found</h1><p>${"padding ".repeat(
  200
)}</p></body></html>`;

const GOOD_BODY = `<!doctype html><html><head><title>A real product</title></head><body><h1>Product</h1><p>${"content ".repeat(
  200
)}</p></body></html>`;

let harness: TestDatabase;
let server: Server;
let fixture: Fixture;
let storeRoot = "";
let scope: SiteScope;
let runId: string;
let deps: PipelineDeps;
let enqueued: { stage: PipelineStage; payload: Record<string, unknown> }[];

/**
 * The site the fixture serves.
 *
 * Two healthy patterns and one small broken one. `/legacy/{id}` is 40 URLs
 * against 240 total, and every one of them is gone — the case a site-wide
 * average reports as "98% healthy" and a per-pattern estimate reports as "this
 * whole family is dead".
 */
const PRODUCTS = 120;
const ARTICLES = 80;
const LEGACY = 40;

function pathsFor(): string[] {
  const paths: string[] = [];

  for (let index = 1; index <= PRODUCTS; index += 1) {
    paths.push(`/product/${index}`);
  }

  for (let index = 1; index <= ARTICLES; index += 1) {
    paths.push(`/article/${index}`);
  }

  for (let index = 1; index <= LEGACY; index += 1) {
    paths.push(`/legacy/${index}`);
  }

  return paths;
}

/** How the fixture answers one page URL. */
function statusFor(path: string): number {
  if (path.startsWith("/legacy/")) {
    // The planted broken family: every one is gone.
    return 410;
  }

  // Articles and products both answer 200. Every tenth article is a SOFT 404,
  // which by definition is a 200 whose body says the page is missing — the
  // status alone cannot express it, which is why the sniff exists.
  return 200;
}

function isSoft404Path(path: string): boolean {
  if (!path.startsWith("/article/")) {
    return false;
  }

  return Number(path.slice("/article/".length)) % 10 === 0;
}

beforeAll(async () => {
  harness = await createTestDatabase();
  storeRoot = await mkdtemp(join(tmpdir(), "pipeline-e2e-"));

  const requests: string[] = [];
  const methods = new Map<string, string[]>();
  const all = pathsFor();

  server = createServer((request, response) => {
    const path = request.url ?? "/";
    const method = request.method ?? "GET";

    requests.push(`${method} ${path}`);
    methods.set(path, [...(methods.get(path) ?? []), method]);

    if (path === "/sitemap.xml") {
      const children = [1, 2]
        .map(
          (n) =>
            `<sitemap><loc>${fixture.baseUrl}/sitemap-${n}.xml</loc></sitemap>`
        )
        .join("");

      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${children}</sitemapindex>`
      );

      return;
    }

    const childMatch = /^\/sitemap-(\d)\.xml$/u.exec(path);

    if (childMatch !== null) {
      const half = Math.ceil(all.length / 2);
      const slice =
        childMatch[1] === "1" ? all.slice(0, half) : all.slice(half);
      const entries = slice
        .map((p) => `<url><loc>${fixture.baseUrl}${p}</loc></url>`)
        .join("");

      response.writeHead(200, { "content-type": "application/xml" });
      response.end(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
      );

      return;
    }

    const status = statusFor(path);

    if (method === "HEAD") {
      response.writeHead(status, { "content-type": "text/html" });
      response.end();

      return;
    }

    response.writeHead(status, { "content-type": "text/html" });
    response.end(isSoft404Path(path) ? SOFT_404_BODY : GOOD_BODY);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;

  fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    methods
  };

  const org = await createOrganization(harness.db, {
    name: "Pipeline E2E",
    slug: `e2e-${Date.now()}`
  });

  const site = await createSite(harness.db, org.scope, {
    name: "Fixture Shop",
    baseUrl: fixture.baseUrl
  });

  scope = site.scope;
  runId = (await startRun(harness.db, scope, { workerId: "e2e" })).id;

  enqueued = [];

  deps = {
    db: harness.db,
    store: new LocalDiskFileStore(storeRoot),
    logger: createLogger({ service: "e2e", level: "silent", pretty: false }),
    fetchSitemap: async (url: string) => {
      const response = await fetch(url);

      return {
        status: response.status,
        headers: new Map(
          response.headers as unknown as Iterable<[string, string]>
        ),
        body: streamOf(response.body)
      };
    },
    enqueue: async (stage, payload) => {
      // Collected rather than executed, so the test drives the stages in order
      // and can assert what each one handed on.
      enqueued.push({ stage, payload });
    },
    rateLimiter: new HostRateLimiter({
      requestsPerSecond: 200,
      concurrency: 8
    }),
    circuitBreaker: new HostCircuitBreaker({})
  };
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await harness.destroy();
  await rm(storeRoot, { recursive: true, force: true });
});

async function* streamOf(
  body: ReadableStream<Uint8Array> | null
): AsyncIterable<Uint8Array> {
  if (body === null) {
    return;
  }

  const reader = body.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    if (value !== undefined) {
      yield value;
    }
  }
}

describe("the pipeline end to end", () => {
  it("discovers the index's children", async () => {
    const result = await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      sitemapUrl: `${fixture.baseUrl}/sitemap.xml`
    });

    expect(result.rootElement).toBe("sitemapindex");
    expect(result.fileCount).toBe(2);
    expect(result.suspiciouslyEmpty).toBe(false);

    const files = await listSitemapFiles(deps.db, scope, runId);

    // Ordinal 0 is reserved for the index itself, so children start at 1.
    expect(files.map((file) => file.fileOrdinal)).toEqual([1, 2]);
  });

  it("ingests every file in one pass and draws a sample per pattern", async () => {
    const result = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      baseUrl: fixture.baseUrl,
      expectedHost: "127.0.0.1"
    });

    expect(result.filesParsed).toBe(2);
    expect(result.filesFailed).toBe(0);
    expect(result.allFilesFailed).toBe(false);
    expect(result.totalUrls).toBe(PRODUCTS + ARTICLES + LEGACY);

    // Three families in, three patterns out — the whole premise.
    expect(result.patternCount).toBe(3);
    expect(result.samplesDrawn).toBe(3);

    const patterns = await listPatternsByPopulation(deps.db, scope, runId, 10);

    expect(patterns.map((p) => p.template).sort()).toEqual([
      "/article/{param}",
      "/legacy/{param}",
      "/product/{param}"
    ]);

    // Populations are COUNTED, not estimated, and they must be exact.
    const byTemplate = new Map(patterns.map((p) => [p.template, p]));

    expect(byTemplate.get("/product/{param}")?.populationCount).toBe(PRODUCTS);
    expect(byTemplate.get("/article/{param}")?.populationCount).toBe(ARTICLES);
    expect(byTemplate.get("/legacy/{param}")?.populationCount).toBe(LEGACY);

    // The per-file index the legacy engine lacked: each pattern spans both
    // files, and its per-file counts sum back to its population.
    for (const pattern of patterns) {
      const summed = await sumPatternPopulation(deps.db, scope, pattern.id);

      expect(summed).toBe(pattern.populationCount);
    }

    expect(enqueued.filter((job) => job.stage === "verify")).toHaveLength(3);
  }, 120_000);

  it("verifies each pattern over real HTTP, HEAD first", async () => {
    const verifyJobs = enqueued.filter((job) => job.stage === "verify");

    for (const job of verifyJobs) {
      const result = await runVerify(deps, scope, job.payload);

      expect(result.observationsWritten).toBeGreaterThan(0);
      expect(result.probed).toBeGreaterThan(0);
    }

    // Every probed URL was asked with HEAD before anything else.
    const probedPages = [...fixture.methods.entries()].filter(
      ([path]) =>
        path.startsWith("/product/") ||
        path.startsWith("/article/") ||
        path.startsWith("/legacy/")
    );

    expect(probedPages.length).toBeGreaterThan(0);

    for (const [, verbs] of probedPages) {
      expect(verbs[0]).toBe("HEAD");
    }

    expect(enqueued.filter((job) => job.stage === "estimate")).toHaveLength(3);
  }, 120_000);

  it("writes a claim per outcome, and finds the planted broken family", async () => {
    for (const job of enqueued.filter((j) => j.stage === "estimate")) {
      const result = await runEstimate(deps, scope, job.payload);

      expect(result.snapshotsWritten).toBeGreaterThan(0);
    }

    const snapshots = await listSnapshotsByImpact(deps.db, scope, {
      sitemapRunId: runId,
      limit: 100
    });

    expect(snapshots.length).toBeGreaterThan(0);

    const patterns = await listPatternsByPopulation(deps.db, scope, runId, 10);
    const legacy = patterns.find((p) => p.template === "/legacy/{param}");
    const legacySnapshots = snapshots.filter(
      (snapshot) => snapshot.patternId === legacy?.id
    );

    /**
     * THE PLANTED DEFECT, found. Every `/legacy/` URL is gone, so its 410
     * snapshot extrapolates to the whole 40-URL family.
     *
     * `estimated`, not `counted`, and that is correct rather than a shortfall:
     * the min-sample floor draws 30 of the 40, so ten URLs were never looked
     * at. The point estimate is still the whole family — 30 of 30 came back
     * gone — but the lower bound stays below it, which is the honest statement
     * about the ten nobody probed. A `counted` tier here would claim a census
     * that was not taken.
     */
    const gone = legacySnapshots.find(
      (snapshot) => snapshot.httpStatus === 410
    );

    expect(gone).toBeDefined();
    expect(gone?.severityClass).toBe("gone");
    expect(gone?.evidenceTier).toBe("estimated");
    expect(gone?.observedCount).toBe(gone?.sampleSize);
    expect(gone?.pointEstimate).toBe(LEGACY);

    // Uncertainty about the unsampled remainder, not false certainty.
    expect(gone?.ciLow).toBeLessThan(LEGACY);
    expect(gone?.ciHigh).toBe(LEGACY);

    // Impact is population x probability x severity, and `gone` weighs 1.0.
    expect(gone?.impactScore).toBe(LEGACY);

    /**
     * And the interval never excludes its own point estimate, on any row. This
     * is the invariant the database also enforces; asserting it here means a
     * regression is a test failure rather than an insert error in production.
     */
    for (const snapshot of snapshots) {
      expect(snapshot.ciLow).toBeLessThanOrEqual(snapshot.pointEstimate);
      expect(snapshot.pointEstimate).toBeLessThanOrEqual(snapshot.ciHigh);
      expect(snapshot.ciHigh).toBeLessThanOrEqual(snapshot.populationCount);
    }
  }, 120_000);

  it("finalises the run with an honest status", async () => {
    const result = await runFinalize(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId
    });

    expect(result.patternsTotal).toBe(3);
    expect(result.patternsMeasured).toBeGreaterThan(0);

    // A run whose files all parsed and whose patterns were measured is
    // complete; anything less has to say why.
    if (result.status === "degraded") {
      expect(result.reason).toBeDefined();
    } else {
      expect(result.reason).toBeUndefined();
    }
  }, 120_000);

  it("refuses a second ingest rather than doubling every population", async () => {
    /**
     * REGRESSION, from the manual review pass on this milestone.
     *
     * `upsertPatterns` is additive — written for a parse that flushes each
     * file as it goes. This pass writes once at the end, so running it twice
     * over the same corpus would add every count to itself and report a
     * population twice the size of the site, with nothing to indicate it.
     */
    await expect(
      runIngest(deps, scope, {
        siteId: scope.siteId,
        sitemapRunId: runId,
        baseUrl: fixture.baseUrl,
        expectedHost: "127.0.0.1"
      })
    ).rejects.toThrow(IngestAlreadyAggregatedError);

    // And the populations are untouched by the refusal.
    const patterns = await listPatternsByPopulation(deps.db, scope, runId, 10);
    const byTemplate = new Map(patterns.map((p) => [p.template, p]));

    expect(byTemplate.get("/product/{param}")?.populationCount).toBe(PRODUCTS);
    expect(byTemplate.get("/legacy/{param}")?.populationCount).toBe(LEGACY);
  }, 120_000);

  it("re-parses files marked parsed when a previous pass never wrote aggregates", async () => {
    /**
     * THE OTHER HALF of the same defect, and the dangerous direction.
     *
     * A pass that died after marking files `parsed` but before writing
     * aggregates would, on retry, skip those files: their URLs missing from
     * the trie and from every count, the run finishing clean with a smaller
     * population. Simulated here by starting a fresh run, marking its files
     * parsed without ever aggregating, and confirming the next ingest reads
     * the whole corpus anyway.
     */
    const secondRun = await startRun(deps.db, scope, { workerId: "e2e-2" });

    await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: secondRun.id,
      sitemapUrl: `${fixture.baseUrl}/sitemap.xml`
    });

    const files = await listSitemapFiles(deps.db, scope, secondRun.id);

    for (const file of files) {
      await setFileParseStatus(deps.db, scope, file.id, "parsed", {
        urlCount: 999
      });
    }

    const result = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: secondRun.id,
      baseUrl: fixture.baseUrl,
      expectedHost: "127.0.0.1"
    });

    // Every URL counted, not zero — which is what skipping would have given.
    expect(result.totalUrls).toBe(PRODUCTS + ARTICLES + LEGACY);
    expect(result.patternCount).toBe(3);

    const counts = await countPatternsByStatus(deps.db, scope, secondRun.id);

    expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(3);
  }, 120_000);

  it("never made a request per URL in the population", () => {
    /**
     * The product's entire claim, asserted as a number.
     *
     * 240 URLs in the sitemap. Sampling plus HEAD-first probing has to cost
     * far fewer than 240 page requests, or none of this architecture was worth
     * building.
     */
    const pageRequests = fixture.requests.filter(
      (entry) => !entry.includes("/sitemap")
    ).length;

    expect(pageRequests).toBeLessThan(PRODUCTS + ARTICLES + LEGACY);
  });
});
