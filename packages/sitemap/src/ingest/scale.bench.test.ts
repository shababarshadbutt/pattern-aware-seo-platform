import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PatternAccumulator } from "../extraction/pattern-accumulator.js";
import { generateSyntheticCorpus } from "../testing/synthetic-corpus.js";
import { parseSitemapFile, type SitemapFileSource } from "./parse-file.js";

/**
 * M2's scale criteria, asserted rather than asserted-in-prose.
 *
 * The full acceptance target is ten million URLs under 1.5 GB. Ten million
 * takes minutes to generate and parse, which is too slow for every `pnpm test`,
 * so the default here is a smaller corpus that exercises exactly the same code
 * path and the same memory behaviour. The point of the assertions is that
 * memory tracks PATTERNS rather than URLS — a property that shows up just as
 * clearly at 200,000 as at 10,000,000, and if it holds at both then the
 * constant is the only thing that changed.
 *
 * Run the real thing before believing the headline number:
 *   SITEMAP_BENCH_URLS=10000000 pnpm --filter @pattern-aware/sitemap test
 */
const BENCH_URLS = Number(process.env.SITEMAP_BENCH_URLS ?? 200_000);
const URLS_PER_FILE = 50_000;
const BASE_URL = "https://synthetic.test";
const SAMPLE_CAPACITY = 1_200;

/** The M2 budget. Absolute, not relative to whatever it happens to use today. */
const RSS_CEILING_MB = 1_536;

let corpusDir: string;
let files: SitemapFileSource[];

function accumulator(): PatternAccumulator {
  return new PatternAccumulator({ sampleCapacity: SAMPLE_CAPACITY });
}

async function parseAll(
  acc: PatternAccumulator,
  subset: readonly SitemapFileSource[]
): Promise<void> {
  for (const file of subset) {
    await parseSitemapFile(file, acc, {
      baseUrl: BASE_URL,
      expectedHost: "synthetic.test"
    });
  }
}

beforeAll(() => {
  corpusDir = mkdtempSync(join(tmpdir(), "psp-sitemap-bench-"));

  generateSyntheticCorpus({
    outDir: corpusDir,
    totalUrls: BENCH_URLS,
    urlsPerFile: URLS_PER_FILE,
    seed: 1,
    gzipRatio: 0.25,
    baseUrl: BASE_URL
  });

  files = readdirSync(corpusDir)
    .filter(
      (name) => name.startsWith("sitemap-") && name !== "sitemap-index.xml"
    )
    .sort()
    .map((name, index) => ({
      fileId: index + 1,
      path: join(corpusDir, name),
      isGzip: name.endsWith(".gz")
    }));
}, 600_000);

afterAll(() => {
  rmSync(corpusDir, { recursive: true, force: true });
});

describe(`single-pass ingestion at ${BENCH_URLS.toLocaleString()} URLs`, () => {
  it("produces counts, the per-file index, and sample candidates in one pass", async () => {
    const acc = accumulator();

    await parseAll(acc, files);

    const { patterns, totalUrls } = acc.result();

    expect(totalUrls).toBe(BENCH_URLS);
    expect(patterns.length).toBeGreaterThan(0);

    // All three artefacts, from the same traversal. The legacy engine needs a
    // separate full scan for each, and reads every <loc> of every file to get
    // the second one because no pattern-to-file index exists.
    const largest = patterns[0];

    expect(largest?.populationCount).toBeGreaterThan(0);
    expect(largest?.perFileCounts.size).toBeGreaterThan(0);
    expect(largest?.sampleCandidates.length).toBeGreaterThan(0);

    // Population is counted, so the parts must sum to the whole.
    const summed = patterns.reduce((sum, p) => sum + p.populationCount, 0);

    expect(summed).toBe(BENCH_URLS);
  }, 600_000);

  it("stays inside the memory budget", async () => {
    const acc = accumulator();

    await parseAll(acc, files);

    const peakRssMb = process.memoryUsage().rss / 1_048_576;
    const retainedMb = acc.estimatedBytes() / 1_048_576;

    expect(peakRssMb).toBeLessThan(RSS_CEILING_MB);
    // The real claim: retained state is a function of pattern count and
    // sample capacity, not of how many URLs went past.
    expect(retainedMb).toBeLessThan(256);
  }, 600_000);

  it("does not grow with URL count", async () => {
    const half = files.slice(0, Math.max(1, Math.floor(files.length / 2)));

    const partial = accumulator();
    const whole = accumulator();

    await parseAll(partial, half);
    await parseAll(whole, files);

    // Twice the URLs over the same families: retained state barely moves,
    // because the heaps are already at capacity and no new patterns appeared.
    expect(whole.estimatedBytes()).toBeLessThan(partial.estimatedBytes() * 2);
  }, 600_000);

  /**
   * The corpus is built so this fails loudly if arity-keyed parameterisation
   * regresses to the legacy global-index behaviour: 300 distinct top-level
   * sections would tip position 0 over the threshold and collapse the whole
   * site into one `/{param}/...` pattern.
   */
  it("keeps distinct URL families apart", async () => {
    const acc = accumulator();

    await parseAll(acc, files);

    const templates = acc.result().patterns.map((p) => p.template);

    expect(templates).toContain("/part/{param}");
    expect(templates).toContain("/legacy/discontinued/{param}");
    expect(templates).not.toContain("/{param}");
    // A handful of families, not one mega-pattern and not thousands of literals.
    expect(templates.length).toBeGreaterThan(3);
    expect(templates.length).toBeLessThan(2_000);
  }, 600_000);

  /**
   * M2's other acceptance criterion: a run killed mid-parse and resumed at the
   * next unparsed file produces IDENTICAL output to one that was never
   * interrupted.
   *
   * This is what the min-heap's exact mergeability buys, and the reason a
   * reservoir sample was rejected — a reservoir would make a resumed run
   * quietly disagree with an uninterrupted one, and nothing would reveal which
   * of the two numbers was the real one.
   */
  it("resumes to exactly the same result", async () => {
    const cut = Math.max(1, Math.floor(files.length / 2));

    const uninterrupted = accumulator();

    await parseAll(uninterrupted, files);

    // Crash after `cut` files; a fresh worker picks up the rest and merges.
    const beforeCrash = accumulator();
    const afterResume = accumulator();

    await parseAll(beforeCrash, files.slice(0, cut));
    await parseAll(afterResume, files.slice(cut));
    beforeCrash.merge(afterResume);

    const resumed = beforeCrash.result();
    const straight = uninterrupted.result();

    expect(resumed.totalUrls).toBe(straight.totalUrls);
    expect(resumed.patterns.map((p) => p.template)).toEqual(
      straight.patterns.map((p) => p.template)
    );
    expect(resumed.patterns.map((p) => p.populationCount)).toEqual(
      straight.patterns.map((p) => p.populationCount)
    );

    // Down to the sampled candidates and the threshold, not just the counts.
    for (const [index, pattern] of resumed.patterns.entries()) {
      const expected = straight.patterns[index];

      expect(pattern.sampleThreshold).toBe(expected?.sampleThreshold);
      expect(pattern.sampleCandidates).toEqual(expected?.sampleCandidates);
    }
  }, 900_000);

  it("draws the same sample on a rerun", async () => {
    const first = accumulator();
    const second = accumulator();

    await parseAll(first, files);
    await parseAll(second, files);

    expect(first.result().patterns.map((p) => p.sampleCandidates)).toEqual(
      second.result().patterns.map((p) => p.sampleCandidates)
    );
  }, 900_000);
});
