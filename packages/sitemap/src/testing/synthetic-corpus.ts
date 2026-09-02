import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Generate a sitemap set large enough to test the claims M2 makes.
 *
 * The scale criteria — one pass, flat memory at ten million URLs — cannot be
 * checked against a real client site: nobody wants a benchmark that depends on
 * somebody else's production server being up, and pointing one at a 40M-URL
 * site to test a parser would be rude at best. So the corpus is generated, and
 * generated deterministically from a seed, because a benchmark whose input
 * changes between runs cannot show a regression.
 *
 * It is not uniform filler. The shapes here are the ones the extraction logic
 * has to get right, and each exists to make a specific failure visible:
 *
 *   - a huge high-cardinality family, which must collapse to one pattern;
 *   - many low-cardinality sections, which must NOT be collapsed into each
 *     other (the over-collapse failure that arity-keyed trackers prevent);
 *   - paths of several different lengths, so one shape cannot drag another;
 *   - a small "broken" family salted through a large one, which is the case
 *     stratified sampling exists to catch and a flat sample would miss;
 *   - static pages, query strings, and gzipped files, because real sitemaps
 *     have all three.
 *
 * Lives in the package rather than in scripts/ because the scale benchmark
 * imports it, and a test may not import from outside its own compilation root.
 * The CLI in scripts/ is a thin shell over this.
 */

export interface SyntheticCorpusOptions {
  readonly outDir: string;
  readonly totalUrls: number;
  readonly urlsPerFile: number;
  readonly seed: number;
  readonly gzipRatio: number;
  readonly baseUrl: string;
}

export const SYNTHETIC_CORPUS_DEFAULTS: SyntheticCorpusOptions = {
  outDir: ".tmp/sitemaps",
  totalUrls: 100_000,
  // 50,000 is the sitemap protocol's own per-file limit, so real files cluster
  // just under it.
  urlsPerFile: 50_000,
  seed: 1,
  gzipRatio: 0.25,
  baseUrl: "https://synthetic.test"
};

/**
 * A linear congruential generator, not Math.random().
 *
 * The point of this whole script is reproducibility: the same seed must produce
 * byte-identical files, or a benchmark cannot distinguish a code regression
 * from a different corpus. The constants are the Numerical Recipes ones.
 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;

    return state / 0x1_0000_0000;
  };
}

export function parseCorpusArgs(
  args: readonly string[]
): SyntheticCorpusOptions {
  const options: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg?.startsWith("--") === true) {
      options[arg.slice(2)] = args[index + 1] ?? "";
      index += 1;
    }
  }

  /**
   * Rejects a non-numeric value rather than yielding NaN.
   *
   * `--urls abc` silently produced an empty corpus: `while (written < NaN)`
   * never runs, the generator reports success, and the benchmark then measures
   * parsing nothing at all. A benchmark that quietly measures the wrong thing
   * is worse than one that fails.
   */
  const number = (key: string, fallback: number): number => {
    const raw = options[key];

    if (raw === undefined || raw === "") {
      return fallback;
    }

    const parsed = Number(raw);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new TypeError(
        `--${key} must be a positive number, got ${JSON.stringify(raw)}`
      );
    }

    return parsed;
  };

  return {
    outDir: options["out"] ?? SYNTHETIC_CORPUS_DEFAULTS.outDir,
    totalUrls: number("urls", SYNTHETIC_CORPUS_DEFAULTS.totalUrls),
    urlsPerFile: number("per-file", SYNTHETIC_CORPUS_DEFAULTS.urlsPerFile),
    seed: number("seed", SYNTHETIC_CORPUS_DEFAULTS.seed),
    gzipRatio: number("gzip-ratio", SYNTHETIC_CORPUS_DEFAULTS.gzipRatio),
    baseUrl: options["base-url"] ?? SYNTHETIC_CORPUS_DEFAULTS.baseUrl
  };
}

/**
 * The URL families, with the share of the corpus each takes.
 *
 * Weights are deliberately lopsided. Real sites are lopsided — one template
 * holds most of the URLs — and a corpus with evenly-sized patterns would hide
 * exactly the case the product exists for: a small error rate on an enormous
 * pattern.
 */
interface Family {
  readonly weight: number;
  readonly build: (index: number, random: () => number) => string;
}

