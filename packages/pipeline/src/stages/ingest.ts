import { Readable } from "node:stream";

import {
  listPatternsByPopulation,
  listSitemapFiles,
  markFileDownloaded,
  recordPatternSample,
  type SitemapFileRow,
  type SiteScope,
  setFileParseStatus,
  updateRunProgress,
  upsertPatternPopulations,
  upsertPatterns
} from "@pattern-aware/database";
import {
  DEFAULT_SAMPLE_BUDGET,
  firstRoundSampleSize,
  type SampleBudget
} from "@pattern-aware/sampling";
import { getConfig } from "@pattern-aware/shared";
import { PatternAccumulator, parseSitemapStream } from "@pattern-aware/sitemap";

import { assertScopeMatchesPayload, type PipelineDeps } from "../deps.js";
import {
  type IngestPayload,
  ingestPayloadSchema,
  parsePayload
} from "../payloads.js";

/**
 * Stage 2: one streaming pass over every file, producing everything at once.
 *
 * This is the stage the whole architecture is built around. A single pass emits
 * population counts, the per-file index, and the sample candidates together —
 * the legacy engine needed three separate full scans for those three answers,
 * one of which read every `<loc>` of every file because nothing recorded a
 * pattern-to-file index.
 *
 * ONE ACCUMULATOR ACROSS ALL FILES, not one per file. Patterns are a property
 * of the site, not of a file: `/product/{id}` appears in forty files and is one
 * pattern with one population. Accumulating per file and merging afterwards
 * would also work — the min-heap merges exactly — but it would hold forty
 * partial states instead of one.
 */

export interface IngestResult {
  readonly filesParsed: number;
  readonly filesFailed: number;
  readonly totalUrls: number;
  readonly patternCount: number;
  readonly samplesDrawn: number;
  /** True when every file failed, which is a run failure and not an empty site. */
  readonly allFilesFailed: boolean;
}

/** Raised when a run has no files to ingest at all. */
export class NothingToIngestError extends Error {
  public override readonly name = "NothingToIngestError";
}

