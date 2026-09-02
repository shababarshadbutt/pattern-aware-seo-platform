import { compareSampleKeys } from "./stable-hash.js";

/** Slots allocated to a heap that has only just started receiving candidates. */
const INITIAL_SLOTS = 16;

/**
 * One retained sample candidate.
 *
 * Deliberately NOT the URL. Resolving a candidate back to its URL is a targeted
 * re-read of one file at one ordinal, which `pattern_population` makes cheap
 * (that index is the thing the legacy engine lacks). Holding the string instead
 * would multiply memory by URL length — about 600 MB for a large site against
 * 72 MB for these triples — and length varies by site, so the budget could not
 * be stated in advance. See ADR-0002.
 */
export interface SampleCandidate {
  readonly hash: number;
  readonly fileId: number;
  readonly ordinal: number;
}

/**
 * The K candidates with the smallest hashes, maintained in one streaming pass.
 *
 * Implemented as a bounded binary MAX-heap, which reads backwards at first: to
 * keep the K *smallest* values you need constant-time access to the largest one
 * you are currently holding, so it can be evicted when something smaller
 * arrives. The root is therefore the current threshold.
 *
 * WHY THIS AND NOT THE ALTERNATIVES. Threshold sampling (`hash(url) < t`) gives
 * a sample size that only averages out to K, which is awkward against a hard
 * floor of 30. Reservoir sampling gives an exact size but is seeded by a random
 * number generator, so it is not reproducible, and two partial reservoirs
 * cannot be combined. This structure has every property the pipeline needs:
 *
 *   - exact size K whenever the population reaches it;
 *   - reproducible — the same input yields the same sample, because selection
 *     is a pure function of the hash and the tie-break;
 *   - a strict superset as K grows, so an expanded draw never contradicts the
 *     draw it expands;
 *   - and EXACTLY MERGEABLE, which the other two are not.
 *
 * Mergeability is what makes the rest of M2 work rather than approximate. The
 * K smallest of a union is the K smallest overall, so per-file heaps can be
 * combined, spilled to Postgres when the memory cap is hit, and re-merged on
 * resume — all without changing the answer. A run killed halfway through
 * produces the same sample as one that was not.
 *
 * ON CAPACITY. Collect at the EXPANDED ceiling (1,200), not the first-round
 * budget (400). The first round is then the 400 smallest of the 1,200 held,
 * which are also the 400 smallest of the whole population — and an adaptive
 * expansion up to 1,200 is served from memory instead of re-reading the
 * sitemap. Going beyond 1,200 would need a rescan, which is precisely why 1,200
 * is a hard ceiling rather than a default.
 */
export class BoundedHashSample {
  readonly #capacity: number;

  // Parallel typed arrays rather than an array of objects: 12 bytes per entry
  // with no per-object header, and no garbage for the collector to walk while
  // a parse is streaming millions of URLs through it.
  #hash: Uint32Array;
  #fileId: Uint32Array;
  #ordinal: Uint32Array;

  #size = 0;
  #seen = 0;

