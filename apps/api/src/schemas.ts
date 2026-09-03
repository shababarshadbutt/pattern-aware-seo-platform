import { z } from "zod";

/**
 * The wire contract, as zod schemas.
 *
 * These do two jobs that generics cannot. Params get **validated**: a
 * path segment that is not a UUID is rejected with a 400 before any query
 * runs, where previously it reached Postgres and came back as a 500 carrying
 * the raw SQL — the wrong status and an information leak in one response.
 *
 * Responses get **serialized through a declared shape**, so the wire format is
 * chosen here rather than being whatever columns a repository happens to
 * select. Unknown keys are stripped, which means adding a column to a table
 * does not silently start publishing it. The cost is that a schema which
 * drifts from reality fails loudly — which is why every route has a test.
 */

const uuid = z.uuid();

/**
 * Every list is `.readonly()`.
 *
 * The repositories return `readonly T[]` deliberately, and unlike a readonly
 * property, a readonly ARRAY is not assignable to a mutable one — so without
 * this the handlers would not typecheck against their own response schemas.
 */

export const siteParams = z.object({ siteId: uuid });

export const patternParams = z.object({ siteId: uuid, patternId: uuid });

/**
 * A timestamp, accepted as either a `Date` or an already-serialized string.
 *
 * DELIBERATELY NOT A `.transform()`. A transform makes zod's input and output
 * types differ, and the type provider types a reply by its OUTPUT — so a
 * transformed schema demands the handler already return strings while the
 * repositories return `Date`. The union keeps input and output the same, and
 * JSON serialization renders a `Date` as an ISO string on the wire regardless,
 * which is what the client parses.
 */
const isoDate = z.union([z.string(), z.date()]);

const nullableIsoDate = z.union([z.string(), z.date(), z.null()]);

export const siteSummary = z.object({
  id: uuid,
  organizationId: uuid,
  name: z.string(),
  baseUrl: z.string(),
  host: z.string(),
  tier: z.enum(["standard", "priority", "bulk"]),
  isActive: z.boolean(),
  dailyRequestCap: z.number().nullable(),
  minRequestIntervalMs: z.number().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: nullableIsoDate
});

export const runSummary = z.object({
  id: uuid,
  siteId: uuid,
  status: z.enum([
    "pending",
    "running",
    "complete",
    "degraded",
    "failed",
    "cancelled"
  ]),
  statusReason: z.string().nullable(),
  isDryRun: z.boolean(),
  workerId: z.string().nullable(),
  heartbeatAt: nullableIsoDate,
  startedAt: nullableIsoDate,
  completedAt: nullableIsoDate,
  totalFiles: z.number(),
  parsedFiles: z.number(),
  totalUrls: z.number(),
  totalPatterns: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate
});

export const samplingHealthSummary = z.object({
  id: uuid,
  siteId: uuid,
  sitemapRunId: uuid.nullable(),
  windowStart: isoDate,
  windowEnd: isoDate,
  patternsTotal: z.number(),
  patternsLowConfidence: z.number(),
  patternsExpanded: z.number(),
  patternsBlocked: z.number(),
  patternsNeedsReview: z.number(),
  samplesDrawn: z.number(),
  httpRequests: z.number(),
  getEscalations: z.number(),
  circuitBreaks: z.number()
});

export const patternSummary = z.object({
  id: uuid,
  siteId: uuid,
  sitemapRunId: uuid,
  template: z.string(),
  segmentCount: z.number(),
  populationCount: z.number(),
  fileCount: z.number(),
  status: z.enum([
    "unsampled",
    "sampling",
    "measured",
    "blocked",
    "needs_review"
  ]),
  statusReason: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate
});

export const patternSampleSummary = z.object({
  id: uuid,
  patternId: uuid,
  sitemapRunId: uuid,
  round: z.number(),
  method: z.literal("min_heap_by_hash"),
  kRequested: z.number(),
  kThresholdHash: z.number(),
  sampleSize: z.number(),
  populationAtDraw: z.number(),
  stratumCount: z.number(),
  drawnAt: isoDate
});

/**
 * A published finding.
 *
 * Carries `severityWeight` and the derived impact bounds because impact is an
 * ESTIMATED quantity and ADR-0008 forbids rendering one without its interval.
 * The bounds are computed, not stored — see `impactBounds` in findings.ts.
 */
export const auditSnapshotSummary = z.object({
  id: uuid,
  patternId: uuid,
  patternSampleId: uuid,
  sitemapRunId: uuid,
  httpStatus: z.number(),
  evidenceTier: z.enum(["counted", "estimated", "blocked"]),
  observedCount: z.number(),
  sampleSize: z.number(),
  populationCount: z.number(),
  pointEstimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  confidenceBand: z.enum(["confident", "approximate", "low"]),
  /** The level the interval was computed at, so the screen can say "95%". */
  confidenceLevel: z.number(),
  severityClass: z.enum([
    "gone",
    "not_found",
    "soft_not_found",
    "server_error",
    "redirect_chain",
    "redirect_single",
    "ok",
    "blocked",
    "unknown"
  ]),
  severityWeight: z.number(),
  impactScore: z.number(),
  impactLow: z.number(),
  impactHigh: z.number(),
  estimatorVersion: z.string(),
  computedAt: isoDate
});

export const sampleObservationSummary = z.object({
  id: uuid,
  patternId: uuid,
  patternSampleId: uuid,
  url: z.string(),
  urlHash: z.number(),
  httpStatus: z.number().nullable(),
  methodUsed: z.enum(["HEAD", "GET"]).nullable(),
  escalatedToGet: z.boolean(),
  isSoft404: z.boolean(),
  errorReason: z.string().nullable(),
  responseMs: z.number().nullable(),
  observedAt: isoDate
});

export const sitesResponse = z.object({
  sites: z.array(siteSummary).readonly()
});

export const siteDetailResponse = z.object({
  site: siteSummary,
  latestRun: runSummary.optional(),
  samplingHealth: samplingHealthSummary.optional()
});

/**
 * `sitemapRunId` is nullable rather than the route 404-ing.
 *
 * "This site has no finished run yet" is not "this site does not exist" —
 * conflating them made a freshly-onboarded site indistinguishable from a typo
 * in the URL. An empty list with a null run id lets the screen say which.
 */
export const patternsResponse = z.object({
  sitemapRunId: uuid.nullable(),
  patterns: z.array(patternSummary).readonly()
});

export const patternDetailResponse = z.object({
  pattern: patternSummary,
  latestSample: patternSampleSummary.optional(),
  findings: z.array(auditSnapshotSummary).readonly(),
  observations: z.array(sampleObservationSummary).readonly()
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});
