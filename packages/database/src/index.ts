/**
 * The public surface of the data layer.
 *
 * Note what is NOT exported: `internalDatabase`, `opaqueDatabase`, the Drizzle
 * instance type, and the table objects themselves. Outside this package there is
 * no way to build a query — only to call a repository function, every one of
 * which demands a scope. That absence is the enforcement described in ADR-0004,
 * so think before adding to this list.
 */

export {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type DatabaseOptions
} from "./client.js";
export { runMigrations } from "./migrate.js";

export {
  createSitePartitions,
  dropSitePartitions,
  InvalidPartitionKeyError,
  PARTITIONED_TABLES,
  type PartitionedTable,
  partitionName
} from "./partitions.js";
export {
  type AuditSnapshotInsert,
  type AuditSnapshotRow,
  type ConfidenceBandName,
  countOrganizationSnapshotsBySeverity,
  type EvidenceTier,
  findSnapshotsByPattern,
  ImpossibleClaimError,
  insertAuditSnapshot,
  listOrganizationSnapshotsByImpact,
  listSnapshotsByImpact,
  listSnapshotsByPatterns,
  type OrganizationSnapshotRow,
  type SeverityClassName,
  type SiteSeverityCount,
  type SiteSnapshotRow
} from "./repositories/audit-snapshot.js";
export {
  createOrganization,
  findOrganization,
  findOrganizationBySlug,
  type OrganizationRow
} from "./repositories/organization.js";
export {
  countPatterns,
  countPatternsByDepth,
  countPatternsByStatus,
  findPatternById,
  type ListPatternsRankedOptions,
  listPatternsByPopulation,
  listPatternsRanked,
  type PatternDepthCount,
  type PatternRankRow,
  type PatternRow,
  type PatternSort,
  type PatternStatus,
  type PatternStatusCount,
  type PatternUpsert,
  setPatternStatus,
  upsertPatterns
} from "./repositories/pattern.js";

export {
  listPatternFiles,
  type PatternFileRow,
  type PatternPopulationRow,
  type PatternPopulationUpsert,
  sumPatternPopulation,
  upsertPatternPopulations
} from "./repositories/pattern-population.js";
export {
  countExpandedPatterns,
  findPatternSample,
  findPatternSampleById,
  latestPatternSample,
  type PatternSampleRow,
  type RecordSampleInput,
  recordPatternSample
} from "./repositories/pattern-sample.js";
export {
  appendSampleObservations,
  countObservations,
  countRunObservations,
  type HttpMethodUsed,
  type HttpStatusClass,
  listObservations,
  listRunObservations,
  type ObservationTally,
  type RunObservationRow,
  type RunRequestSummary,
  type SampleObservationInsert,
  type SampleObservationRow,
  summariseRunRequests,
  tallyObservations,
  tallyRunObservations
} from "./repositories/sample-observation.js";
export {
  findRunSamplingHealth,
  listSamplingHealth,
  type SamplingHealthRow,
  type SamplingHealthUpsert,
  upsertSamplingHealth
} from "./repositories/sampling-health.js";
export {
  type CreateSiteInput,
  countSites,
  createSite,
  findSiteById,
  InvalidSiteUrlError,
  type ListSitesOptions,
  listSites,
  SiteHostConflictError,
  type SiteRow,
  softDeleteSite,
  type UpdateSiteInput,
  updateSite
} from "./repositories/site.js";
export {
  countSitemapFiles,
  type FileParseStatus,
  listSitemapFiles,
  markFileDownloaded,
  nextUnparsedFile,
  type SitemapFileRow,
  type SitemapFileUpsert,
  setFileParseStatus,
  upsertSitemapFiles
} from "./repositories/sitemap-file.js";

export {
  ACTIVE_RUN_STATUSES,
  ActiveRunExistsError,
  failStaleRun,
  findActiveRun,
  findOrganizationRunById,
  findRunById,
  findStaleRuns,
  finishRun,
  heartbeatRun,
  latestRunPerSite,
  listOrganizationRuns,
  listRuns,
  type OrganizationRunRow,
  type RunStatus,
  type SitemapRunRow,
  type StaleRun,
  startRun,
  updateRunProgress
} from "./repositories/sitemap-run.js";
export {
  authenticatedOrganizationScope,
  describeScope,
  jobOrganizationScope,
  jobSiteScope,
  type OrganizationScope,
  type ScopeOrigin,
  type SiteScope,
  siteScopeWithin,
  systemOrganizationScope
} from "./scope.js";
