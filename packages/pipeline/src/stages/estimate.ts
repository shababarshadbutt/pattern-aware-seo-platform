import {
  type AuditSnapshotInsert,
  findPatternById,
  findPatternSampleById,
  insertAuditSnapshot,
  type ObservationTally,
  type SiteScope,
  tallyObservations
} from "@pattern-aware/database";
import {
  classifyOutcome,
  DEFAULT_CONFIDENCE_LEVEL,
  ESTIMATOR_VERSION,
  estimateStratified,
  measureProportion,
  RATIFIED_SEVERITY_TABLE,
  scoreImpact
} from "@pattern-aware/sampling";

import { assertScopeMatchesPayload, type PipelineDeps } from "../deps.js";
import {
  type EstimatePayload,
  estimatePayloadSchema,
  parsePayload
} from "../payloads.js";

/**
 * Stage 4: turn one pattern's observations into publishable claims.
 *
 * ONE SNAPSHOT ROW PER OUTCOME, not per pattern. "This pattern is 3% broken" is
 * not actionable; "of 40 million URLs on this pattern, an estimated 1.2 million
 * return 404 and 90,000 are soft 404s" is two different findings with two
 * different severities and two different intervals. The row is the unit a
 * person acts on.
 *
 * Nothing here computes statistics itself. The interval comes from
 * packages/sampling and the severity from its ratified table, because a second
 * implementation of either — even an apparently equivalent one — is how two
 * parts of a system start disagreeing about the same number.
 */

export interface EstimateResult {
  readonly snapshotsWritten: number;
  readonly lowConfidenceCount: number;
  /** True when the pattern has no observations at all to estimate from. */
  readonly unmeasured: boolean;
}

export async function runEstimate(
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<EstimateResult> {
  const payload: EstimatePayload = parsePayload(
    estimatePayloadSchema,
    "estimate",
    data
  );

  assertScopeMatchesPayload(scope, payload, "estimate");

  const sample = await findPatternSampleById(
    deps.db,
    scope,
    payload.patternSampleId
  );

  if (sample === undefined) {
    throw new Error(
      `pattern_sample ${payload.patternSampleId} not found in scope ${scope.siteId}`
    );
  }

  const pattern = await findPatternById(deps.db, scope, payload.patternId);

  if (pattern === undefined) {
    throw new Error(
      `pattern ${payload.patternId} not found in scope ${scope.siteId}`
    );
  }

  const tallies = await tallyObservations(
    deps.db,
    scope,
    payload.patternSampleId
  );

  const sampleSize = tallies.reduce((total, tally) => total + tally.count, 0);

  if (sampleSize === 0) {
    /**
     * No observations. A `blocked` snapshot is written rather than nothing at
     * all, because a pattern absent from the results reads as a pattern with
     * nothing wrong — and the whole point of the blocked tier is that "we could
     * not look" has to survive to the interface as its own answer.
     */
    await insertAuditSnapshot(deps.db, scope, {
      patternId: payload.patternId,
      patternSampleId: payload.patternSampleId,
      sitemapRunId: payload.sitemapRunId,
      httpStatus: 0,
      evidenceTier: "blocked",
      observedCount: 0,
      sampleSize: 0,
      populationCount: sample.populationAtDraw,
      pointEstimate: 0,
      ciLow: 0,
      ciHigh: 0,
      confidenceLevel: DEFAULT_CONFIDENCE_LEVEL,
      confidenceBand: "low",
      estimatorVersion: ESTIMATOR_VERSION,
      severityClass: "blocked",
      severityWeight: 0,
      impactScore: 0
    });

    deps.logger.warn(
      {
        sitemapRunId: payload.sitemapRunId,
        patternId: payload.patternId,
        populationCount: sample.populationAtDraw
      },
      "pattern has no observations; recorded as blocked rather than as healthy"
    );

    return { snapshotsWritten: 1, lowConfidenceCount: 0, unmeasured: true };
  }

  let snapshotsWritten = 0;
  let lowConfidenceCount = 0;

  for (const tally of tallies) {
    const snapshot = buildSnapshot(payload, sample, tally, sampleSize);

    if (snapshot === undefined) {
      continue;
    }

    await insertAuditSnapshot(deps.db, scope, snapshot);

    snapshotsWritten += 1;

    if (snapshot.confidenceBand === "low") {
      lowConfidenceCount += 1;
    }
  }

  deps.logger.info(
    {
      sitemapRunId: payload.sitemapRunId,
      patternId: payload.patternId,
      template: pattern.template,
      sampleSize,
      populationCount: sample.populationAtDraw,
      snapshotsWritten,
      lowConfidenceCount
    },
    "pattern estimated"
  );

  return { snapshotsWritten, lowConfidenceCount, unmeasured: false };
}

/**
 * One outcome's claim.
 *
 * A single stratum for now: stratified draws are planned but the ingest stage
 * does not stratify yet, so declaring several strata here would be describing
 * a sample that was not taken. `estimateStratified` over one stratum is exactly
 * the Wilson-plus-FPC interval, so nothing is lost by going through it, and the
 * shape is already right for the day the draw becomes stratified.
 */
function buildSnapshot(
  payload: EstimatePayload,
  sample: { readonly populationAtDraw: number },
  tally: ObservationTally,
  sampleSize: number
): AuditSnapshotInsert | undefined {
  if (tally.httpStatus === null) {
    /**
     * No status at all: a timeout, DNS failure, TLS error or refusal. Real, and
     * deliberately not estimated as a site defect here — `error_reason` on the
     * observation carries it, and extrapolating "we could not connect" into a
     * population-wide count would attribute our own network trouble to the
     * client's site.
     */
    return undefined;
  }

  const observations = [
    {
      label: "all",
      population: sample.populationAtDraw,
      sampled: sampleSize,
      hits: tally.count
    }
  ];

  /**
   * The whole measurement — interval, band and evidence tier — comes from the
   * one shared composition, NOT from re-composing `estimateStratified` and
   * `confidenceBandFor` here. The sample-plan tool calls the same function, so
   * the two cannot answer the same question differently; see
   * `measureProportion`'s docblock for why the composition rather than the
   * arithmetic is the thing worth sharing.
   */
  const measurement = measureProportion(observations);

  const impact = scoreImpact(
    {
      outcome: { httpStatus: tally.httpStatus, isSoft404: tally.isSoft404 },
      estimate: estimateStratified(observations)
    },
    { severityTable: RATIFIED_SEVERITY_TABLE }
  );

  return {
    patternId: payload.patternId,
    patternSampleId: payload.patternSampleId,
    sitemapRunId: payload.sitemapRunId,
    httpStatus: tally.httpStatus,
    ...measurement,
    severityClass: classifyOutcome({
      httpStatus: tally.httpStatus,
      isSoft404: tally.isSoft404
    }),
    severityWeight: impact.severity,
    impactScore: impact.score
  };
}