export async function runIngest(
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<IngestResult> {
  const payload: IngestPayload = parsePayload(
    ingestPayloadSchema,
    "ingest",
    data
  );

  assertScopeMatchesPayload(scope, payload, "ingest");

  const files = await listSitemapFiles(deps.db, scope, payload.sitemapRunId);

  if (files.length === 0) {
    throw new NothingToIngestError(
      `run ${payload.sitemapRunId} has no sitemap files — discovery either did not run or found nothing, and neither is an empty site`
    );
  }

  const budget = sampleBudgetFrom();

  /**
   * Capacity is the EXPANDED ceiling, not the first round's.
   *
   * The first draw is a prefix of what is retained, so an adaptive expansion
   * later is served from what is already in memory rather than by re-reading
   * the sitemap. See ADR-0002.
   */
  const accumulator = new PatternAccumulator({
    sampleCapacity: budget.maxExpanded
  });

  let filesParsed = 0;
  let filesFailed = 0;

  for (const file of files) {
    if (file.parseStatus === "parsed") {
      /**
       * RESUME, at file granularity. An interrupted run picks up here, and the
       * counts already written for this file are in `pattern`/`pattern_population`
       * — which is why `upsertPatterns` is additive rather than overwriting.
       *
       * The pattern TRIE, however, is not resumed: this pass rebuilds it from
       * the files it does read, so a resumed run re-derives templates from a
       * subset. Templates are stable under a subset for the corpus tested, but
       * this is the one place a resume is not byte-identical to a clean run,
       * and it is called out rather than assumed away.
       */
      filesParsed += 1;

      continue;
    }

    try {
      await ingestOneFile(deps, scope, payload, file, accumulator);

      filesParsed += 1;
    } catch (error) {
      filesFailed += 1;

      /**
       * A single bad child does not fail the run. A sitemap index naming 4,000
       * files will sometimes name one that 404s, and abandoning the other 3,999
       * would turn a small defect in the client's sitemap into no audit at all.
       * The failure is recorded per file, counted, and reported.
       */
      deps.logger.warn(
        {
          sitemapRunId: payload.sitemapRunId,
          fileId: file.id,
          fileOrdinal: file.fileOrdinal,
          url: file.url,
          err: error
        },
        "sitemap file failed to ingest; continuing with the rest of the run"
      );

      await setFileParseStatus(deps.db, scope, file.id, "failed", {
        parseError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const allFilesFailed = filesParsed === 0 && filesFailed > 0;

  if (allFilesFailed) {
    /**
     * EVERY file failed. The accumulator is empty, so without this the run
     * would write zero patterns and zero URLs and look exactly like a site
     * that lists nothing.
     */
    deps.logger.error(
      {
        sitemapRunId: payload.sitemapRunId,
        filesFailed
      },
      "every sitemap file failed to ingest — the run has no data, which is a failure and not an empty site"
    );
  }

  const { patterns, totalUrls } = accumulator.result();

  await upsertPatterns(
    deps.db,
    scope,
    payload.sitemapRunId,
    patterns.map((accumulated) => ({
      template: accumulated.template,
      segmentCount: accumulated.segmentCount,
      populationCount: accumulated.populationCount,
      fileCount: accumulated.perFileCounts.size
    }))
  );

  // Read back for the ids: the upsert is additive and reports a count, and the
  // populations and samples below are keyed on the pattern's UUID.
  const stored = await listPatternsByPopulation(
    deps.db,
    scope,
    payload.sitemapRunId,
    Math.max(patterns.length, 1)
  );

  const patternIdByTemplate = new Map(
    stored.map((row) => [row.template, row.id] as const)
  );
  const fileIdByOrdinal = new Map(
    files.map((file) => [file.fileOrdinal, file.id] as const)
  );

  await writePopulations(
    deps,
    scope,
    patterns,
    patternIdByTemplate,
    fileIdByOrdinal
  );

  const samplesDrawn = await drawSamples(
    deps,
    scope,
    payload,
    patterns,
    patternIdByTemplate,
    fileIdByOrdinal,
    budget
  );

  await updateRunProgress(deps.db, scope, payload.sitemapRunId, {
    totalFiles: files.length,
    parsedFiles: filesParsed,
    totalUrls,
    totalPatterns: patterns.length
  });

  deps.logger.info(
    {
      sitemapRunId: payload.sitemapRunId,
      filesParsed,
      filesFailed,
      totalUrls,
      patternCount: patterns.length,
      samplesDrawn,
      heapBytes: accumulator.estimatedBytes()
    },
    "ingest pass complete"
  );

  return {
    filesParsed,
    filesFailed,
    totalUrls,
    patternCount: patterns.length,
    samplesDrawn,
    allFilesFailed
  };
}

/** Download if needed, then stream one file into the shared accumulator. */
async function ingestOneFile(
  deps: PipelineDeps,
  scope: SiteScope,
  payload: IngestPayload,
  file: SitemapFileRow,
  accumulator: PatternAccumulator
): Promise<void> {
  const key = {
    runId: payload.sitemapRunId,
    fileId: file.fileOrdinal
  };

  if (file.storageKey === null) {
    await setFileParseStatus(deps.db, scope, file.id, "downloading");

    const response = await deps.fetchSitemap(file.url);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${file.url} answered ${response.status}`);
    }

    const put = await deps.store.put(key, Readable.from(response.body));

    await markFileDownloaded(deps.db, scope, file.id, {
      storageKey: put.storageKey,
      contentDigest: put.digest,
      byteSize: put.bytes
    });
  }

  await setFileParseStatus(deps.db, scope, file.id, "parsing");

  const source = await deps.store.open(key);

  const result = await parseSitemapStream(
    source,
    { fileId: file.fileOrdinal, isGzip: file.isGzip },
    accumulator,
    { baseUrl: payload.baseUrl, expectedHost: payload.expectedHost }
  );

  if (result.matchedUrls === 0) {
    /**
     * A file that parsed as a sitemap and yielded no usable URLs.
     *
     * `streamLocs` already rejects a document whose root is not a sitemap, so
     * this is the subtler case: a real `<urlset>` that is empty, or one whose
     * every URL points off-host. Both are findings about the client's sitemap
     * rather than parse failures, and neither should look like a file that
     * contributed normally.
     */
    deps.logger.warn(
      {
        sitemapRunId: payload.sitemapRunId,
        fileId: file.id,
        url: file.url,
        foreignUrls: result.foreignUrls,
        unparseableUrls: result.unparseableUrls
      },
      "sitemap file parsed but contributed no URLs on the expected host"
    );
  }

  await setFileParseStatus(deps.db, scope, file.id, "parsed", {
    urlCount: result.matchedUrls
  });
}

/** The per-file index: which files hold each pattern, and how many each holds. */
async function writePopulations(
  deps: PipelineDeps,
  scope: SiteScope,
  patterns: readonly {
    readonly template: string;
    readonly perFileCounts: ReadonlyMap<number, number>;
  }[],
  patternIdByTemplate: ReadonlyMap<string, string>,
  fileIdByOrdinal: ReadonlyMap<number, string>
): Promise<void> {
  const rows: {
    patternId: string;
    sitemapFileId: string;
    urlCount: number;
  }[] = [];

  for (const accumulated of patterns) {
    const patternId = patternIdByTemplate.get(accumulated.template);

    if (patternId === undefined) {
      continue;
    }

    for (const [fileOrdinal, urlCount] of accumulated.perFileCounts) {
      const sitemapFileId = fileIdByOrdinal.get(fileOrdinal);

      if (sitemapFileId === undefined) {
        // A candidate pointing at a file this run does not know about would be
        // unresolvable later, so it is dropped loudly rather than stored.
        deps.logger.warn(
          { template: accumulated.template, fileOrdinal },
          "pattern references a file ordinal with no sitemap_file row; skipping its population row"
        );

        continue;
      }

      rows.push({ patternId, sitemapFileId, urlCount });
    }
  }

  await upsertPatternPopulations(deps.db, scope, rows);
}

/**
 * Record each pattern's first-round draw and hand it to verification.
 *
 * The draw itself already happened during the parse — the accumulator's
 * min-heap retained the K smallest hashes as URLs streamed past. What happens
 * here is choosing how much of that retained set the first round actually
 * probes, which is a budget decision rather than a sampling one.
 */
async function drawSamples(
  deps: PipelineDeps,
  scope: SiteScope,
  payload: IngestPayload,
  patterns: readonly {
    readonly template: string;
    readonly populationCount: number;
    readonly sampleCandidates: readonly {
      readonly hash: number;
      readonly fileId: number;
      readonly ordinal: number;
    }[];
    readonly sampleThreshold: number;
  }[],
  patternIdByTemplate: ReadonlyMap<string, string>,
  fileIdByOrdinal: ReadonlyMap<number, string>,
  budget: SampleBudget
): Promise<number> {
  let drawn = 0;

  for (const accumulated of patterns) {
    const patternId = patternIdByTemplate.get(accumulated.template);

    if (patternId === undefined) {
      continue;
    }

    const plannedSampleSize = firstRoundSampleSize(
      accumulated.populationCount,
      budget
    );

    /**
     * The first round takes a PREFIX of the retained candidates.
     *
     * Valid because the heap yields them in selection order — smallest hash
     * first — so a prefix is exactly the sample a smaller K would have drawn,
     * and growing the round later is provably a superset rather than a new
     * draw. See ADR-0002.
     */
    const candidates = accumulated.sampleCandidates
      .slice(0, plannedSampleSize)
      .filter((candidate) => fileIdByOrdinal.has(candidate.fileId));

    if (candidates.length === 0) {
      continue;
    }

    const sample = await recordPatternSample(deps.db, scope, {
      patternId,
      sitemapRunId: payload.sitemapRunId,
      kRequested: plannedSampleSize,
      kThresholdHash: accumulated.sampleThreshold,
      sampleSize: candidates.length,
      populationAtDraw: accumulated.populationCount
    });

    await deps.enqueue("verify", {
      siteId: payload.siteId,
      sitemapRunId: payload.sitemapRunId,
      patternId,
      patternSampleId: sample.id,
      baseUrl: payload.baseUrl,
      expectedHost: payload.expectedHost,
      candidates: candidates.map((candidate) => ({ ...candidate })),
      /**
       * The PLANNED size, not `candidates.length`. The escalation cap is
       * budgeted against the plan (ADR-0015), and passing the delivered count
       * instead would re-grant budget whenever fewer candidates than planned
       * were resolvable.
       */
      plannedSampleSize: Math.max(plannedSampleSize, candidates.length),
      fileIds: [...new Set(candidates.map((candidate) => candidate.fileId))]
    });

    drawn += 1;
  }

  return drawn;
}

/**
 * The sampling budget, from the config validated once at startup.
 *
 * Read through `getConfig` rather than from `process.env`, and assembled here
 * rather than at each call site so every stage samples to the same budget. The
 * `sampleRate` has no env override yet, so it comes from the package default.
 */
function sampleBudgetFrom(): SampleBudget {
  const config = getConfig();

  return {
    sampleRate: DEFAULT_SAMPLE_BUDGET.sampleRate,
    minSample: config.SAMPLE_MIN_SIZE,
    maxFirstRound: config.SAMPLE_MAX_FIRST_ROUND,
    maxExpanded: config.SAMPLE_MAX_EXPANDED,
    maxExpansionFactor: config.SAMPLE_MAX_EXPANSION_FACTOR,
    maxPopulationFraction: config.SAMPLE_MAX_POPULATION_FRACTION,
    minPerStratum: config.SAMPLE_MIN_PER_STRATUM
  };
}
