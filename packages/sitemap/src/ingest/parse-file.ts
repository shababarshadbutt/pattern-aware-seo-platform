import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import type { PatternAccumulator } from "../extraction/pattern-accumulator.js";
import { parseLoc } from "../extraction/url-path.js";
import { type StreamLocsResult, streamLocs } from "../parser/loc-stream.js";

/** One sitemap file to read. */
export interface SitemapFileSource {
  /**
   * Small integer identifying the file within this run.
   *
   * Not the database UUID: it is packed into a `Uint32Array` alongside the hash
   * and ordinal, and it is what makes a sample candidate 12 bytes instead of a
   * string. The caller keeps the mapping back to the real row.
   */
  readonly fileId: number;
  /** Local path to read from. */
  readonly path: string;
  readonly isGzip?: boolean;
}

export interface ParseFileOptions {
  /** Site base URL, for resolving relative `<loc>` values. */
  readonly baseUrl: string;
  /** Expected host. Anything else is recorded as foreign, not counted. */
  readonly expectedHost: string;
  /**
   * Stop after this many URLs from this file. Enforced through the parser's
   * early-stop path, so the rest of the document is never read.
   */
  readonly maxUrls?: number;
}

export interface ParseFileResult {
  readonly fileId: number;
  /** URLs on the expected host — the ones that counted. */
  readonly matchedUrls: number;
  /** URLs pointing somewhere else. A finding, not a parse failure. */
  readonly foreignUrls: number;
  /** `<loc>` values that were not usable URLs at all. */
  readonly unparseableUrls: number;
  readonly stream: StreamLocsResult;
}

/**
 * Read one sitemap file into an accumulator.
 *
 * The accumulator is passed in rather than returned so several files fold into
 * one set of patterns without an intermediate result per file — which is what
 * makes this a single pass over the site rather than a pass per file followed
 * by a merge.
 *
 * Foreign and unparseable URLs are counted but not accumulated. Dropping them
 * silently would make the population disagree with what the sitemap actually
 * lists, and a sitemap full of off-domain URLs is usually a botched migration
 * worth reporting rather than a detail worth hiding.
 */
export async function parseSitemapFile(
  file: SitemapFileSource,
  accumulator: PatternAccumulator,
  options: ParseFileOptions
): Promise<ParseFileResult> {
  const source: Readable = createReadStream(file.path);

  return parseSitemapStream(source, file, accumulator, options);
}

/** As {@link parseSitemapFile}, but from a stream the caller already has. */
export async function parseSitemapStream(
  source: Readable,
  file: Pick<SitemapFileSource, "fileId" | "isGzip">,
  accumulator: PatternAccumulator,
  options: ParseFileOptions
): Promise<ParseFileResult> {
  let matchedUrls = 0;
  let foreignUrls = 0;
  let unparseableUrls = 0;

  const streamOptions =
    file.isGzip === undefined ? {} : { isGzip: file.isGzip };

  const stream = await streamLocs(
    source,
    (loc, ordinal) => {
      const parsed = parseLoc(loc, options.baseUrl, options.expectedHost);

      if (parsed.kind === "foreign") {
        foreignUrls += 1;

        return;
      }

      if (parsed.kind === "unparseable") {
        unparseableUrls += 1;

        return;
      }

      /**
       * The PATH is hashed, not the full URL.
       *
       * Both are reproducible, but the path is what a re-read can recompute:
       * resolving a sampled candidate later means reading this file at this
       * ordinal and running `parseLoc` again, so the value hashed at collection
       * has to be the value derivable at resolution. It is also shorter, and
       * this runs once per URL.
       *
       * The query string is included, because two URLs differing only by query
       * are genuinely different URLs even though they share a pattern.
       */
      accumulator.observe(parsed.segments, file.fileId, ordinal, parsed.path);
      matchedUrls += 1;

      if (options.maxUrls !== undefined && matchedUrls >= options.maxUrls) {
        return false;
      }

      return true;
    },
    streamOptions
  );

  return {
    fileId: file.fileId,
    matchedUrls,
    foreignUrls,
    unparseableUrls,
    stream
  };
}
