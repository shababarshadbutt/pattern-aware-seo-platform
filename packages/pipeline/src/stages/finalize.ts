import {
  countPatternsByStatus,
  finishRun,
  listSitemapFiles,
  listSnapshotsByImpact,
  type SiteScope,
  upsertSamplingHealth
} from "@pattern-aware/database";

import { assertScopeMatchesPayload, type PipelineDeps } from "../deps.js";
import {
  type FinalizePayload,
  finalizePayloadSchema,
  parsePayload
} from "../payloads.js";

/**
 * Stage 5: close the run and say honestly how it went.
 *
 * The stage that stops a run from "completing" merely because nothing threw.
 * A run that parsed no files, measured no patterns, or measured them all at low
 * confidence has produced numbers nobody should act on, and the difference
 * between that and a healthy run has to be recorded as data rather than
 * inferred later by whoever happens to read the logs.
 */

export interface FinalizeResult {
  readonly status: "complete" | "degraded";
  readonly reason: string | undefined;
  readonly patternsTotal: number;
  readonly patternsMeasured: number;
  readonly patternsBlocked: number;
  readonly patternsNeedsReview: number;
  readonly patternsLowConfidence: number;
}

/**
 * Above this share of low-confidence patterns a run is degraded rather than
 * complete.
 *
 * Matches the SLI's paging threshold: past a quarter of patterns too wide to
 * act on, the run's output is not something to publish without saying so.
 */
const DEGRADED_LOW_CONFIDENCE_SHARE = 0.25;

export async function runFinalize(
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<FinalizeResult> {
  const payload: FinalizePayload = parsePayload(
    finalizePayloadSchema,
    "finalize",
    data
  );

  assertScopeMatchesPayload(scope, payload, "finalize");

  const counts = await countPatternsByStatus(
    deps.db,
    scope,
    payload.sitemapRunId
  );

  const byStatus = new Map(
    counts.map((entry) => [entry.status, entry.count] as const)
  );

  const patternsTotal = counts.reduce((total, entry) => total + entry.count, 0);
  const patternsMeasured = byStatus.get("measured") ?? 0;
  const patternsBlocked = byStatus.get("blocked") ?? 0;
  const patternsNeedsReview = byStatus.get("needs_review") ?? 0;

  const snapshots = await listSnapshotsByImpact(deps.db, scope, {
    sitemapRunId: payload.sitemapRunId,
    // Enough to characterise the run's confidence profile without reading a
    // fleet-sized result set into memory.
    limit: 5_000
  });

  const patternsLowConfidence = new Set(
    snapshots
      .filter((snapshot) => snapshot.confidenceBand === "low")
      .map((snapshot) => snapshot.patternId)
  ).size;

  const files = await listSitemapFiles(deps.db, scope, payload.sitemapRunId);
  const filesFailed = files.filter(
    (file) => file.parseStatus === "failed"
  ).length;

  const { status, reason } = judgeRun({
    patternsTotal,
    patternsMeasured,
    patternsLowConfidence,
    filesTotal: files.length,
    filesFailed
  });

  await upsertSamplingHealth(deps.db, scope, {
    sitemapRunId: payload.sitemapRunId,
    // The window is the run itself: a run is the unit these figures describe,
    // and a clock-aligned window would split one run across two rows.
    windowStart: earliestCreatedAt(files) ?? new Date(),
    windowEnd: new Date(),
    patternsTotal,
    patternsLowConfidence,
    patternsBlocked,
    patternsNeedsReview,
    samplesDrawn: patternsMeasured + patternsNeedsReview + patternsBlocked,
    httpRequests: 0,
    getEscalations: 0,
    circuitBreaks: 0
  });

  /**
   * `finishRun`'s outcome is a union that REQUIRES a reason for a degraded run,
   * so a degradation cannot be recorded without saying why. `judgeRun` only
   * ever returns an undefined reason alongside "complete", so the narrowing
   * below is exhaustive rather than defensive — and if that ever stops being
   * true, this stops compiling instead of writing a reasonless degradation.
   */
  await finishRun(
    deps.db,
    scope,
    payload.sitemapRunId,
    reason === undefined
      ? { status: "complete" }
      : { status: "degraded", statusReason: reason }
  );

  const log = status === "degraded" ? deps.logger.warn : deps.logger.info;

  log.call(
    deps.logger,
    {
      sitemapRunId: payload.sitemapRunId,
      status,
      reason,
      patternsTotal,
      patternsMeasured,
      patternsBlocked,
      patternsNeedsReview,
      patternsLowConfidence,
      filesTotal: files.length,
      filesFailed
    },
    "run finalised"
  );

  return {
    status,
    reason,
    patternsTotal,
    patternsMeasured,
    patternsBlocked,
    patternsNeedsReview,
    patternsLowConfidence
  };
}

/**
 * Decide whether this run's output is safe to present as a complete audit.
 *
 * Ordered most-severe first, and every branch names its reason in a
 * machine-readable form so the interface can explain a degraded run rather
 * than just colouring it.
 */
function judgeRun(input: {
  readonly patternsTotal: number;
  readonly patternsMeasured: number;
  readonly patternsLowConfidence: number;
  readonly filesTotal: number;
  readonly filesFailed: number;
}): { status: "complete" | "degraded"; reason: string | undefined } {
  if (input.filesTotal > 0 && input.filesFailed === input.filesTotal) {
    return { status: "degraded", reason: "ALL_FILES_FAILED" };
  }

  if (input.patternsTotal === 0) {
    /**
     * No patterns at all from a run that got this far. Either every file was
     * empty or the sitemap listed nothing usable — both are findings about the
     * client's sitemap, and neither is a complete audit.
     */
    return { status: "degraded", reason: "NO_PATTERNS_FOUND" };
  }

  if (input.patternsMeasured === 0) {
    return { status: "degraded", reason: "NOTHING_MEASURED" };
  }

  if (
    input.patternsLowConfidence / input.patternsTotal >
    DEGRADED_LOW_CONFIDENCE_SHARE
  ) {
    return { status: "degraded", reason: "LOW_CONFIDENCE_MAJORITY" };
  }

  if (input.filesFailed > 0) {
    // Partial coverage: the numbers are real but they are not about the whole
    // site, and presenting them as if they were would overstate the audit.
    return { status: "degraded", reason: "SOME_FILES_FAILED" };
  }

  return { status: "complete", reason: undefined };
}

function earliestCreatedAt(
  files: readonly { readonly createdAt: Date }[]
): Date | undefined {
  let earliest: Date | undefined;

  for (const file of files) {
    if (earliest === undefined || file.createdAt < earliest) {
      earliest = file.createdAt;
    }
  }

  return earliest;
}
