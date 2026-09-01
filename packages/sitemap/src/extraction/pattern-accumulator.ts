import {
  BoundedHashSample,
  type SampleCandidate,
  stableHash
} from "@pattern-aware/sampling";

import { PatternTrie } from "./pattern-trie.js";
import { segmentsFromTemplate } from "./template.js";

/** What one pattern accumulated during a pass. */
export interface AccumulatedPattern {
  readonly template: string;
  readonly segmentCount: number;
  /** Counted, not estimated: every URL that collapsed onto this template. */
  readonly populationCount: number;
  /** URLs contributed per sitemap file — the pattern-to-file index. */
  readonly perFileCounts: ReadonlyMap<number, number>;
  /** The K smallest by hash, in selection order. */
  readonly sampleCandidates: readonly SampleCandidate[];
  /** Largest retained hash; persisted as `pattern_sample.k_threshold_hash`. */
  readonly sampleThreshold: number;
}

export interface AccumulatorResult {
  readonly patterns: readonly AccumulatedPattern[];
  readonly totalUrls: number;
}

/** Per-pattern payload hung off the trie's terminal nodes. */
interface PatternGroup {
  populationCount: number;
  readonly perFileCounts: Map<number, number>;
  readonly sample: BoundedHashSample;
}

export interface PatternAccumulatorOptions {
  /**
   * Candidates retained per pattern.
   *
   * Set to the EXPANDED ceiling, not the first-round budget: the first draw is
   * a prefix of what is kept here, and an adaptive expansion is then served
   * from memory rather than by re-reading the sitemap. See ADR-0002.
   */
  readonly sampleCapacity: number;
}

/**
 * Collapses URLs onto patterns in ONE streaming pass, producing everything
 * downstream needs at once.
 *
 * This is the centre of M2 and the fix for the legacy engine's core scaling
 * problem. There, the three things a pattern needs are gathered by three
 * separate full scans — and one of them, population enumeration, reads every
 * `<loc>` of every file in the session because, as `patternPopulationPool.ts`
 * says in its own comment, "nothing records a pattern-to-file index". Here a
 * single pass produces:
 *
 *   1. population counts per pattern,
 *   2. per-file counts (the missing index), and
 *   3. the sample candidates, drawn reproducibly by hash.
 *
 * Memory is bounded by patterns, never by URLs. Nothing holds a URL string
 * beyond the moment it is hashed — candidates are stored as
 * `(hash, fileId, ordinal)` triples, so a 40-million-URL site costs the same as
 * a 40-thousand-URL one with the same number of patterns.
 *
 * Grouping is delegated to {@link PatternTrie}, which decides which path
 * segments are variable from context rather than from position (ADR-0012).
 * Everything the trie does mid-stream — collapsing a crowded slot, folding one
 * partial pass into another — merges groups, and merging is EXACT here: counts
 * add, per-file counts add, and heaps combine to the true K smallest of the
 * union. That is what makes a resumed run produce the same answer as an
 * uninterrupted one, and it is the property a reservoir sample could not have
 * provided (ADR-0002).
 */
export class PatternAccumulator {
  readonly #sampleCapacity: number;
  readonly #trie: PatternTrie<PatternGroup>;

  #totalUrls = 0;

  public constructor(options: PatternAccumulatorOptions) {
    this.#sampleCapacity = options.sampleCapacity;
    this.#trie = new PatternTrie<PatternGroup>({
      create: () => ({
        populationCount: 0,
        perFileCounts: new Map<number, number>(),
        sample: new BoundedHashSample(this.#sampleCapacity)
      }),
      merge: (target, source) => {
        target.populationCount += source.populationCount;
        target.sample.merge(source.sample);

        for (const [fileId, count] of source.perFileCounts) {
          target.perFileCounts.set(
            fileId,
            (target.perFileCounts.get(fileId) ?? 0) + count
          );
        }
      }
    });
  }

  public get totalUrls(): number {
    return this.#totalUrls;
  }

  /**
   * Fold one URL in.
   *
   * `value` is hashed and discarded; only `(hash, fileId, ordinal)` is retained.
   * `ordinal` is the URL's index within its file, which is how a sampled
   * candidate is resolved later without rescanning the population.
   */
  public observe(
    segments: readonly string[],
    fileId: number,
    ordinal: number,
    value: string
  ): void {
    this.#totalUrls += 1;

    const group = this.#trie.terminalFor(segments);

    group.populationCount += 1;
    group.perFileCounts.set(fileId, (group.perFileCounts.get(fileId) ?? 0) + 1);
    group.sample.offer(stableHash(value), fileId, ordinal);
  }

  /**
   * Fold another accumulator in — a second worker thread's share of the files,
   * or a partial result recovered after a crash.
   */
  public merge(other: PatternAccumulator): void {
    this.#totalUrls += other.#totalUrls;
    this.#trie.merge(other.#trie);
  }

  public result(): AccumulatorResult {
    const patterns: AccumulatedPattern[] = this.#trie
      .entries()
      .map(({ template, terminal }) => ({
        template,
        segmentCount: segmentsFromTemplate(template).length,
        populationCount: terminal.populationCount,
        perFileCounts: terminal.perFileCounts,
        sampleCandidates: terminal.sample.toSortedArray(),
        sampleThreshold: terminal.sample.threshold
      }));

    // Largest first: population is the first term of the impact score, and
    // every consumer reads it in that order. Ties break on the template so the
    // ordering is total — otherwise two runs could disagree about which of two
    // equal-sized patterns comes first.
    patterns.sort(
      (a, b) =>
        b.populationCount - a.populationCount ||
        a.template.localeCompare(b.template)
    );

    return { patterns, totalUrls: this.#totalUrls };
  }

  /** Approximate retained bytes, for the flush-and-merge memory cap. */
  public estimatedBytes(): number {
    let candidates = 0;
    let groups = 0;

    for (const { terminal } of this.#trie.entries()) {
      candidates += terminal.sample.size;
      groups += 1;
    }

    // 12 bytes per candidate triple, a rough allowance per pattern for its
    // per-file map and heap headers, and per trie node for its Map and object.
    return candidates * 12 + groups * 512 + this.#trie.nodeCount * 200;
  }
}
