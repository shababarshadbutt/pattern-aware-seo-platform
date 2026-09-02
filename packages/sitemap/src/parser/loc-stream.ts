import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import sax from "sax";

import {
  isNonRecoverablePreambleError,
  NonRecoverablePreambleError,
  PreambleStrippingTransform
} from "./preamble.js";

/**
 * Which document this turned out to be. Determined from the root element, so it
 * is only known after the first tag.
 */
export type SitemapRootElement = "urlset" | "sitemapindex" | "unknown";

/**
 * Called for every `<loc>`, in document order.
 *
 * Return `false` to stop parsing and tear the stream down — used by the
 * oversize hard limit, so a 200-million-URL sitemap costs one truncated read
 * rather than a full one.
 */
export type LocCallback = (loc: string, ordinal: number) => boolean | void;

/**
 * Raised when the document parsed, but is not a sitemap.
 *
 * This exists because well-formed XML is a much lower bar than "is a sitemap".
 * An HTML error page — the 500 a misconfigured origin serves in place of a
 * sitemap — is frequently valid XML with every tag closed, so it parses
 * happily and yields no `<loc>` elements. Reporting that as a successful read
 * of an empty sitemap would record a population of zero for a site with
 * millions of URLs, and nothing downstream could tell that from a site that
 * genuinely lists nothing.
 */
export class NotASitemapError extends Error {
  public override readonly name = "NotASitemapError";

  public constructor(public readonly rootElement: string) {
    super(
      `Document root is <${rootElement}>, expected <urlset> or <sitemapindex>`
    );
  }
}

export interface StreamLocsOptions {
  /** The source is gzip-encoded and must be inflated first. */
  readonly isGzip?: boolean;
  /**
   * Also emit the `<loc>` entries of a sitemap INDEX — the child sitemap URLs
   * rather than page URLs. Off by default so callers cannot accidentally treat
   * a list of sitemaps as a list of pages, which silently produces a population
   * of a few hundred instead of a few million.
   */
  readonly includeIndexLocs?: boolean;
  /**
   * Reject a document whose root is neither `<urlset>` nor `<sitemapindex>`.
   *
   * Defaults to true, so the safe reading is the one you get without thinking
   * about it. Opting out is for callers that genuinely want to probe an unknown
   * document and decide for themselves.
   */
  readonly requireSitemapRoot?: boolean;
}

export interface StreamLocsResult {
  readonly rootElement: SitemapRootElement;
  /** How many `<loc>` values were emitted to the callback. */
  readonly locCount: number;
  /** True when junk was removed from the front of the file to make it parse. */
  readonly hadPreambleStripped: boolean;
  /** True when the callback asked to stop before the end of the document. */
  readonly stoppedEarly: boolean;
}

function localName(name: string): string {
  // Namespace prefixes vary between generators; only the local part matters.
  return name.split(":").pop()?.toLowerCase() ?? name.toLowerCase();
}

/**
 * Stream every `<loc>` out of a sitemap without holding the document in memory.
 *
 * This is the primitive the whole product rests on: a 50,000-URL file is parsed
 * in constant memory, so a site with thousands of files costs bounded memory
 * regardless of how many URLs it contains. Ported from the legacy engine's
 * `parser.ts`, which already had the right shape — a callback per `<loc>`
 * rather than an array — and the hard-won details around gzip, namespace
 * prefixes, CDATA and preamble recovery.
 *
 * The callback receives an ordinal alongside the URL. That ordinal is half of
 * the `(fileId, ordinal)` address the sampler stores instead of the URL string,
 * and it is why a sampled candidate can be resolved later by re-reading one
 * file rather than rescanning the population.
 */
export async function streamLocs(
  source: Readable,
  onLoc: LocCallback,
  options: StreamLocsOptions = {}
): Promise<StreamLocsResult> {
  return new Promise<StreamLocsResult>((resolve, reject) => {
    const parser = sax.parser(true, {});
    const preambleStripper = new PreambleStrippingTransform();

    const decoded =
      options.isGzip === true ? source.pipe(createGunzip()) : source;
    const input = decoded.pipe(preambleStripper);

    let rootElement: SitemapRootElement = "unknown";
    // The tag as written, kept for diagnostics: `rootElement` narrows anything
    // unrecognised to "unknown", which throws away the one detail that tells
    // you what the server actually served.
    let rootTagName: string | undefined;
    let inLoc = false;
    let locText = "";
    let locCount = 0;
    let stoppedEarly = false;
    let settled = false;

    function teardown(): void {
      source.destroy();

      if (decoded !== source) {
        decoded.destroy();
      }

      input.destroy();
    }

    function settle(error?: unknown): void {
      if (settled) {
        return;
      }

      settled = true;
      teardown();

      if (error !== undefined) {
        /**
         * If junk was stripped and the document STILL failed to parse, the
         * stripping is the more likely culprit and the raw XML error would send
         * the reader chasing a phantom syntax problem. Report the preamble.
         */
        reject(
          preambleStripper.hadPreambleStripped &&
            !isNonRecoverablePreambleError(error)
            ? new NonRecoverablePreambleError()
            : error
        );

        return;
      }

      resolve({
        rootElement,
        locCount,
        hadPreambleStripped: preambleStripper.hadPreambleStripped,
        stoppedEarly
      });
    }

    parser.onopentag = (node) => {
      if (settled) {
        return;
      }

      const name = localName(node.name);

      if (rootTagName === undefined) {
        rootTagName = node.name;
        rootElement =
          name === "urlset" || name === "sitemapindex" ? name : "unknown";
      }

      if (name === "loc") {
        inLoc = true;
        locText = "";
      }
    };

    parser.ontext = (text) => {
      if (!settled && inLoc) {
        locText += text;
      }
    };

    // Some generators wrap URLs in CDATA; the text handler never sees those.
    parser.oncdata = (text) => {
      if (!settled && inLoc) {
        locText += text;
      }
    };

    parser.onclosetag = (name) => {
      /**
       * sax parses an entire chunk synchronously, so `settle()` does not stop
       * the events already queued behind it in this write. Without this guard,
       * a callback that asked to stop after 10 URLs still sees every URL in the
       * chunk — which for a one-chunk document is all of them, and the oversize
       * hard limit does nothing at all.
       */
      if (settled || localName(name) !== "loc") {
        return;
      }

      const loc = locText.trim();

      inLoc = false;
      locText = "";

      const accepted =
        rootElement === "urlset" ||
        (options.includeIndexLocs === true && rootElement === "sitemapindex");

      if (loc === "" || !accepted) {
        return;
      }

      const shouldContinue = onLoc(loc, locCount);

      locCount += 1;

      if (shouldContinue === false) {
        stoppedEarly = true;
        settle();
      }
    };

    parser.onerror = (error) => {
      settle(error);
    };

    input.setEncoding("utf8");

    input.on("data", (chunk: string) => {
      if (settled) {
        return;
      }

      try {
        parser.write(chunk);
      } catch (error) {
        settle(error);
      }
    });

    source.on("error", settle);

    if (decoded !== source) {
      decoded.on("error", settle);
    }

    input.on("error", settle);

    input.on("end", () => {
      if (settled) {
        return;
      }

      try {
        parser.close();
      } catch (error) {
        settle(error);

        return;
      }

      if (options.requireSitemapRoot !== false && rootElement === "unknown") {
        settle(new NotASitemapError(rootTagName ?? "empty document"));

        return;
      }

      settle();
    });
  });
}
