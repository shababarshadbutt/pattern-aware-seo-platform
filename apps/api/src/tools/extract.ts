import {
  firstRoundSampleSize,
  type SampleBudget
} from "@pattern-aware/sampling";
import {
  LocObserver,
  PARAM_MIN_OBSERVED_URLS,
  PARAM_SEGMENT,
  PARAM_UNIQUE_RATIO_THRESHOLD,
  PARAM_UNIQUE_THRESHOLD,
  PatternAccumulator,
  parseLoc
} from "@pattern-aware/sitemap/extraction";

/**
 * Folding a pasted list of URLs into the same extraction the pipeline runs.
 *
 * Every rule here comes from `@pattern-aware/sitemap/extraction` — the trie,
 * the accumulator, `LocObserver`'s loc-to-observation loop, and the min-heap
 * behind the sample draw. Nothing is reimplemented, which is what makes this a
 * demonstration of the product rather than a lookalike of it.
 *
 * What this module owns is the part the pipeline never has to think about: a
 * sitemap arrives with a known site attached, and a paste does not.
 */

/** RFC 2606 reserved, so it can never collide with a host a caller meant. */
const NO_HOST_SENTINEL = "paths.invalid";

/** How many examples of a rejected line are worth showing. */
const SAMPLE_LIMIT = 10;

export interface HostCount {
  readonly host: string;
  readonly count: number;
}

export interface ExtractionPattern {
  readonly template: string;
  readonly segmentCount: number;
  readonly paramCount: number;
  readonly populationCount: number;
  /** What the platform would probe for a pattern this size. */
  readonly plannedSampleSize: number;
  readonly sample: readonly string[];
}

export interface ParameterisationReport {
  readonly minObservedUrls: number;
  readonly uniqueThreshold: number;
  readonly uniqueRatioThreshold: number;
  readonly observedUrls: number;
  /**
   * PROVABLY zero parameterisation, not a guess.
   *
   * Every trie node's `observations` is at most the number of matched URLs, so
   * `observedUrls < PARAM_MIN_OBSERVED_URLS` blocks the ratio rule at every
   * node; and `distinct <= observations <= observedUrls < 30 < 100` blocks the
   * absolute rule too. So below the floor, no path position can parameterise —
   * which is a fact the caller can be told rather than left to infer from an
   * empty-looking result.
   *
   * The converse does NOT hold: the floor is checked PER NODE, so 40 URLs
   * spread across five sections leaves each node at eight and still
   * parameterises nothing. `templatesParameterised` is the weaker signal that
   * covers that case.
   */
  readonly belowFloor: boolean;
  readonly urlsShortOfFloor: number;
  readonly templatesTotal: number;
  readonly templatesParameterised: number;
}

export interface ExtractionOutcome {
  readonly matched: number;
  readonly foreign: number;
  readonly unparseable: number;
}

export interface ExtractionResult {
  readonly host: string;
  readonly hostSource: "supplied" | "derived" | "none";
  readonly hostBreakdown: readonly HostCount[];
  readonly input: {
    readonly submitted: number;
    readonly blank: number;
    readonly analysed: number;
  };
  readonly outcome: ExtractionOutcome;
  readonly foreignSamples: readonly string[];
  readonly unparseableSamples: readonly string[];
  readonly parameterisation: ParameterisationReport;
  readonly patterns: readonly ExtractionPattern[];
}

/**
 * Which host the caller meant, decided by MAJORITY rather than by first sight.
 *
 * Taking the first absolute URL looks equivalent and is not: a list whose first
 * line happens to be a stray CDN or tracking URL would make every one of the
 * remaining lines "foreign", and the tool would report a catastrophic migration
 * bug it had invented itself. The mode is stable under exactly that.
 *
 * The result is reported, never assumed — the response carries `hostSource` and
 * the full breakdown so the reader can see the decision and override it.
 */
