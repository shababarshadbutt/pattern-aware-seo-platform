/**
 * The pipeline: five stages that turn a sitemap URL into published claims.
 *
 * Stage handlers are plain async functions taking injected dependencies, so
 * the whole pipeline is testable against a real Postgres and a fake HTTP server
 * with no Redis involved. The worker owns BullMQ; nothing here imports it.
 */

export {
  assertScopeMatchesPayload,
  type EnqueueStage,
  type PipelineDeps,
  type SitemapFetcher,
  type SitemapResponse
} from "./deps.js";
export {
  type DiscoverPayload,
  discoverPayloadSchema,
  type EstimatePayload,
  estimatePayloadSchema,
  type FinalizePayload,
  finalizePayloadSchema,
  type IngestPayload,
  InvalidJobPayloadError,
  ingestPayloadSchema,
  parsePayload,
  sampleCandidateSchema,
  type VerifyPayload,
  verifyPayloadSchema
} from "./payloads.js";
export {
  InvalidQueueNameError,
  isPipelineStage,
  isSiteTier,
  PIPELINE_STAGES,
  type PipelineStage,
  parseQueueName,
  type QueueAddress,
  queueName,
  queueNamesForSite,
  SITE_TIERS,
  type SiteTier
} from "./queue-names.js";
export {
  runStage,
  type StageResult,
  UnknownStageError
} from "./runner.js";
export {
  type DiscoverResult,
  ENTRY_FILE_ID,
  runDiscover,
  SitemapUnavailableError
} from "./stages/discover.js";
export { type EstimateResult, runEstimate } from "./stages/estimate.js";
export { type FinalizeResult, runFinalize } from "./stages/finalize.js";
export {
  IngestAlreadyAggregatedError,
  type IngestResult,
  NothingToIngestError,
  runIngest
} from "./stages/ingest.js";
export {
  type PatternOutcome,
  runVerify,
  type VerifyResult
} from "./stages/verify.js";
