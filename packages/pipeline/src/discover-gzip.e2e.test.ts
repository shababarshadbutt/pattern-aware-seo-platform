import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  createOrganization,
  createSite,
  listSitemapFiles,
  type SiteScope,
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
 * THE REPRODUCED BUG, end to end, against a real HTTP server and a real
 * Postgres — not just `sniffGzip`'s own unit tests. `isGzip()` used to trust
 * `content-encoding: gzip` on the response object, but undici's `fetch`
 * already decompresses a gzip body by the time that header is read — so a
 * server that genuinely, correctly compresses its XML (IIS and nginx both do
 * this by default, independent of the URL's extension) left the pipeline
 * believing the STORED bytes were still gzip, and the next stage's `gunzip`
 * failed with `Z_DATA_ERROR: incorrect header check` on a perfectly good
 * sitemap. Recorded in this repo's own `Instructions.txt`/`LIVE_RUN_GUIDE.md`,
 * reproduced against `https://www.sitemaps.org/sitemap.xml`.
 *
 * The server here does nothing dishonest: it really does gzip its response
 * and really does say so in the header. That is precisely the case the old
 * code got wrong.
 */

let harness: TestDatabase;
let server: Server;
let baseUrl = "";
let storeRoot = "";
let scope: SiteScope;

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>PLACEHOLDER/page-1</loc></url><url><loc>PLACEHOLDER/page-2</loc></url></urlset>`;

beforeAll(async () => {
  harness = await createTestDatabase();
  storeRoot = await mkdtemp(join(tmpdir(), "gzip-e2e-"));

  server = createServer((request, response) => {
    if (request.url === "/sitemap.xml") {
      // A URL with no .gz suffix, served genuinely gzip-compressed with an
      // accurate content-encoding header — exactly what IIS/nginx do.
      const body = gzipSync(
        Buffer.from(SITEMAP_XML.replaceAll("PLACEHOLDER", baseUrl), "utf8")
      );

      response.writeHead(200, {
        "content-type": "application/xml",
        "content-encoding": "gzip"
      });
      response.end(body);

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

  const org = await createOrganization(harness.db, {
    name: "Gzip E2E",
    slug: `gzip-e2e-${Date.now()}`
  });

  const site = await createSite(harness.db, org.scope, {
    name: "Gzip Site",
    baseUrl
  });

  scope = site.scope;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  await harness.destroy();
  await rm(storeRoot, { recursive: true, force: true });
});

describe("a genuinely gzip-compressed sitemap on a non-.gz URL", () => {
  it("ingests successfully instead of failing to gunzip already-decompressed bytes", async () => {
    const runId = (await startRun(harness.db, scope, { workerId: "gzip-e2e" }))
      .id;

    const deps: PipelineDeps = {
      db: harness.db,
      store: new LocalDiskFileStore(storeRoot),
      logger: createLogger({
        service: "gzip-e2e",
        level: "silent",
        pretty: false
      }),
      // Real fetch, real undici — the transparent decompression this bug
      // depends on is undici's own behaviour, not something to fake.
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
        // Nothing downstream is driven in this test; discover's own enqueue
        // call is allowed to no-op.
      }
    };

    const discoverResult = await runDiscover(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      sitemapUrl: `${baseUrl}/sitemap.xml`,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    expect(discoverResult.rootElement).toBe("urlset");
    expect(discoverResult.suspiciouslyEmpty).toBe(false);

    const files = await listSitemapFiles(harness.db, scope, runId);

    // The bug wrote `is_gzip: true` here from the header alone; the fix
    // sniffs the bytes actually on disk, which are plain XML.
    expect(files[0]?.isGzip).toBe(false);

    // The real assertion: ingest must not throw Z_DATA_ERROR trying to
    // gunzip an already-decompressed file.
    const ingestResult = await runIngest(deps, scope, {
      siteId: scope.siteId,
      sitemapRunId: runId,
      baseUrl,
      expectedHost: "127.0.0.1"
    });

    expect(ingestResult.filesFailed).toBe(0);
    expect(ingestResult.totalUrls).toBe(2);
  }, 30_000);
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
