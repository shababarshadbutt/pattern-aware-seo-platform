import { Readable } from "node:stream";

import {
  finishRun,
  listPatternsByPopulation,
  listSitemapFiles,
  markFileDownloaded,
  recordPatternSample,
  type SitemapFileRow,
  type SiteScope,
  setFileParseStatus,
  setPatternStatus,
  updateRunProgress,
  upsertPatternPopulations,
  upsertPatterns,
  upsertSitemapFiles
} from "@pattern-aware/database";
import {
  DEFAULT_SAMPLE_BUDGET,
  firstRoundSampleSize,
  type SampleBudget
} from "@pattern-aware/sampling";
import {
  assessSize,
  DEFAULT_OVERSIZE_THRESHOLDS,
  PatternAccumulator,
  parseSitemapStream,
  streamLocs
} from "@pattern-aware/sitemap";

import { assertScopeMatchesPayload, type PipelineDeps } from "../deps.js";
import { sniffGzip } from "../gzip-sniff.js";
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
  /**
   * Set when the run stopped early because it hit a configured oversize
   * limit (Phase 2A: the file-count hard limit only). The run itself is
   * marked `degraded` with this as its `statusReason` — surfaced here too so
   * a direct caller (tests, a benchmark harness) does not have to re-read the
   * run row just to see whether this happened.
   */
  readonly oversizeStopReason?: string;
}

/** Raised when a run has no files to ingest at all. */
export class NothingToIngestError extends Error {
  public override readonly name = "NothingToIngestError";
}

/**
 * Raised when a run's aggregates already exist and would be double-counted.
 *
 * `upsertPatterns` adds to whatever is already recorded, so running the pass
 * twice over the same corpus doubles every population. Refusing is right: the
 * numbers are already there and correct, and a second pass has nothing to add.
 */
export class IngestAlreadyAggregatedError extends Error {
  public override readonly name = "IngestAlreadyAggregatedError";
}

