import { describe, expect, it } from "vitest";

import {
  BoundedHashSample,
  type SampleCandidate
} from "./bounded-hash-sample.js";
import { compareSampleKeys, stableHash } from "./stable-hash.js";

/**
 * A deterministic pseudo-random stream, so a failure is reproducible from the
 * seed alone. Math.random() here would make a rare ordering bug appear once and
 * never again.
 */
function* pseudoRandomUrls(count: number, seed = 1): Generator<string> {
  let state = seed >>> 0;

  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    yield `https://example.test/product/${state}-${index}`;
  }
}

function fill(
  heap: BoundedHashSample,
  urls: Iterable<string>,
  fileId = 1
): void {
  let ordinal = 0;

  for (const url of urls) {
    heap.offer(stableHash(url), fileId, ordinal);
    ordinal += 1;
  }
}

function keyOf(candidate: SampleCandidate): string {
  return `${candidate.hash}:${candidate.fileId}:${candidate.ordinal}`;
}

/** The K smallest, computed the obvious slow way, as an independent oracle. */
function bruteForceSmallest(
  urls: readonly string[],
  k: number,
  fileId = 1
): readonly SampleCandidate[] {
  return urls
    .map((url, ordinal) => ({ hash: stableHash(url), fileId, ordinal }))
    .sort((a, b) =>
      compareSampleKeys(
        a.hash,
        a.fileId,
        a.ordinal,
        b.hash,
        b.fileId,
        b.ordinal
      )
    )
    .slice(0, k);
}

