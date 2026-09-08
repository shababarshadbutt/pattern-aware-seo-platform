import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";

import { LocObserver } from "../extraction/loc-observer.js";
import type { PatternAccumulator } from "../extraction/pattern-accumulator.js";
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
  /*
   * The loc-to-observation rules live in `LocObserver`, shared with the
   * pattern-extraction tool. What stays here is the part that genuinely
   * belongs to a stream: the early stop. `LocObserver` has no `maxUrls`
   * because a caller folding a pasted list has nothing to stop reading.
   */
  const observer = new LocObserver(accumulator, {
    baseUrl: options.baseUrl,
    expectedHost: options.expectedHost,
    fileId: file.fileId
  });

  const streamOptions =
    file.isGzip === undefined ? {} : { isGzip: file.isGzip };

  const stream = await streamLocs(
    source,
    (loc, ordinal) => {
      observer.observe(loc, ordinal);

      if (
        options.maxUrls !== undefined &&
        observer.matchedUrls >= options.maxUrls
      ) {
        return false;
      }

      return true;
    },
    streamOptions
  );

  return {
    fileId: file.fileId,
    matchedUrls: observer.matchedUrls,
    foreignUrls: observer.foreignUrls,
    unparseableUrls: observer.unparseableUrls,
    stream
  };
}