const SECTION_COUNT = 300;
const CATEGORIES = ["tools", "parts", "fasteners", "seals", "bearings"];

const FAMILIES: readonly Family[] = [
  // The dominant family: one pattern, millions of URLs.
  { weight: 0.55, build: (index) => `/part/${100_000 + index}` },
  // Three segments, so a different arity from the one above.
  {
    weight: 0.2,
    build: (index, random) => {
      const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];

      return `/shop/${category}/${index}`;
    }
  },
  /**
   * Many distinct top-level sections. Under the legacy engine's globally-indexed
   * trackers this is what tips position 0 past 100 distinct values and collapses
   * the entire site into `/{param}/...`.
   */
  {
    weight: 0.1,
    build: (index, random) =>
      `/section-${Math.floor(random() * SECTION_COUNT)}/page/${index}`
  },
  // Query strings: same pattern, different URLs.
  {
    weight: 0.08,
    build: (index) => `/search?q=item-${index}&page=${index % 20}`
  },
  /**
   * The needle. A small family salted through a much larger one — this is the
   * sub-pattern a flat sample can miss entirely, and the reason stratification
   * exists. Named so a test can assert on it.
   */
  { weight: 0.02, build: (index) => `/legacy/discontinued/${index}` },
  // Deep paths, to exercise a fourth arity.
  {
    weight: 0.03,
    build: (index, random) => {
      const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];

      return `/catalog/${category}/${index % 500}/detail/${index}`;
    }
  },
  // A handful of static pages that must stay literal, never parameterised.
  {
    weight: 0.02,
    build: (index) => {
      const pages = ["/about", "/contact", "/terms", "/privacy", "/shipping"];

      return pages[index % pages.length] ?? "/about";
    }
  }
];

function buildPath(index: number, random: () => number): string {
  const roll = random();
  let cumulative = 0;

  for (const family of FAMILIES) {
    cumulative += family.weight;

    if (roll <= cumulative) {
      return family.build(index, random);
    }
  }

  return FAMILIES[0]?.build(index, random) ?? `/part/${index}`;
}

function writeUrlsetFile(
  outDir: string,
  fileIndex: number,
  paths: readonly string[],
  baseUrl: string,
  compress: boolean
): string {
  // Assembled as an array and joined once. Repeated string concatenation over
  // 50,000 entries is the one thing in this script that would actually be slow.
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  ];

  for (const path of paths) {
    // & is the only character the generated paths can contain that would break
    // the XML; the rest are already URL-safe.
    lines.push(
      `  <url><loc>${baseUrl}${path.replaceAll("&", "&amp;")}</loc><lastmod>2026-01-01</lastmod></url>`
    );
  }

  lines.push("</urlset>", "");

  const body = lines.join("\n");
  const name = `sitemap-${String(fileIndex).padStart(5, "0")}.xml${compress ? ".gz" : ""}`;

  writeFileSync(
    join(outDir, name),
    compress ? gzipSync(Buffer.from(body)) : body
  );

  return name;
}

function writeIndexFile(
  outDir: string,
  names: readonly string[],
  baseUrl: string
): void {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...names.map(
      (name) => `  <sitemap><loc>${baseUrl}/${name}</loc></sitemap>`
    ),
    "</sitemapindex>",
    ""
  ];

  writeFileSync(join(outDir, "sitemap-index.xml"), lines.join("\n"));
}

export function generateSyntheticCorpus(options: SyntheticCorpusOptions): {
  files: number;
  urls: number;
} {
  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  const random = createRandom(options.seed);
  const names: string[] = [];

  let written = 0;
  let fileIndex = 0;

  while (written < options.totalUrls) {
    const count = Math.min(options.urlsPerFile, options.totalUrls - written);
    const paths: string[] = [];

    for (let index = 0; index < count; index += 1) {
      paths.push(buildPath(written + index, random));
    }

    names.push(
      writeUrlsetFile(
        options.outDir,
        fileIndex,
        paths,
        options.baseUrl,
        random() < options.gzipRatio
      )
    );

    written += count;
    fileIndex += 1;
  }

  writeIndexFile(options.outDir, names, options.baseUrl);

  return { files: fileIndex, urls: written };
}
