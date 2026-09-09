import {
  appendSampleObservations,
  countObservations,
  listSitemapFiles,
  type SampleObservationInsert,
  type SiteScope,
  setPatternStatus
} from "@pattern-aware/database";
import {
  type ResolvedCandidate,
  resolveCandidates
} from "@pattern-aware/sitemap";
import {
  type PatternVerdict,
  type VerifyPatternResult,
  verifyPattern
} from "@pattern-aware/verification";

import { assertScopeMatchesPayload, type PipelineDeps } from "../deps.js";
import {
  parsePayload,
  type VerifyPayload,
  verifyPayloadSchema
} from "../payloads.js";
import { checkRunCompletion } from "./finalize-trigger.js";

/**
 * Stage 3: resolve one pattern's sample to real URLs and probe them.
 *
 * Two things happen here that cannot happen anywhere else. The candidates are
 * turned back into URLs, which is the only point where a sample can silently
 * become a sample of something else — hence the hash re-check inside
 * `resolveCandidates`. And the probe budget is spent, which is the only point
 * where this system costs somebody else's web server anything.
 */

/**
 * What verification concluded.
 *
 * `unresolvable` is a pipeline-level outcome and NOT one of verification's
 * verdicts, deliberately. Borrowing `needs_review / HEAD_NOT_SUPPORTED` for it
 * would report something about the host when in fact no request was ever sent —
 * a false statement about why a pattern has no number, and the kind of
 * plausible-looking wrong answer that survives review.
 */
export type PatternOutcome =
  | PatternVerdict
  | {
      readonly kind: "unresolvable";
      readonly reason: "SAMPLE_UNRESOLVABLE" | "ALREADY_VERIFIED";
    };

export interface VerifyResult {
  readonly verdict: PatternOutcome;
  readonly probed: number;
  readonly escalated: number;
  readonly requestCount: number;
  readonly observationsWritten: number;
}

