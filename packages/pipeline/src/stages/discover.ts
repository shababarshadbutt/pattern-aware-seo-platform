import { Readable } from "node:stream";

import {
  finishRun,
  markFileDownloaded,
  type SiteScope,
  upsertSitemapFiles
} from "@pattern-aware/database";
import { streamLocs } from "@pattern-aware/sitemap";

import {
  assertScopeMatchesPayload,
  type PipelineDeps,
  type SitemapResponse
} from "../deps.js";
import { sniffGzip } from "../gzip-sniff.js";
import {
  type DiscoverPayload,
  discoverPayloadSchema,
  parsePayload
} from "../payloads.js";

/**
 * Stage 1: find out what files this site's sitemap actually consists of.
 *
 * Cheap and load-bearing. Everything after this works from the file list, so a
 * discovery that quietly finds nothing produces a run that completes with a
 * population of zero and no indication anything went wrong — which is
 * indistinguishable from a site that genuinely lists nothing. Both empty
 * outcomes below are therefore signalled explicitly.
 */

/** The entry document is stored under this file id; children start at 1. */
export const ENTRY_FILE_ID = 0;

export interface DiscoverResult {
  readonly rootElement: "urlset" | "sitemapindex";
  readonly fileCount: number;
  /** True when an accepted document yielded no usable files at all. */
  readonly suspiciouslyEmpty: boolean;
}

/** Raised when the sitemap URL does not answer with a usable document. */
export class SitemapUnavailableError extends Error {
  public override readonly name = "SitemapUnavailableError";
}

export async function runDiscover(
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<DiscoverResult> {
  const payload: DiscoverPayload = parsePayload(
    discoverPayloadSchema,
    "discover",
    data
  );

  assertScopeMatchesPayload(scope, payload, "discover");

  const response = await deps.fetchSitemap(payload.sitemapUrl);

  assertUsableResponse(response, payload.sitemapUrl);

  /**
   * Stored before it is parsed, not after.
   *
   * The entry document is parsed twice when it turns out to be an index — once
   * to learn which kind of document it is, once to read its children — and
   * re-fetching for the second pass would double the request and risk reading a
   * different document than the first pass saw. Storing first makes both passes
   * read identical bytes.
   */
  const stored = await deps.store.put(
    { runId: payload.sitemapRunId, fileId: ENTRY_FILE_ID },
    Readable.from(response.body)
  );

  /**
   * Sniffed from the bytes just written, NOT from `content-encoding`.
   *
   * Undici's `fetch` already decompressed `response.body` by the time it
   * reached `deps.store.put` above, but leaves the header saying "gzip" — so
   * trusting it here would mark an already-plain file as gzip and fail the
   * next stage's gunzip with `Z_DATA_ERROR`. The magic number on disk cannot
   * lie about what is actually stored, regardless of the URL's suffix or what
   * the server claimed while sending it. Used for every read of the entry
   * document below, and for the single-file case's own `is_gzip` column.
   */
  const entryIsGzip = await sniffGzip(
    await deps.store.open({
      runId: payload.sitemapRunId,
      fileId: ENTRY_FILE_ID
    })
  );

  const rootElement = await detectRootElement(deps, payload, entryIsGzip);

  if (rootElement === "urlset") {
    /**
     * A single-file sitemap. The entry document IS the file, so it is
     * registered as one — already downloaded, since it is sitting in the store.
     */
    const [file] = await upsertSitemapFiles(
      deps.db,
      scope,
      payload.sitemapRunId,
      [
        {
          url: payload.sitemapUrl,
          // The entry document IS the file here, and its bytes are already stored
          // under ordinal 0.
          fileOrdinal: ENTRY_FILE_ID,
          isGzip: entryIsGzip
        }
      ]
    );

    if (file !== undefined) {
      await markFileDownloaded(deps.db, scope, file.id, {
        storageKey: stored.storageKey,
        contentDigest: stored.digest,
        byteSize: stored.bytes
      });
    }

    deps.logger.info(
      {
        sitemapRunId: payload.sitemapRunId,
        rootElement,
        fileCount: 1,
        bytes: stored.bytes
      },
      "discovered a single-file sitemap"
    );

    await deps.enqueue("ingest", {
      siteId: payload.siteId,
      sitemapRunId: payload.sitemapRunId,
      baseUrl: payload.baseUrl,
      expectedHost: payload.expectedHost
    });

    return { rootElement, fileCount: 1, suspiciouslyEmpty: false };
  }

  const children = await readIndexChildren(deps, payload, entryIsGzip);

  if (children.length === 0) {
    /**
     * AN ACCEPTED INDEX WITH NO CHILDREN, which is not the same as an error and
     * not the same as a small site. It is what a CDN error page dressed as XML
     * looks like once it has parsed successfully, and what a generator that
     * wrote its index before its files looks like. Either way the run would
     * otherwise report zero URLs as a fact about the client's site.
     *
     * CANCELLED HERE, not left for a caller to notice. Moving this decision
     * into the stage itself (rather than a script driving it manually) is
     * what makes the queue-driven path and a manual run behave identically —
     * one code path, not two that can drift.
     */
    deps.logger.warn(
      {
        sitemapRunId: payload.sitemapRunId,
        sitemapUrl: payload.sitemapUrl,
        rootElement,
        bytes: stored.bytes,
        contentDigest: stored.digest
      },
      "sitemap index parsed successfully but names no child sitemaps — treating as suspicious, not as an empty site"
    );

    await finishRun(deps.db, scope, payload.sitemapRunId, {
      status: "degraded",
      statusReason: "SUSPICIOUSLY_EMPTY_INDEX"
    });

    return { rootElement, fileCount: 0, suspiciouslyEmpty: true };
  }

  const files = await upsertSitemapFiles(
    deps.db,
    scope,
    payload.sitemapRunId,
    /**
     * Children start at 1: ordinal 0 belongs to the index itself, whose bytes
     * are stored but which holds no page URLs and is therefore not a file here.
     * Keeping 0 reserved means a child can never collide with the entry
     * document in the store.
     *
     * `is_gzip` here is still a SUFFIX GUESS — a child is only a named URL
     * until `ingest` downloads it, so there are no bytes to sniff yet. `ingest`
     * corrects this the same way, from the bytes it actually writes, before
     * parsing; see `ingestOneFile`.
     */
    children.map((url, position) => ({
      url,
      fileOrdinal: position + 1,
      isGzip: url.endsWith(".gz")
    }))
  );

  deps.logger.info(
    {
      sitemapRunId: payload.sitemapRunId,
      rootElement,
      fileCount: files.length,
      namedByIndex: children.length
    },
    "discovered sitemap index children"
  );

  await deps.enqueue("ingest", {
    siteId: payload.siteId,
    sitemapRunId: payload.sitemapRunId,
    baseUrl: payload.sitemapUrl,
    expectedHost: new URL(payload.sitemapUrl).host
  });

  return {
    rootElement,
    fileCount: files.length,
    suspiciouslyEmpty: false
  };
}

function assertUsableResponse(response: SitemapResponse, url: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new SitemapUnavailableError(
      `${url} answered ${response.status}; a sitemap that cannot be fetched is a run-level failure, not an empty site`
    );
  }
}

