import type { PatternAccumulator } from "./pattern-accumulator.js";
import { parseLoc } from "./url-path.js";

/**
 * Turning a stream of `<loc>` values into accumulator observations.
 *
 * EXTRACTED SO THERE IS ONE OF IT. `parseSitemapStream` used to hold this loop
 * inline, which was fine while the pipeline was its only caller. It is not the
 * only caller any more: the pattern-extraction tool folds a pasted list of URLs
 * into the same accumulator, and a tool that re-derives this loop is a second
 * source of truth that will drift from the pipeline it claims to demonstrate.
 *
 * Three details here are load-bearing and are exactly what a reimplementation
 * gets wrong:
 *
 *   - THE PATH IS HASHED, NOT THE FULL URL. Both are reproducible, but the path
 *     is what a re-read can recompute — resolving a sampled candidate later
 *     means reading the file at that ordinal and running `parseLoc` again, so
 *     the value hashed at collection has to be the value derivable at
 *     resolution. A caller hashing `sourceUrl` instead would draw a DIFFERENT
 *     SAMPLE for the same input, silently. The query string is included,
 *     because two URLs differing only by query are genuinely different URLs
 *     even though they share a pattern.
 *   - THE ORDINAL IS THE CALLER'S, and it advances over foreign and
 *     unparseable locs too. It is a position in the file, not a count of what
 *     was usable, because resolution seeks by position.
 *   - FOREIGN AND UNPARSEABLE ARE COUNTED, NEVER ACCUMULATED. Dropping them
 *     silently would make the population disagree with what the sitemap lists,
 *     and a sitemap full of off-domain URLs is usually a botched migration
 *     worth reporting rather than a detail worth hiding.
 *
 * Pure and synchronous: no stream, no file, no early-stop. The early-stop
 * belongs to the caller that owns the stream, which is why `maxUrls` is not a
 * concern of this class.
 */

export interface LocObserverOptions {
  /** Site base URL, for resolving relative `<loc>` values. */
  readonly baseUrl: string;
  /** Expected host. Anything else is recorded as foreign, not counted. */
  readonly expectedHost: string;
  /**
   * Small integer identifying the file within this run — packed into the sample
   * candidate alongside the hash and ordinal. A caller with no real file (the
   * extraction tool, whose "file" is the paste itself) passes 0.
   */
  readonly fileId: number;
}

export class LocObserver {
  readonly #accumulator: PatternAccumulator;
  readonly #options: LocObserverOptions;
  readonly #foreignHosts = new Map<string, number>();

  #matchedUrls = 0;
  #foreignUrls = 0;
  #unparseableUrls = 0;

  public constructor(
    accumulator: PatternAccumulator,
    options: LocObserverOptions
  ) {
    this.#accumulator = accumulator;
    this.#options = options;
  }

  /** URLs on the expected host — the ones that counted. */
  public get matchedUrls(): number {
    return this.#matchedUrls;
  }

  /** URLs pointing somewhere else. A finding, not a parse failure. */
  public get foreignUrls(): number {
    return this.#foreignUrls;
  }

  /** `<loc>` values that were not usable URLs at all. */
  public get unparseableUrls(): number {
    return this.#unparseableUrls;
  }

  /**
   * Which other hosts appeared, and how often.
   *
   * The pipeline does not use this — it audits one site and a foreign count is
   * enough. The extraction tool does: a caller pasting URLs has not told us
   * which host they meant, so the distribution is what identifies it, and
   * showing the runners-up is what turns "187 foreign URLs" from a dead end
   * into something the reader can act on.
   */
  public get foreignHosts(): ReadonlyMap<string, number> {
    return this.#foreignHosts;
  }

  /** Observe one `<loc>` at its position in the file. */
  public observe(loc: string, ordinal: number): void {
    const parsed = parseLoc(
      loc,
      this.#options.baseUrl,
      this.#options.expectedHost
    );

    if (parsed.kind === "foreign") {
      this.#foreignUrls += 1;
      this.#foreignHosts.set(
        parsed.detectedHost,
        (this.#foreignHosts.get(parsed.detectedHost) ?? 0) + 1
      );

      return;
    }

    if (parsed.kind === "unparseable") {
      this.#unparseableUrls += 1;

      return;
    }

    this.#accumulator.observe(
      parsed.segments,
      this.#options.fileId,
      ordinal,
      parsed.path
    );

    this.#matchedUrls += 1;
  }
}
