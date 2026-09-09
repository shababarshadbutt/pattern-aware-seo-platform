import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOrganization,
  createSite,
  findRunById,
  listSitemapFiles,
  startRun
} from "@pattern-aware/database";
import {
  createTestDatabase,
  type TestDatabase
} from "@pattern-aware/database/testing";
import { createLogger } from "@pattern-aware/shared";
import { LocalDiskFileStore } from "@pattern-aware/sitemap";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PipelineDeps } from "./index.js";
import { runDiscover } from "./stages/discover.js";
import { runIngest } from "./stages/ingest.js";

/**
 * Phase 2A regression coverage.
 *
 * A1: a nested `<sitemapindex>` used to be registered and then parsed as
 * page content, yielding `matchedUrls: 0` and a warning — a silent
 * population undercount at exactly the scale (50-90M URLs, thousands of
 * files) where a single flat index cannot reasonably list every leaf file.
 * This drives `runDiscover` + `runIngest` against a real Postgres and a real
 * local HTTP server across a 3-level nesting chain and asserts the EXACT
 * expected population, not merely "greater than zero".
 *
 * A3: `POPULATION_HARD_LIMIT_FILES` used to be validated config with zero
 * callers. This configures a small limit via `PipelineDeps.oversizeThresholds`
 * and asserts the run stops discovering/parsing further files, leaves them
 * `pending`, and is flagged `degraded` rather than finishing looking clean.
 */

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