/**
 * Which kind of document is this, at the cost of one element?
 *
 * Stops at the first `<loc>`, so learning that a 50,000-entry index is an index
 * does not read all 50,000 entries. `streamLocs` reports the root element even
 * when the callback stops it immediately, because the root is known from the
 * opening tag.
 */
async function detectRootElement(
  deps: PipelineDeps,
  payload: DiscoverPayload,
  isGzipStored: boolean
): Promise<"urlset" | "sitemapindex"> {
  const source = await deps.store.open({
    runId: payload.sitemapRunId,
    fileId: ENTRY_FILE_ID
  });

  const result = await streamLocs(source, () => false, {
    includeIndexLocs: true,
    ...(isGzipStored ? { isGzip: true } : {})
  });

  if (result.rootElement === "unknown") {
    throw new SitemapUnavailableError(
      `${payload.sitemapUrl} parsed but its root element is neither <urlset> nor <sitemapindex>`
    );
  }

  return result.rootElement;
}

/** Every child sitemap URL an index names. */
async function readIndexChildren(
  deps: PipelineDeps,
  payload: DiscoverPayload,
  isGzipStored: boolean
): Promise<readonly string[]> {
  const source = await deps.store.open({
    runId: payload.sitemapRunId,
    fileId: ENTRY_FILE_ID
  });

  const children: string[] = [];

  await streamLocs(
    source,
    (loc) => {
      children.push(loc);
    },
    {
      includeIndexLocs: true,
      ...(isGzipStored ? { isGzip: true } : {})
    }
  );

  return children;
}