function deriveHost(lines: readonly string[]): {
  readonly host: string;
  readonly hostSource: "derived" | "none";
  readonly breakdown: readonly HostCount[];
} {
  const counts = new Map<string, number>();

  for (const line of lines) {
    try {
      const { hostname } = new URL(line);

      if (hostname !== "") {
        const host = hostname.toLowerCase().replace(/^www\./u, "");

        counts.set(host, (counts.get(host) ?? 0) + 1);
      }
    } catch {
      // Not an absolute URL. A bare path carries no host to vote with, which
      // is not an error — it is the all-relative case handled below.
    }
  }

  const breakdown = [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  const winner = breakdown[0];

  return winner === undefined
    ? { host: NO_HOST_SENTINEL, hostSource: "none", breakdown }
    : { host: winner.host, hostSource: "derived", breakdown };
}

/** Non-blank, trimmed lines, in the order they were pasted. */
export function linesOf(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Extract patterns from pasted text.
 *
 * `fileId` is 0 throughout, because the "file" is the paste. That is the whole
 * reason a sampled candidate can be resolved back to a URL here without a file
 * store: the ordinal indexes the caller's own line array.
 */
export function extractPatterns(
  text: string,
  budget: SampleBudget,
  suppliedHost?: string
): ExtractionResult {
  const submitted = text.split(/\r?\n/u).length;
  const lines = linesOf(text);

  const derived = deriveHost(lines);
  const host =
    suppliedHost === undefined
      ? derived.host
      : suppliedHost.toLowerCase().replace(/^www\./u, "");
  const hostSource =
    suppliedHost === undefined ? derived.hostSource : "supplied";

  const accumulator = new PatternAccumulator({
    // The EXPANDED ceiling, not the first-round one: the accumulator's capacity
    // bounds what a later expansion could draw from, and a heap sized to the
    // first round could not serve a second.
    sampleCapacity: budget.maxExpanded
  });

  const observer = new LocObserver(accumulator, {
    baseUrl: `https://${host}/`,
    expectedHost: host,
    fileId: 0
  });

  const foreignSamples: string[] = [];
  const unparseableSamples: string[] = [];

  for (const [ordinal, line] of lines.entries()) {
    /*
     * Classified twice — once here for the examples, once inside the observer
     * for the counts. `parseLoc` is pure and cheap, and the alternative is
     * teaching `LocObserver` to retain samples, which would put a presentation
     * concern inside the loop the pipeline runs over ten million URLs.
     */
    const parsed = parseLoc(line, `https://${host}/`, host);

    if (parsed.kind === "foreign" && foreignSamples.length < SAMPLE_LIMIT) {
      foreignSamples.push(parsed.sourceUrl);
    }

    if (
      parsed.kind === "unparseable" &&
      unparseableSamples.length < SAMPLE_LIMIT
    ) {
      unparseableSamples.push(parsed.sourceUrl);
    }

    observer.observe(line, ordinal);
  }

  const { patterns } = accumulator.result();

  const shaped = patterns
    .map((pattern) => ({
      template: pattern.template,
      segmentCount: pattern.segmentCount,
      paramCount: pattern.template
        .split("/")
        .filter((segment) => segment === PARAM_SEGMENT).length,
      populationCount: pattern.populationCount,
      plannedSampleSize: firstRoundSampleSize(pattern.populationCount, budget),
      /*
       * The heap yields in selection order, so a prefix IS the sample a smaller
       * K would have drawn — ADR-0002's superset property, and the same slice
       * the ingest stage takes. Resolution is a lookup into the pasted lines
       * because the ordinal is a position in them.
       */
      sample: pattern.sampleCandidates
        .slice(0, firstRoundSampleSize(pattern.populationCount, budget))
        .map((candidate) => lines[candidate.ordinal] ?? "")
        .filter((url) => url !== "")
    }))
    .sort(
      (a, b) =>
        b.populationCount - a.populationCount ||
        a.template.localeCompare(b.template)
    );

  const matched = observer.matchedUrls;

  return {
    host,
    hostSource,
    hostBreakdown: derived.breakdown,
    input: {
      submitted,
      blank: submitted - lines.length,
      analysed: lines.length
    },
    outcome: {
      matched,
      foreign: observer.foreignUrls,
      unparseable: observer.unparseableUrls
    },
    foreignSamples,
    unparseableSamples,
    parameterisation: {
      minObservedUrls: PARAM_MIN_OBSERVED_URLS,
      uniqueThreshold: PARAM_UNIQUE_THRESHOLD,
      uniqueRatioThreshold: PARAM_UNIQUE_RATIO_THRESHOLD,
      observedUrls: matched,
      belowFloor: matched < PARAM_MIN_OBSERVED_URLS,
      urlsShortOfFloor: Math.max(0, PARAM_MIN_OBSERVED_URLS - matched),
      templatesTotal: shaped.length,
      templatesParameterised: shaped.filter((pattern) => pattern.paramCount > 0)
        .length
    },
    patterns: shaped
  };
}
