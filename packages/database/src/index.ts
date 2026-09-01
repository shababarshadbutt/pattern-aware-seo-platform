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
  createOrganization,
  findOrganization,
  findOrganizationBySlug,
  type OrganizationRow
} from "./repositories/organization.js";
export {
  countPatternsByStatus,
  findPatternById,
  listPatternsByPopulation,
  type PatternRow,
  type PatternStatus,
  type PatternStatusCount,
  type PatternUpsert,
  upsertPatterns
} from "./repositories/pattern.js";

export {
  type CreateSiteInput,
  createSite,
  findSiteById,
  InvalidSiteUrlError,
  listSites,
  type SiteRow,
  softDeleteSite
} from "./repositories/site.js";

export {
  ACTIVE_RUN_STATUSES,
  ActiveRunExistsError,
  findActiveRun,
  finishRun,
  heartbeatRun,
  listRuns,
  type RunStatus,
  type SitemapRunRow,
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