describe("BoundedHashSample", () => {
  it("keeps exactly K once the population reaches it", () => {
    const heap = new BoundedHashSample(30);

    fill(heap, pseudoRandomUrls(5_000));

    expect(heap.size).toBe(30);
    expect(heap.seen).toBe(5_000);
  });

  it("keeps the whole population when it is smaller than K", () => {
    const heap = new BoundedHashSample(400);

    fill(heap, pseudoRandomUrls(17));

    expect(heap.size).toBe(17);
    // Nothing has been evicted, so no meaningful threshold has been set yet.
    expect(heap.threshold).toBe(0xffffffff);
  });

  /**
   * The correctness property everything else rests on: this is the K smallest,
   * not merely K small ones. Checked against an independent brute-force sort
   * rather than against the heap's own idea of order.
   */
  it("holds exactly the K smallest candidates", () => {
    const urls = [...pseudoRandomUrls(20_000, 7)];
    const heap = new BoundedHashSample(120);

    fill(heap, urls);

    expect(heap.toSortedArray().map(keyOf)).toEqual(
      bruteForceSmallest(urls, 120).map(keyOf)
    );
  });

  it("is reproducible across runs over identical input", () => {
    const first = new BoundedHashSample(60);
    const second = new BoundedHashSample(60);

    fill(first, pseudoRandomUrls(9_000, 42));
    fill(second, pseudoRandomUrls(9_000, 42));

    expect(first.toSortedArray()).toEqual(second.toSortedArray());
  });

  /**
   * Insertion order must not affect the result. A parse that visits files in a
   * different order — a resume, or a differently-scheduled worker pool — has to
   * draw the same sample.
   */
  it("does not depend on the order candidates arrive in", () => {
    const urls = [...pseudoRandomUrls(4_000, 11)];
    const forward = new BoundedHashSample(75);
    const backward = new BoundedHashSample(75);

    urls.forEach((url, ordinal) => {
      forward.offer(stableHash(url), 1, ordinal);
    });

    for (let index = urls.length - 1; index >= 0; index -= 1) {
      backward.offer(stableHash(urls[index] ?? ""), 1, index);
    }

    expect(forward.toSortedArray()).toEqual(backward.toSortedArray());
  });

  /**
   * Growing K must never contradict the smaller draw — an expansion that
   * dropped a URL round one had already probed would make the two rounds
   * disagree about the same pattern.
   */
  it("yields a strict superset as K grows", () => {
    const urls = [...pseudoRandomUrls(30_000, 3)];
    const small = new BoundedHashSample(30);
    const large = new BoundedHashSample(400);

    fill(small, urls);
    fill(large, urls);

    const smallKeys = small.toSortedArray().map(keyOf);
    const largeKeys = new Set(large.toSortedArray().map(keyOf));

    expect(smallKeys).toHaveLength(30);
    for (const key of smallKeys) {
      expect(largeKeys.has(key)).toBe(true);
    }
  });

  /**
   * A prefix of the stored candidates is a valid smaller draw. This is what
   * lets the pass collect at the 1,200 expansion ceiling while the first round
   * takes 400 — the expansion is then served from memory rather than by
   * re-reading the sitemap.
   */
  it("serves a smaller draw as a prefix of a larger collection", () => {
    const urls = [...pseudoRandomUrls(50_000, 5)];
    const collected = new BoundedHashSample(1_200);

    fill(collected, urls);

    expect(collected.toSortedArray().slice(0, 400).map(keyOf)).toEqual(
      bruteForceSmallest(urls, 400).map(keyOf)
    );
  });

  /**
   * THE property that makes per-file parsing, the memory cap and crash resume
   * exact rather than approximate. If this ever fails, spilling a heap mid-run
   * silently changes the answer.
   */
  it("merges exactly: heaping the union equals merging the parts", () => {
    const partA = [...pseudoRandomUrls(6_000, 21)];
    const partB = [...pseudoRandomUrls(6_000, 99)];

    const heapA = new BoundedHashSample(200);
    const heapB = new BoundedHashSample(200);

    for (const [ordinal, url] of partA.entries()) {
      heapA.offer(stableHash(url), 1, ordinal);
    }

    for (const [ordinal, url] of partB.entries()) {
      heapB.offer(stableHash(url), 2, ordinal);
    }

    heapA.merge(heapB);

    const wholeStream = new BoundedHashSample(200);

    for (const [ordinal, url] of partA.entries()) {
      wholeStream.offer(stableHash(url), 1, ordinal);
    }

    for (const [ordinal, url] of partB.entries()) {
      wholeStream.offer(stableHash(url), 2, ordinal);
    }

    expect(heapA.toSortedArray()).toEqual(wholeStream.toSortedArray());
    // The merged population count must survive too, or every denominator is wrong.
    expect(heapA.seen).toBe(12_000);
  });

  it("round-trips through a spill and rehydrate", () => {
    const urls = [...pseudoRandomUrls(8_000, 13)];
    const original = new BoundedHashSample(150);

    fill(original, urls);

    const revived = BoundedHashSample.fromCandidates(
      150,
      original.toSortedArray(),
      original.seen
    );

    expect(revived.toSortedArray()).toEqual(original.toSortedArray());
    expect(revived.seen).toBe(original.seen);
  });

  describe("the threshold", () => {
    it("bounds every retained candidate once the heap is full", () => {
      const heap = new BoundedHashSample(100);

      fill(heap, pseudoRandomUrls(25_000, 8));

      for (const candidate of heap.toSortedArray()) {
        expect(candidate.hash).toBeLessThanOrEqual(heap.threshold);
      }
    });

    it("only ever tightens as more candidates arrive", () => {
      const heap = new BoundedHashSample(50);
      let previous = heap.threshold;

      for (const url of pseudoRandomUrls(10_000, 17)) {
        heap.offer(stableHash(url), 1, 0);
        expect(heap.threshold).toBeLessThanOrEqual(previous);
        previous = heap.threshold;
      }
    });
  });

  describe("hash collisions", () => {
    /**
     * A 32-bit space and tens of millions of URLs collide constantly. Both
     * colliding candidates are real and distinct, so both must be eligible —
     * silently dropping one would bias the sample. Uniqueness downstream is on
     * the URL, never the hash (migration 0001).
     */
    it("retains distinct candidates that share a hash", () => {
      const heap = new BoundedHashSample(4);

      heap.offer(10, 1, 0);
      heap.offer(10, 1, 1);
      heap.offer(10, 2, 0);

      expect(heap.size).toBe(3);
    });

    it("breaks ties deterministically by position", () => {
      const forward = new BoundedHashSample(2);
      const reverse = new BoundedHashSample(2);

      forward.offer(10, 1, 5);
      forward.offer(10, 1, 2);

      reverse.offer(10, 1, 2);
      reverse.offer(10, 1, 5);

      expect(forward.toSortedArray()).toEqual(reverse.toSortedArray());
      expect(forward.toSortedArray()[0]?.ordinal).toBe(2);
    });
  });

  it("rejects a nonsensical capacity rather than degrading quietly", () => {
    expect(() => new BoundedHashSample(0)).toThrow(RangeError);
    expect(() => new BoundedHashSample(-1)).toThrow(RangeError);
    expect(() => new BoundedHashSample(1.5)).toThrow(RangeError);
  });
});

describe("stableHash", () => {
  // Pinned so an accidental change to the implementation fails loudly here
  // rather than silently invalidating every stored k_threshold_hash.
  it("produces the FNV-1a 32-bit values it always has", () => {
    expect(stableHash("")).toBe(0x811c9dc5);
    expect(stableHash("a")).toBe(0xe40c292c);
    expect(stableHash("foobar")).toBe(0xbf9cf968);
  });

  it("stays inside the unsigned 32-bit range", () => {
    for (const url of pseudoRandomUrls(2_000, 4)) {
      const hash = stableHash(url);

      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  /**
   * Not a quality bound on the hash — just a smoke test that it is not
   * degenerate. A hash that clumped would make "the K smallest" a biased slice
   * of the population rather than a random one.
   */
  it("spreads URLs across the space reasonably evenly", () => {
    const buckets = new Array<number>(16).fill(0);

    for (const url of pseudoRandomUrls(16_000, 6)) {
      const bucket = Math.floor((stableHash(url) / 0x100000000) * 16);

      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    for (const count of buckets) {
      expect(count).toBeGreaterThan(700);
      expect(count).toBeLessThan(1_300);
    }
  });
});