/** What one file turned out to be, once its bytes were actually read. */
type IngestOneFileOutcome =
  | { readonly kind: "parsed" }
  /**
   * The file was itself a nested `<sitemapindex>`, not page content. Its
   * children are returned rather than registered here, because deciding
   * whether they fit under the run's file-count limit is `runIngest`'s job —
   * it is the one holding the running total and the queue they would join.
   */
  | { readonly kind: "index"; readonly children: readonly string[] };

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

  const initialFiles = await listSitemapFiles(
    deps.db,
    scope,
    payload.sitemapRunId
  );

  if (initialFiles.length === 0) {
    throw new NothingToIngestError(
      `run ${payload.sitemapRunId} has no sitemap files — discovery either did not run or found nothing, and neither is an empty site`
    );
  }

  /**
   * AGGREGATION IS ALL-OR-NOTHING FOR ONE PASS, and these two guards are what
   * make that true. Getting it wrong is a silent population undercount.
   *
   * `upsertPatterns` is additive because it was written for a parse that
   * flushes each file's contribution as it goes. This pass does not: the
   * pattern trie is site-wide, so templates are only final once every file has
   * been seen, and the aggregates are therefore written once at the end.
   *
   * That leaves a window. A pass that died after marking some files `parsed`
   * but before writing aggregates would, on retry, SKIP those files — their
   * URLs would be missing from the trie and from every count, and the run would
   * finish looking perfectly clean with a smaller population. So:
   *
   *   - if aggregates already exist, this pass has nothing to add and adding
   *     anyway would double every count: refuse;
   *   - if files are marked parsed but aggregates do not exist, a previous
   *     attempt died in that window: put them back to `pending` so this pass
   *     reads the whole corpus.
   *
   * The cost is that a crashed ingest re-parses every file rather than
   * resuming mid-list. The files are already downloaded — `storage_key` is
   * set — so this is a re-read from the store, not a re-fetch from the client's
   * server. File-granularity resume still holds for the expensive half.
   */
  const alreadyAggregated = await listPatternsByPopulation(
    deps.db,
    scope,
    payload.sitemapRunId,
    1
  );

  if (alreadyAggregated.length > 0) {
    throw new IngestAlreadyAggregatedError(
      `run ${payload.sitemapRunId} already has pattern aggregates; re-running ingest would add to them and double every population`
    );
  }

  const staleParsed = initialFiles.filter(
    (file) => file.parseStatus === "parsed"
  );

  if (staleParsed.length > 0) {
    deps.logger.warn(
      {
        sitemapRunId: payload.sitemapRunId,
        files: staleParsed.length
      },
      "files were marked parsed but the run has no aggregates; a previous pass died before writing them, so they are being re-parsed rather than skipped"
    );

    for (const file of staleParsed) {
      await setFileParseStatus(deps.db, scope, file.id, "pending");
    }
  }

  const budget = deps.sampleBudget ?? DEFAULT_SAMPLE_BUDGET;
  const thresholds = deps.oversizeThresholds ?? DEFAULT_OVERSIZE_THRESHOLDS;

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

  /**
   * A MUTABLE WORK QUEUE, not the fixed list discovery produced.
   *
   * Discovery only ever lists an index's children as URLs — it never
   * downloads them, so it cannot know whether a child is itself a nested
   * `<sitemapindex>` rather than a leaf `<urlset>`. That is only knowable once
   * this stage actually opens the file, which is why the queue can grow
   * mid-pass: a child that turns out to be another index has ITS children
   * appended here, so a third or fourth nesting level is handled by this same
   * loop reaching its turn rather than by explicit recursion.
   */
  const queue: SitemapFileRow[] = [...initialFiles];
  const queuedFileIds = new Set(queue.map((file) => file.id));
  let nextOrdinal =
    Math.max(0, ...initialFiles.map((file) => file.fileOrdinal)) + 1;

  let filesParsed = 0;
  let filesFailed = 0;
  const staleIds = new Set(staleParsed.map((file) => file.id));

  let oversizeStopReason: string | undefined;

  /**
   * `for...of` OVER A GROWING ARRAY, deliberately: the array iterator
   * protocol re-reads `queue.length` on every step, so an element pushed
   * during this loop (A1's nested-index expansion, below) is visited in its
   * own later turn without any manual index bookkeeping.
   */
  for (const raw of queue) {
    // The reset above changed rows this list was read before, so the status is
    // corrected here rather than re-querying the whole list.
    const file = staleIds.has(raw.id)
      ? { ...raw, parseStatus: "pending" as const }
      : raw;

    if (file.parseStatus === "parsed") {
      /**
       * Only reachable if the reset above did not apply, which it always does
       * when aggregates are missing. Left as a guard rather than removed: a
       * file counted here contributed nothing to this pass's accumulator, so
       * counting it as parsed is only honest because its aggregates are known
       * to be durable.
       */
      filesParsed += 1;

      continue;
    }

    try {
      const outcome = await ingestOneFile(
        deps,
        scope,
        payload,
        file,
        accumulator
      );

      if (outcome.kind === "index") {
        // Deduped up front: an index naming the same child sitemap twice
        // should not claim two ordinals or be counted twice against the
        // file-count limit below.
        const children = [...new Set(outcome.children)];
        const wouldTotalFiles = queue.length + children.length;
        const verdict = assessSize(
          { totalUrls: accumulator.totalUrls, totalFiles: wouldTotalFiles },
          thresholds
        );

        if (
          verdict.kind === "stop" &&
          verdict.reason === "OVERSIZE_HARD_LIMIT_FILES"
        ) {
          /**
           * Registering even one of this index's children would put the run
           * over its configured file-count limit. NONE are registered — a
           * partial expansion would be an arbitrary subset of whatever order
           * the index happened to list them in, which is not a meaningfully
           * different outcome from "none", so there is nothing to gain by
           * making the boundary anything other than all-or-nothing here.
           */
          await setFileParseStatus(deps.db, scope, file.id, "skipped", {
            parseError: `NESTED_SITEMAP_INDEX_OVER_LIMIT: names ${children.length} child file${children.length === 1 ? "" : "s"}, which would bring this run to ${wouldTotalFiles} files against a configured hard limit of ${thresholds.hardLimitFiles}; none were registered`
          });

          deps.logger.warn(
            {
              sitemapRunId: payload.sitemapRunId,
              fileId: file.id,
              namedChildren: children.length,
              wouldTotalFiles,
              hardLimitFiles: thresholds.hardLimitFiles
            },
            "nested sitemap index would push this run's file count past the configured hard limit; stopping rather than registering its children"
          );

          oversizeStopReason = verdict.reason;
          filesParsed += 1;

          break;
        }

        /**
         * NEVER `parsed` with `urlCount: 0` — that is indistinguishable from a
         * leaf file that genuinely lists nothing (see the `matchedUrls === 0`
         * warning below). `skipped` says plainly that this row is a structural
         * node, not a page-URL source, and carries how many children it named.
         */
        await setFileParseStatus(deps.db, scope, file.id, "skipped", {
          parseError: `NESTED_SITEMAP_INDEX: expanded into ${children.length} child file${children.length === 1 ? "" : "s"}`
        });

        const childRegistrations: {
          readonly url: string;
          readonly fileOrdinal: number;
          readonly isGzip: boolean;
        }[] = [];

        for (const child of children) {
          childRegistrations.push({
            url: child,
            fileOrdinal: nextOrdinal,
            // Still a SUFFIX GUESS, exactly like discover.ts's own
            // registration of an entry index's children — there are no bytes
            // to sniff until `ingestOneFile` downloads this child in its own
            // turn.
            isGzip: child.endsWith(".gz")
          });

          nextOrdinal += 1;
        }

        /**
         * `upsertSitemapFiles` RETURNS EVERY FILE IN THE RUN, not just the
         * ones this call inserted (it is built to hand discovery back its
         * whole list in one round trip). Taking the first element here would
         * silently grab whatever file already has the lowest ordinal in the
         * run — already fully processed — and push it back onto the queue
         * instead of this index's actual children, which turns into an
         * infinite loop (confirmed while writing this: every iteration
         * re-registered nothing new, pushed a duplicate of file 1, and
         * `queue.length` grew in lockstep with the loop forever). Matched by
         * URL below instead, which is stable across `onConflictDoNothing`
         * too — if a second index elsewhere in the chain already named this
         * same child, the row returned is whichever ordinal actually won the
         * insert, not whatever this call asked for.
         */
        const allFiles = await upsertSitemapFiles(
          deps.db,
          scope,
          payload.sitemapRunId,
          childRegistrations
        );

        const byUrl = new Map(allFiles.map((row) => [row.url, row] as const));

        for (const child of children) {
          const row = byUrl.get(child);

          // Guards against a second index elsewhere in the chain naming a
          // URL this run already registered: `onConflictDoNothing` collapses
          // the DB row to one, but without this check that one row would
          // still be pushed onto the queue a second time and parsed twice,
          // doubling its contribution to the population.
          if (row !== undefined && !queuedFileIds.has(row.id)) {
            queuedFileIds.add(row.id);
            queue.push(row);
          }
        }
      }

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

    // Reported per file, not per byte: a site's files vary wildly in size, so
    // "files done" is the only unit that stays meaningful across all of them.
    // `queue.length` is read fresh each time because it can have grown since
    // the loop started (A1's nested-index flattening).
    await deps.reportProgress?.((filesParsed + filesFailed) / queue.length);

    if (oversizeStopReason === undefined) {
      const verdict = assessSize(
        { totalUrls: accumulator.totalUrls, totalFiles: queue.length },
        thresholds
      );

      if (
        verdict.kind === "stop" &&
        verdict.reason === "OVERSIZE_HARD_LIMIT_FILES"
      ) {
        deps.logger.warn(
          {
            sitemapRunId: payload.sitemapRunId,
            totalFiles: queue.length,
            hardLimitFiles: thresholds.hardLimitFiles
          },
          "sitemap file count exceeded the configured hard limit; stopping ingestion and flagging the run rather than continuing to discover or parse further files"
        );

        oversizeStopReason = verdict.reason;
      }
    }

    if (oversizeStopReason !== undefined) {
      // Whatever is left in `queue` past this point stays `pending` — an
      // honest signal that discovery found more than this run chose to
      // process, rather than looking identical to a run that read everything.
      break;
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
  // Keyed from the FINAL, post-flattening queue, so a candidate pointing at a
  // nested index's child resolves correctly even though that file did not
  // exist when this run started.
  const fileIdByOrdinal = new Map(
    queue.map((file) => [file.fileOrdinal, file.id] as const)
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
    totalFiles: queue.length,
    parsedFiles: filesParsed,
    totalUrls,
    totalPatterns: patterns.length
  });

  if (oversizeStopReason !== undefined) {
    /**
     * TERMINAL, same pattern `discover.ts` uses for `SUSPICIOUSLY_EMPTY_INDEX`.
     * Whatever was found before the limit hit is real and already written
     * above — patterns, populations, and any samples they drew proceed to
     * verification normally. This call only stamps the run itself as
     * `degraded` so nothing reading it later mistakes an intentionally
     * truncated file discovery for a complete one. `finishRun` is guarded on
     * `status = 'running'`, so if some other path already closed this run out
     * this quietly does nothing rather than overwriting a real outcome.
     */
    await finishRun(deps.db, scope, payload.sitemapRunId, {
      status: "degraded",
      statusReason: oversizeStopReason
    });
  }

  /**
   * THE FAN-IN'S OTHER HALF: a run that drew no samples at all never enqueues
   * a single `verify`/`estimate` job, so nothing downstream would ever notice
   * it is done. Every pattern that DOES get sampled reaches a terminal status
   * eventually and triggers `checkRunCompletion` itself (from `verify`'s
   * unresolvable path or from `estimate`) — but a site with zero patterns, or
   * one where every pattern lacked resolvable candidates, has no such
   * trigger. `finalize` is enqueued directly here for exactly that case.
   */
  if (samplesDrawn === 0) {
    await deps.enqueue("finalize", {
      siteId: payload.siteId,
      sitemapRunId: payload.sitemapRunId
    });
  }

  deps.logger.info(
    {
      sitemapRunId: payload.sitemapRunId,
      filesParsed,
      filesFailed,
      totalUrls,
      patternCount: patterns.length,
      samplesDrawn,
      oversizeStopReason,
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
    allFilesFailed,
    ...(oversizeStopReason === undefined ? {} : { oversizeStopReason })
  };
}

/**
 * Which kind of document is this, at the cost of one element?
 *
 * The same technique `discover.ts`'s own `detectRootElement` uses for the
 * entry document, applied here to every file this stage is about to parse.
 * Stops at the first `<loc>`, so learning that a file is itself a nested
 * index does not read the whole thing — and critically, it happens BEFORE any
 * `<loc>` reaches `LocObserver`: passing `includeIndexLocs: true` straight
 * into the real parse and sorting index-locs from page-locs afterward would
 * feed a nested index's own child sitemap URLs into pattern extraction as
 * though they were pages, corrupting the population with entries that are not
 * URLs this site actually serves.
 */
async function peekRootElement(
  deps: PipelineDeps,
  key: { readonly runId: string; readonly fileId: number },
  isGzip: boolean
): Promise<"urlset" | "sitemapindex" | "unknown"> {
  const source = await deps.store.open(key);

  const result = await streamLocs(source, () => false, {
    includeIndexLocs: true,
    isGzip
  });

  return result.rootElement;
}

/** Every child sitemap URL a nested index names, mirroring discover.ts's own `readIndexChildren`. */
async function readNestedIndexChildren(
  deps: PipelineDeps,
  key: { readonly runId: string; readonly fileId: number },
  isGzip: boolean
): Promise<readonly string[]> {
  const source = await deps.store.open(key);
  const children: string[] = [];

  await streamLocs(
    source,
    (loc) => {
      children.push(loc);
    },
    { includeIndexLocs: true, isGzip }
  );

  return children;
}

/** Download if needed, then either stream one file into the shared accumulator or report it as a nested index. */
async function ingestOneFile(
  deps: PipelineDeps,
  scope: SiteScope,
  payload: IngestPayload,
  file: SitemapFileRow,
  accumulator: PatternAccumulator
): Promise<IngestOneFileOutcome> {
  const key = {
    runId: payload.sitemapRunId,
    fileId: file.fileOrdinal
  };

  // Corrected below from the actual bytes on a fresh download; a file already
  // on disk from an earlier attempt keeps whatever `is_gzip` that pass wrote.
  let isGzip = file.isGzip;

  if (file.storageKey === null) {
    await setFileParseStatus(deps.db, scope, file.id, "downloading");

    const response = await deps.fetchSitemap(file.url);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${file.url} answered ${response.status}`);
    }

    const put = await deps.store.put(key, Readable.from(response.body));

    /**
     * SNIFFED, NOT GUESSED. `upsertSitemapFiles` registered this child from
     * its URL suffix alone — there were no bytes yet — and a server that
     * compresses its XML on the wire regardless of the URL's extension would
     * leave that guess wrong. Now that the bytes are actually on disk, the
     * magic number settles it, and the correction is persisted so a later
     * resolution of a sample candidate against this same file (`verify`,
     * days later) reads the true value too.
     */
    isGzip = await sniffGzip(await deps.store.open(key));

    await markFileDownloaded(deps.db, scope, file.id, {
      storageKey: put.storageKey,
      contentDigest: put.digest,
      byteSize: put.bytes,
      isGzip
    });
  }

  await setFileParseStatus(deps.db, scope, file.id, "parsing");

  const rootElement = await peekRootElement(deps, key, isGzip);

  if (rootElement === "sitemapindex") {
    const children = await readNestedIndexChildren(deps, key, isGzip);

    return { kind: "index", children };
  }

  const source = await deps.store.open(key);

  const result = await parseSitemapStream(
    source,
    { fileId: file.fileOrdinal, isGzip },
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

  return { kind: "parsed" };
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
      /**
       * A TERMINAL STATUS, not silence. Left at `unsampled` this pattern would
       * never get a `verify` job and therefore never reach `measured`,
       * `blocked` or `needs_review` — and the fan-in in `estimate`/`verify`
       * that decides "has this run finished" counts exactly those three
       * statuses against `patterns_to_verify`. An unsampled pattern nobody
       * ever marks done is a run that never finalizes.
       */
      await setPatternStatus(
        deps.db,
        scope,
        patternId,
        "needs_review",
        "NO_RESOLVABLE_CANDIDATES"
      );

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