  public constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `capacity must be a positive integer, got ${capacity}`
      );
    }

    this.#capacity = capacity;

    // GROWN ON DEMAND, not allocated at full capacity.
    //
    // A site produces thousands of patterns and most of them are small — a
    // handful of URLs each — while capacity is set by the largest draw any
    // pattern could ever need (1,200). Allocating that up front would cost
    // ~14 KB per pattern regardless of use, which on a site with tens of
    // thousands of patterns is hundreds of megabytes of empty typed array and
    // would blow the parse memory budget on nothing.
    const initial = Math.min(capacity, INITIAL_SLOTS);

    this.#hash = new Uint32Array(initial);
    this.#fileId = new Uint32Array(initial);
    this.#ordinal = new Uint32Array(initial);
  }

  #ensureSlot(): void {
    if (this.#size < this.#hash.length) {
      return;
    }

    const next = Math.min(
      this.#capacity,
      Math.max(INITIAL_SLOTS, this.#hash.length * 2)
    );

    const hash = new Uint32Array(next);
    const fileId = new Uint32Array(next);
    const ordinal = new Uint32Array(next);

    hash.set(this.#hash);
    fileId.set(this.#fileId);
    ordinal.set(this.#ordinal);

    this.#hash = hash;
    this.#fileId = fileId;
    this.#ordinal = ordinal;
  }

  public get capacity(): number {
    return this.#capacity;
  }

  public get size(): number {
    return this.#size;
  }

  /** How many candidates were offered, retained or not. The population count. */
  public get seen(): number {
    return this.#seen;
  }

  /**
   * The largest hash currently retained, or `0xFFFFFFFF` while the heap has
   * room.
   *
   * Persisted as `pattern_sample.k_threshold_hash`. Every retained candidate
   * has `hash <= threshold`, which is what lets a reviewer verify the superset
   * property by comparing two numbers rather than re-deriving the hash function
   * and trusting it has not changed.
   */
  public get threshold(): number {
    return this.#size < this.#capacity ? 0xffffffff : (this.#hash[0] ?? 0);
  }

  /**
   * Offer a candidate. Returns whether it was retained.
   *
   * Note there is no de-duplication by hash, deliberately: at 40M URLs a 32-bit
   * space collides constantly, and two distinct URLs sharing a hash are two
   * distinct candidates. Dropping one would bias the sample for no reason. See
   * the note in stable-hash.ts.
   */
  public offer(hash: number, fileId: number, ordinal: number): boolean {
    this.#seen += 1;

    if (this.#size < this.#capacity) {
      this.#ensureSlot();
      this.#hash[this.#size] = hash;
      this.#fileId[this.#size] = fileId;
      this.#ordinal[this.#size] = ordinal;
      this.#size += 1;
      this.#siftUp(this.#size - 1);

      return true;
    }

    // Full: keep this only if it beats the largest thing already held.
    if (
      compareSampleKeys(
        hash,
        fileId,
        ordinal,
        this.#hash[0] ?? 0,
        this.#fileId[0] ?? 0,
        this.#ordinal[0] ?? 0
      ) >= 0
    ) {
      return false;
    }

    this.#hash[0] = hash;
    this.#fileId[0] = fileId;
    this.#ordinal[0] = ordinal;
    this.#siftDown(0);

    return true;
  }

  /**
   * Absorb another heap's candidates, and its `seen` count.
   *
   * Exact: the result holds the K smallest of the union, which is the K
   * smallest overall. This is what makes per-file parsing, spill-to-disk and
   * crash resume produce the same sample as a single uninterrupted pass.
   */
  public merge(other: BoundedHashSample): void {
    const absorbed = other.#seen;

    for (let index = 0; index < other.#size; index += 1) {
      this.offer(
        other.#hash[index] ?? 0,
        other.#fileId[index] ?? 0,
        other.#ordinal[index] ?? 0
      );
    }

    // `offer` counted the entries it was handed; correct that to the real
    // population the other heap observed.
    this.#seen += absorbed - other.#size;
  }

  /**
   * The retained candidates in selection order — smallest hash first.
   *
   * A draw of size n is `take(n)` of this. Because the heap holds the K
   * smallest of the population, any prefix is the corresponding prefix of the
   * whole population's ordering, which is why an expansion is a strict superset
   * of the round before it.
   */
  public toSortedArray(): readonly SampleCandidate[] {
    const entries: SampleCandidate[] = [];

    for (let index = 0; index < this.#size; index += 1) {
      entries.push({
        hash: this.#hash[index] ?? 0,
        fileId: this.#fileId[index] ?? 0,
        ordinal: this.#ordinal[index] ?? 0
      });
    }

    return entries.sort((a, b) =>
      compareSampleKeys(
        a.hash,
        a.fileId,
        a.ordinal,
        b.hash,
        b.fileId,
        b.ordinal
      )
    );
  }

  /** Rehydrate a spilled heap. `seen` is the population it had already counted. */
  public static fromCandidates(
    capacity: number,
    candidates: readonly SampleCandidate[],
    seen: number
  ): BoundedHashSample {
    const heap = new BoundedHashSample(capacity);

    for (const candidate of candidates) {
      heap.offer(candidate.hash, candidate.fileId, candidate.ordinal);
    }

    heap.#seen = seen;

    return heap;
  }

  #less(a: number, b: number): boolean {
    return (
      compareSampleKeys(
        this.#hash[a] ?? 0,
        this.#fileId[a] ?? 0,
        this.#ordinal[a] ?? 0,
        this.#hash[b] ?? 0,
        this.#fileId[b] ?? 0,
        this.#ordinal[b] ?? 0
      ) < 0
    );
  }

  #swap(a: number, b: number): void {
    const hash = this.#hash[a] ?? 0;
    const fileId = this.#fileId[a] ?? 0;
    const ordinal = this.#ordinal[a] ?? 0;

    this.#hash[a] = this.#hash[b] ?? 0;
    this.#fileId[a] = this.#fileId[b] ?? 0;
    this.#ordinal[a] = this.#ordinal[b] ?? 0;

    this.#hash[b] = hash;
    this.#fileId[b] = fileId;
    this.#ordinal[b] = ordinal;
  }

  #siftUp(start: number): void {
    let index = start;

    while (index > 0) {
      const parent = (index - 1) >> 1;

      // Max-heap: a child that is LARGER than its parent must rise.
      if (!this.#less(parent, index)) {
        return;
      }

      this.#swap(parent, index);
      index = parent;
    }
  }

  #siftDown(start: number): void {
    let index = start;

    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;

      if (left < this.#size && this.#less(largest, left)) {
        largest = left;
      }

      if (right < this.#size && this.#less(largest, right)) {
        largest = right;
      }

      if (largest === index) {
        return;
      }

      this.#swap(index, largest);
      index = largest;
    }
  }
}