function urlset(baseUrl: string, paths: readonly string[]): string {
  const entries = paths
    .map((path) => `<url><loc>${baseUrl}${path}</loc></url>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`;
}

function sitemapIndex(childUrls: readonly string[]): string {
  const entries = childUrls
    .map((url) => `<sitemap><loc>${url}</loc></sitemap>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</sitemapindex>`;
}

async function makeDeps(
  harness: TestDatabase,
  storeRoot: string,
  extra: Partial<PipelineDeps> = {}
): Promise<PipelineDeps> {
  return {
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
    enqueue: async () => {
      // Not exercised by either test below: A1's fixture draws no samples
      // worth asserting on here, and A3's run stops before anything would be
      // enqueued for verification.
    },
    ...extra
  };
}

describe("A1: nested sitemap indexes are flattened, not silently undercounted", () => {
  let harness: TestDatabase;
  let storeRoot: string;
  let server: Server;
  let baseUrl: string;

  const LEAF_ONE = ["/a/1", "/a/2", "/a/3"];
  const LEAF_TWO = ["/b/1", "/b/2"];

  beforeAll(async () => {
    harness = await createTestDatabase();
    storeRoot = await mkdtemp(join(tmpdir(), "pipeline-nested-index-"));

    server = createServer((request, response) => {
      const path = request.url ?? "/";

      const respond = (body: string): void => {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(body);
      };

      switch (path) {
        case "/sitemap.xml": {
          // Level 1: names ONE child, which is ITSELF an index.
          respond(sitemapIndex([`${baseUrl}/index-level-2.xml`]));

          return;
        }
        case "/index-level-2.xml": {
          // Level 2: still an index, not a leaf.
          respond(sitemapIndex([`${baseUrl}/index-level-3.xml`]));

          return;
        }
        case "/index-level-3.xml": {
          // Level 3: the first index that actually names leaves - two of them.
          respond(
            sitemapIndex([`${baseUrl}/leaf-1.xml`, `${baseUrl}/leaf-2.xml`])
          );

          return;
        }
        case "/leaf-1.xml": {
          respond(urlset(baseUrl, LEAF_ONE));

          return;
        }
        case "/leaf-2.xml": {
          respond(urlset(baseUrl, LEAF_TWO));

          return;
        }
        default: {
          response.writeHead(404);
          response.end();
        }
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await harness.destroy();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("counts the exact population behind a 3-level nested index chain", async () => {
    const org = await createOrganization(harness.db, {
      name: "Nested Index Fixtures",
      slug: `nested-index-${Date.now()}`
    });
    const site = await createSite(harness.db, org.scope, {
      name: "Nested Index Site",
      baseUrl
    });
    const scope = site.scope;
    const runId = (await startRun(harness.db, scope, { workerId: "e2e" })).id;

    const deps = await makeDeps(harness, storeRoot);

    const discovered = await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    // Discovery only ever sees the ENTRY document's immediate children - one
    // named child, which will itself turn out to be another index once
    // `ingest` opens it.
    expect(discovered.rootElement).toBe("sitemapindex");
    expect(discovered.fileCount).toBe(1);

    const result = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    // THE EXACT COUNT, not "greater than zero" - this is what the defect
    // silently truncated to 0 for every nested index before the fix.
    expect(result.totalUrls).toBe(LEAF_ONE.length + LEAF_TWO.length);
    expect(result.filesFailed).toBe(0);
    expect(result.allFilesFailed).toBe(false);
    expect(result.oversizeStopReason).toBeUndefined();

    const files = await listSitemapFiles(harness.db, scope, runId);

    // Ordinal 1: index-level-2.xml (skipped, expanded)
    // Ordinal 2: index-level-3.xml (skipped, expanded)
    // Ordinal 3: leaf-1.xml (parsed)
    // Ordinal 4: leaf-2.xml (parsed)
    expect(files.length).toBe(4);

    const byOrdinal = new Map(files.map((file) => [file.fileOrdinal, file]));

    expect(byOrdinal.get(1)?.parseStatus).toBe("skipped");
    expect(byOrdinal.get(1)?.parseError).toContain("NESTED_SITEMAP_INDEX");
    expect(byOrdinal.get(2)?.parseStatus).toBe("skipped");
    expect(byOrdinal.get(2)?.parseError).toContain("NESTED_SITEMAP_INDEX");
    expect(byOrdinal.get(3)?.parseStatus).toBe("parsed");
    expect(byOrdinal.get(3)?.urlCount).toBe(LEAF_ONE.length);
    expect(byOrdinal.get(4)?.parseStatus).toBe("parsed");
    expect(byOrdinal.get(4)?.urlCount).toBe(LEAF_TWO.length);
  }, 60_000);
});

describe("A3: the hard file-count limit actually stops an oversize ingest", () => {
  let harness: TestDatabase;
  let storeRoot: string;
  let server: Server;
  let baseUrl: string;

  const FILE_COUNT = 5;
  const HARD_LIMIT_FILES = 3;

  beforeAll(async () => {
    harness = await createTestDatabase();
    storeRoot = await mkdtemp(join(tmpdir(), "pipeline-oversize-"));

    server = createServer((request, response) => {
      const path = request.url ?? "/";

      if (path === "/sitemap.xml") {
        const children = Array.from(
          { length: FILE_COUNT },
          (_, i) => `${baseUrl}/leaf-${i + 1}.xml`
        );

        response.writeHead(200, { "content-type": "application/xml" });
        response.end(sitemapIndex(children));

        return;
      }

      const leafMatch = /^\/leaf-(\d+)\.xml$/u.exec(path);

      if (leafMatch !== null) {
        response.writeHead(200, { "content-type": "application/xml" });
        response.end(urlset(baseUrl, [`/page-${leafMatch[1]}`]));

        return;
      }

      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;

    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await harness.destroy();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("stops ingestion, flags the run degraded, and leaves the rest pending", async () => {
    const org = await createOrganization(harness.db, {
      name: "Oversize Fixtures",
      slug: `oversize-${Date.now()}`
    });
    const site = await createSite(harness.db, org.scope, {
      name: "Oversize Site",
      baseUrl
    });
    const scope = site.scope;
    const runId = (await startRun(harness.db, scope, { workerId: "e2e" })).id;

    const deps = await makeDeps(harness, storeRoot, {
      oversizeThresholds: {
        softLimitUrls: Number.POSITIVE_INFINITY,
        hardLimitUrls: Number.POSITIVE_INFINITY,
        hardLimitFiles: HARD_LIMIT_FILES
      }
    });

    await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    const discoveredFiles = await listSitemapFiles(harness.db, scope, runId);

    // Discovery itself names all 5 children up front (it only lists URLs, it
    // never downloads them) - the limit bites during `ingest`, once files are
    // actually being processed one at a time.
    expect(discoveredFiles.length).toBe(FILE_COUNT);

    const result = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    expect(result.oversizeStopReason).toBe("OVERSIZE_HARD_LIMIT_FILES");
    // Stopped at the limit, not proceeding to parse every file regardless.
    expect(result.filesParsed).toBeLessThanOrEqual(HARD_LIMIT_FILES);
    expect(result.filesParsed).toBeGreaterThan(0);

    const files = await listSitemapFiles(harness.db, scope, runId);
    const pendingCount = files.filter(
      (file) => file.parseStatus === "pending"
    ).length;

    // At least one file never got touched - the honest signal that discovery
    // found more than this run chose to process.
    expect(pendingCount).toBeGreaterThan(0);

    const run = await findRunById(harness.db, scope, runId);

    expect(run?.status).toBe("degraded");
    expect(run?.statusReason).toBe("OVERSIZE_HARD_LIMIT_FILES");
  }, 60_000);
});