export async function runVerify(
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<VerifyResult> {
  const payload: VerifyPayload = parsePayload(
    verifyPayloadSchema,
    "verify",
    data
  );

  assertScopeMatchesPayload(scope, payload, "verify");

  /**
   * REDELIVERY GUARD. BullMQ is at-least-once, not exactly-once: a `verify`
   * job can be handed to a worker again after it already ran to completion —
   * an ack lost right as a process crashed, a stalled-lock reclaim. Re-probing
   * would send the same real HTTP requests at the client's origin a second
   * time, which is exactly the cost this platform's whole design exists to
   * bound. Observations already existing for this draw means a previous
   * attempt already probed and wrote them, so this attempt skips straight to
   * making sure `estimate` still gets enqueued — which is itself a safe
   * no-op if that attempt already did it too (see `insertAuditSnapshot`'s
   * upsert).
   */
  const alreadyObserved = await countObservations(
    deps.db,
    scope,
    payload.patternSampleId
  );

  if (alreadyObserved > 0) {
    deps.logger.info(
      {
        sitemapRunId: payload.sitemapRunId,
        patternId: payload.patternId,
        patternSampleId: payload.patternSampleId,
        alreadyObserved
      },
      "verify job redelivered after observations were already recorded; skipping re-probe"
    );

    await deps.enqueue("estimate", {
      siteId: payload.siteId,
      sitemapRunId: payload.sitemapRunId,
      patternId: payload.patternId,
      patternSampleId: payload.patternSampleId
    });

    return {
      verdict: { kind: "unresolvable", reason: "ALREADY_VERIFIED" },
      probed: 0,
      escalated: 0,
      requestCount: 0,
      observationsWritten: 0
    };
  }

  const files = await listSitemapFiles(deps.db, scope, payload.sitemapRunId);
  const fileByOrdinal = new Map(
    files.map((file) => [file.fileOrdinal, file] as const)
  );

  const resolved = await resolveAll(deps, payload, fileByOrdinal);

  if (resolved.length === 0) {
    /**
     * Nothing resolvable. Not a measurement, and it must not be recorded as
     * one: an empty observation set with a "measured" status would present as a
     * pattern with a zero error rate.
     */
    deps.logger.warn(
      {
        sitemapRunId: payload.sitemapRunId,
        patternId: payload.patternId,
        candidates: payload.candidates.length
      },
      "no sample candidates could be resolved to URLs; pattern left unmeasured"
    );

    await setPatternStatus(
      deps.db,
      scope,
      payload.patternId,
      "needs_review",
      "SAMPLE_UNRESOLVABLE"
    );

    /**
     * THE ONE PATH THAT REACHES A TERMINAL STATUS WITHOUT EVER ENQUEUING
     * `estimate`. Every other way a pattern finishes goes through `estimate`,
     * which runs this same check on its own way out — but this branch returns
     * before that would ever happen, so if this happens to be the run's last
     * unfinished pattern, nothing else would ever notice completion.
     */
    await checkRunCompletion(deps, scope, {
      siteId: payload.siteId,
      sitemapRunId: payload.sitemapRunId
    });

    return {
      verdict: { kind: "unresolvable", reason: "SAMPLE_UNRESOLVABLE" },
      probed: 0,
      escalated: 0,
      requestCount: 0,
      observationsWritten: 0
    };
  }

  const probeStart = performance.now();

  const result = await verifyPattern(
    {
      urls: resolved.map((candidate) => candidate.url),
      plannedSampleSize: payload.plannedSampleSize
    },
    {
      ...(deps.rateLimiter === undefined
        ? {}
        : { rateLimiter: deps.rateLimiter }),
      ...(deps.circuitBreaker === undefined
        ? {}
        : { circuitBreaker: deps.circuitBreaker }),
      ...(deps.probeFetch === undefined ? {} : { fetch: deps.probeFetch })
    }
  );

  deps.onVerifyTelemetry?.({
    kind: "verifyProbe",
    durationMs: performance.now() - probeStart
  });

  const observationsWritten = await recordObservations(
    deps,
    scope,
    payload,
    resolved,
    result,
    fileByOrdinal
  );

  await setPatternStatus(
    deps.db,
    scope,
    payload.patternId,
    patternStatusFor(result.verdict),
    reasonFor(result.verdict)
  );

  deps.logger.info(
    {
      sitemapRunId: payload.sitemapRunId,
      patternId: payload.patternId,
      verdict: result.verdict,
      probed: result.probed,
      escalated: result.escalated,
      requestCount: result.requestCount,
      escalationRate: result.escalationRate,
      // Coverage, not a flag: how much of the 2xx sample actually got a
      // soft-404 sniff before the cap suppressed the rest.
      soft404Sniffed: result.soft404Sniffed,
      soft404Suppressed: result.soft404Suppressed,
      observationsWritten
    },
    "pattern verified"
  );

  /**
   * Estimated even when the verdict is not "measured".
   *
   * A blocked or capped pattern still has to produce a row that says so — the
   * evidence tiers exist precisely to carry "there is no measurement here"
   * through to the interface rather than leaving a gap that reads as healthy.
   */
  await deps.enqueue("estimate", {
    siteId: payload.siteId,
    sitemapRunId: payload.sitemapRunId,
    patternId: payload.patternId,
    patternSampleId: payload.patternSampleId
  });

  return {
    verdict: result.verdict,
    probed: result.probed,
    escalated: result.escalated,
    requestCount: result.requestCount,
    observationsWritten
  };
}

/**
 * Resolve every candidate, one file at a time.
 *
 * Grouped by file because resolution is a read of that file: candidates
 * scattered across three files cost three reads, not one per candidate. A file
 * that cannot be resolved is skipped with its reason logged rather than failing
 * the whole pattern — the rest of the sample is still a sample, just a smaller
 * one, and `plannedSampleSize` keeps the escalation budget honest about that.
 */
async function resolveAll(
  deps: PipelineDeps,
  payload: VerifyPayload,
  fileByOrdinal: ReadonlyMap<number, { readonly isGzip: boolean }>
): Promise<readonly ResolvedCandidate[]> {
  const byFile = new Map<number, VerifyPayload["candidates"]>();

  for (const candidate of payload.candidates) {
    const existing = byFile.get(candidate.fileId) ?? [];

    byFile.set(candidate.fileId, [...existing, candidate]);
  }

  deps.onVerifyTelemetry?.({
    kind: "candidateFileSpread",
    patternId: payload.patternId,
    distinctFiles: byFile.size
  });

  const resolved: ResolvedCandidate[] = [];

  for (const [fileOrdinal, candidates] of byFile) {
    const file = fileByOrdinal.get(fileOrdinal);

    if (file === undefined) {
      deps.logger.warn(
        {
          sitemapRunId: payload.sitemapRunId,
          patternId: payload.patternId,
          fileOrdinal
        },
        "sample references a file ordinal with no sitemap_file row; skipping those candidates"
      );

      continue;
    }

    const resolveStart = performance.now();

    try {
      const fromFile = await resolveCandidates(
        deps.store,
        { runId: payload.sitemapRunId, fileId: fileOrdinal },
        candidates,
        {
          baseUrl: payload.baseUrl,
          expectedHost: payload.expectedHost,
          ...(file.isGzip ? { isGzip: true } : {})
        }
      );

      deps.onVerifyTelemetry?.({
        kind: "resolveCandidates",
        fileOrdinal,
        durationMs: performance.now() - resolveStart
      });

      resolved.push(...fromFile);
    } catch (error) {
      /**
       * Reported even though resolution failed: the file was genuinely opened
       * and streamed (or attempted) before the error surfaced, so the wall
       * time is real cost the benchmark wants to see, not a call that never
       * happened.
       */
      deps.onVerifyTelemetry?.({
        kind: "resolveCandidates",
        fileOrdinal,
        durationMs: performance.now() - resolveStart
      });

      /**
       * A resolution failure is a data-integrity finding, not a transient one:
       * it means the file's URLs have shifted since ingestion, so retrying will
       * fail identically until the site is re-ingested. Logged at error level
       * and skipped rather than thrown, so one changed file does not stall the
       * rest of a run's patterns behind an infinitely retrying job.
       */
      deps.logger.error(
        {
          sitemapRunId: payload.sitemapRunId,
          patternId: payload.patternId,
          fileOrdinal,
          err: error
        },
        "could not resolve sample candidates; the sitemap file has changed since ingestion"
      );
    }
  }

  return resolved;
}

/** Write one row per probe actually made. */
async function recordObservations(
  deps: PipelineDeps,
  scope: SiteScope,
  payload: VerifyPayload,
  resolved: readonly ResolvedCandidate[],
  result: VerifyPatternResult,
  fileByOrdinal: ReadonlyMap<number, { readonly id: string }>
): Promise<number> {
  const observations: SampleObservationInsert[] = [];

  /**
   * Zipped by index against `resolved`, and `result.results` is deliberately
   * allowed to be SHORTER: verification stops early when a circuit opens or a
   * host turns out not to answer HEAD. Only what was actually probed is
   * recorded, so `n` reflects requests made rather than URLs intended.
   */
  for (const [index, verified] of result.results.entries()) {
    const candidate = resolved[index];

    if (candidate === undefined) {
      continue;
    }

    const source = payload.candidates.find(
      (entry) => entry.ordinal === candidate.ordinal
    );
    const sitemapFileId =
      source === undefined ? undefined : fileByOrdinal.get(source.fileId)?.id;

    observations.push({
      patternId: payload.patternId,
      patternSampleId: payload.patternSampleId,
      ...(sitemapFileId === undefined ? {} : { sitemapFileId }),
      locOrdinal: candidate.ordinal,
      urlHash: candidate.hash,
      url: candidate.url,
      ...(verified.probe.httpStatus === undefined
        ? {}
        : { httpStatus: verified.probe.httpStatus }),
      ...(verified.probe.methodUsed === undefined
        ? {}
        : { methodUsed: verified.probe.methodUsed }),
      escalatedToGet: verified.probe.escalatedToGet,
      isSoft404: verified.probe.soft404?.isSoft404 ?? false,
      ...(verified.probe.errorReason === undefined
        ? {}
        : { errorReason: verified.probe.errorReason }),
      ...(verified.probe.responseMs === undefined
        ? {}
        : { responseMs: verified.probe.responseMs })
    });
  }

  return appendSampleObservations(deps.db, scope, observations);
}

/** A verdict becomes a pattern status, keeping absence distinct from damage. */
function patternStatusFor(
  verdict: PatternOutcome
): "measured" | "blocked" | "needs_review" {
  switch (verdict.kind) {
    case "measured":
      return "measured";
    case "blocked":
      // A host refusing us is never a site defect. See migration 042's
      // reasoning, carried forward.
      return "blocked";
    case "needs_review":
    case "unresolvable":
      return "needs_review";
  }
}

function reasonFor(verdict: PatternOutcome): string | undefined {
  return verdict.kind === "measured" ? undefined : verdict.reason;
}
