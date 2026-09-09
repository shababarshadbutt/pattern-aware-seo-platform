import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { isUniqueViolation } from "../pg-errors.js";
import { sitemapRun } from "../schema/ingestion.js";
import type { OrganizationScope, SiteScope } from "../scope.js";
import { organizationSiteIds } from "./site.js";

export type RunStatus =
  | "pending"
  | "running"
  | "complete"
  | "degraded"
  | "failed"
  | "cancelled";

/** Statuses that occupy the "one active run per site" slot. */
export const ACTIVE_RUN_STATUSES = ["pending", "running"] as const;

export interface SitemapRunRow {
  readonly id: string;
  readonly siteId: string;
  readonly status: RunStatus;
  readonly statusReason: string | null;
  readonly isDryRun: boolean;
  readonly workerId: string | null;
  readonly heartbeatAt: Date | null;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly totalFiles: number;
  readonly parsedFiles: number;
  readonly totalUrls: number;
  readonly totalPatterns: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = {
  id: sitemapRun.id,
  siteId: sitemapRun.siteId,
  status: sitemapRun.status,
  statusReason: sitemapRun.statusReason,
  isDryRun: sitemapRun.isDryRun,
  workerId: sitemapRun.workerId,
  heartbeatAt: sitemapRun.heartbeatAt,
  startedAt: sitemapRun.startedAt,
  completedAt: sitemapRun.completedAt,
  totalFiles: sitemapRun.totalFiles,
  parsedFiles: sitemapRun.parsedFiles,
  totalUrls: sitemapRun.totalUrls,
  totalPatterns: sitemapRun.totalPatterns,
  createdAt: sitemapRun.createdAt,
  updatedAt: sitemapRun.updatedAt
} as const;

/**
 * Raised when a site already has a run in flight.
 *
 * Not a bug and not a race to retry past: it means something is already
 * pointing traffic at that origin, and starting a second run would double the
 * request rate the client's server sees.
 */
export class ActiveRunExistsError extends Error {
  public override readonly name = "ActiveRunExistsError";

  public constructor(public readonly siteId: string) {
    super(`Site ${siteId} already has a run in flight`);
  }
}

/**
 * Start a run, or fail because one is already in flight.
 *
 * The exclusion is the partial unique index on the table, not a check here: a
 * check-then-insert loses the race between two schedulers, and the consequence
 * of losing it is a doubled request rate at somebody else's production web
 * server. Letting the database arbitrate means the loser gets a clean error
 * rather than a second run.
 */
export async function startRun(
  db: Database,
  scope: SiteScope,
  input: { readonly workerId: string; readonly isDryRun?: boolean }
): Promise<SitemapRunRow> {
  try {
    const [row] = await internalDatabase(db)
      .insert(sitemapRun)
      .values({
        siteId: scope.siteId,
        status: "running",
        workerId: input.workerId,
        isDryRun: input.isDryRun ?? false,
        startedAt: sql`now()`,
        heartbeatAt: sql`now()`
      })
      .returning(COLUMNS);

    if (!row) {
      throw new Error("insert into sitemap_run returned no row");
    }

    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ActiveRunExistsError(scope.siteId);
    }

    throw error;
  }
}

/**
 * Mark a run as still alive.
 *
 * A run whose heartbeat stops is swept to `failed` rather than holding the
 * one-active-run slot forever — otherwise a crashed worker locks a site out of
 * being audited again, and the symptom (nothing happens) points nowhere near
 * the cause.
 */
export async function heartbeatRun(
  db: Database,
  scope: SiteScope,
  runId: string
): Promise<boolean> {
  const rows = await internalDatabase(db)
    .update(sitemapRun)
    .set({ heartbeatAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(sitemapRun.id, runId),
        eq(sitemapRun.siteId, scope.siteId),
        eq(sitemapRun.status, "running")
      )
    )
    .returning({ id: sitemapRun.id });

  return rows.length > 0;
}

/** Record progress counters mid-run. */
export async function updateRunProgress(
  db: Database,
  scope: SiteScope,
  runId: string,
  progress: {
    readonly totalFiles?: number;
    readonly parsedFiles?: number;
    readonly totalUrls?: number;
    readonly totalPatterns?: number;
  }
): Promise<void> {
  await internalDatabase(db)
    .update(sitemapRun)
    .set({ ...progress, heartbeatAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(sitemapRun.id, runId), eq(sitemapRun.siteId, scope.siteId)));
}

/**
 * Close a run out.
 *
 * `degraded` requires a reason. A run that silently reduced its sample rate or
 * stopped after counting is still useful, but only if whoever reads the numbers
 * can see which threshold it hit — a degraded run with no explanation is
 * indistinguishable from a healthy one at a glance, which is the failure mode
 * the status exists to prevent.
 *
 * GUARDED ON `status = 'running'`, not unconditional. Every existing caller
 * already only calls this while a run is running, so the guard changes
 * nothing for them — but it is what makes it safe for a BullMQ job's
 * exhausted-retries handler to call this too: a job belonging to a run that
 * some OTHER path already finished (finalize completing it normally, a
 * concurrent failure racing this one) finds no matching row and quietly does
 * nothing, rather than stamping `failed` over a `complete` run.
 */
export async function finishRun(
  db: Database,
  scope: SiteScope,
  runId: string,
  outcome:
    | { readonly status: "complete" | "cancelled" }
    | { readonly status: "degraded" | "failed"; readonly statusReason: string }
): Promise<SitemapRunRow | undefined> {
  const [row] = await internalDatabase(db)
    .update(sitemapRun)
    .set({
      status: outcome.status,
      statusReason: "statusReason" in outcome ? outcome.statusReason : null,
      completedAt: sql`now()`,
      updatedAt: sql`now()`
    })
    .where(
      and(
        eq(sitemapRun.id, runId),
        eq(sitemapRun.siteId, scope.siteId),
        eq(sitemapRun.status, "running")
      )
    )
    .returning(COLUMNS);

  return row;
}

/** The in-flight run for this site, if there is one. */
export async function findActiveRun(
  db: Database,
  scope: SiteScope
): Promise<SitemapRunRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapRun)
    .where(
      and(
        eq(sitemapRun.siteId, scope.siteId),
        inArray(sitemapRun.status, [...ACTIVE_RUN_STATUSES])
      )
    )
    .limit(1);

  return row;
}

/**
 * One run by id, within a known site.
 *
 * `verify`'s unresolvable path and `estimate`'s completion check both need
 * `total_patterns` — the fan-in's denominator, since every pattern for a run
 * ends up in a terminal status one way or another (`measured`/`blocked`/
 * `needs_review`, the last of which `ingest` also assigns immediately to a
 * pattern with no resolvable candidates) — and neither is handed the whole
 * row on its job payload, only `patternSampleId`/`patternId`. This is the one
 * place that reads it back.
 */
export async function findRunById(
  db: Database,
  scope: SiteScope,
  runId: string
): Promise<SitemapRunRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapRun)
    .where(and(eq(sitemapRun.id, runId), eq(sitemapRun.siteId, scope.siteId)))
    .limit(1);

  return row;
}

export interface StaleRun {
  readonly id: string;
  readonly siteId: string;
}

/**
 * Every run whose heartbeat has gone quiet.
 *
 * `idx_sitemap_run_heartbeat` is this query's only shape — `running` rows
 * ordered by nothing, filtered by a heartbeat older than the threshold. Not
 * scoped to one site: this is the sweeper's own read, run by the worker
 * process rather than in response to any caller's request, and it is
 * deliberately narrow — it returns ids only, not full rows, so it cannot
 * become a second way to read another tenant's data. See
 * `systemOrganizationScope`'s docblock for why a fleet-wide read like this
 * needs to stand out rather than blend in.
 */
export async function findStaleRuns(
  db: Database,
  thresholdMs: number
): Promise<readonly StaleRun[]> {
  return internalDatabase(db)
    .select({ id: sitemapRun.id, siteId: sitemapRun.siteId })
    .from(sitemapRun)
    .where(
      and(
        eq(sitemapRun.status, "running"),
        sql`${sitemapRun.heartbeatAt} < now() - (${thresholdMs}::text || ' milliseconds')::interval`
      )
    );
}

/**
 * Fail one stale run, without a `SiteScope` — the sweeper finds these
 * fleet-wide and has no per-site authority to narrow to.
 *
 * Guarded on `status = 'running'` in the `WHERE` clause rather than trusted
 * from the caller's read: a run that completed in the gap between
 * {@link findStaleRuns} and this call must not be overwritten back to
 * `failed`.
 */
export async function failStaleRun(
  db: Database,
  runId: string,
  reason: string
): Promise<boolean> {
  const rows = await internalDatabase(db)
    .update(sitemapRun)
    .set({
      status: "failed",
      statusReason: reason,
      completedAt: sql`now()`,
      updatedAt: sql`now()`
    })
    .where(and(eq(sitemapRun.id, runId), eq(sitemapRun.status, "running")))
    .returning({ id: sitemapRun.id });

  return rows.length > 0;
}

/** Recent runs for this site, newest first — the run-history view. */
export async function listRuns(
  db: Database,
  scope: SiteScope,
  limit = 20
): Promise<readonly SitemapRunRow[]> {
  return (
    internalDatabase(db)
      .select(COLUMNS)
      .from(sitemapRun)
      .where(eq(sitemapRun.siteId, scope.siteId))
      /**
       * NULLS LAST, and a tie-breaker.
       *
       * `started_at` is nullable — a pending run has not started — and Postgres
       * sorts NULLs FIRST in a DESC order. So a never-started run appeared at the
       * top of "recent runs", ahead of runs that had actually happened, which is
       * the opposite of what the run-history view is for.
       */
      .orderBy(
        sql`${sitemapRun.startedAt} desc nulls last`,
        desc(sitemapRun.createdAt)
      )
      .limit(limit)
  );
}

/** One run, carrying the site name a cross-site list needs to be readable. */
export interface OrganizationRunRow extends SitemapRunRow {
  readonly siteName: string;
}

/**
 * Every site's runs in one organization, newest first.
 *
 * The fleet-level counterpart to {@link listRuns}, and it repeats that
 * function's NULLS LAST ordering deliberately: `started_at` is nullable, and
 * Postgres sorts NULLs FIRST in a DESC order, so a never-started pending run
 * would otherwise sit at the top of a run-history view ahead of runs that
 * actually happened. Getting that wrong here would reintroduce a bug already
 * fixed once for the per-site view.
 *
 * Cross-site within one organization, the same way — and for the same reasons
 * as — {@link listOrganizationSnapshotsByImpact}; see ADR-0028. The ids come
 * from `organizationSiteIds`, so the tenant boundary is structural rather than
 * a predicate to remember, and no caller supplies an organization id.
 */
export async function listOrganizationRuns(
  db: Database,
  scope: OrganizationScope,
  options: { readonly limit?: number } = {}
): Promise<readonly OrganizationRunRow[]> {
  const siteNames = await organizationSiteIds(db, scope);

  if (siteNames.size === 0) {
    return [];
  }

  const rows = await internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapRun)
    .where(inArray(sitemapRun.siteId, [...siteNames.keys()]))
    .orderBy(
      sql`${sitemapRun.startedAt} desc nulls last`,
      desc(sitemapRun.createdAt)
    )
    .limit(options.limit ?? 50);

  return rows.map((row) => ({
    ...row,
    // Non-null by construction: the id came from this very map.
    siteName: siteNames.get(row.siteId) ?? row.siteId
  }));
}

/**
 * One run by id, resolved through the organization's own sites.
 *
 * The fleet run list has no site in its URL, so neither does the detail view it
 * links to — which rules out the `SiteScope` every other read here takes. A
 * lookup on `id` alone would be wrong twice over: `sitemap_run` is partitioned
 * by `site_id`, so an unqualified id scans every partition, and it would return
 * another tenant's run.
 *
 * So the ids come from `organizationSiteIds`, exactly as the two fleet lists do
 * (ADR-0028): the boundary is structural rather than a predicate to remember,
 * and a run belonging to another organization finds nothing.
 *
 * That is also what makes the returned `siteId` safe to build a `SiteScope`
 * from — it came from this organization's own id list, never from the caller —
 * which is how the detail route reads the run's files and patterns.
 */
export async function findOrganizationRunById(
  db: Database,
  scope: OrganizationScope,
  runId: string
): Promise<OrganizationRunRow | undefined> {
  const siteNames = await organizationSiteIds(db, scope);

  // As in the fleet lists: an empty `ANY('{}')` scans every partition to find
  // nothing.
  if (siteNames.size === 0) {
    return undefined;
  }

  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapRun)
    .where(
      and(
        eq(sitemapRun.id, runId),
        inArray(sitemapRun.siteId, [...siteNames.keys()])
      )
    )
    .limit(1);

  if (!row) {
    return undefined;
  }

  return {
    ...row,
    // Non-null by construction: the id came from this very map.
    siteName: siteNames.get(row.siteId) ?? row.siteId
  };
}

/**
 * Each site's most recent run, one row per site.
 *
 * WHAT THE PORTFOLIO SCREEN NEEDS AND A LOOP WOULD GET WRONG. A fleet table
 * shows every site's last run; asking per site is a query per row, which is
 * fine at eighteen sites and is the shape that stops being fine without anyone
 * noticing. `DISTINCT ON (site_id)` answers it in one pass.
 *
 * Cross-site within one organization, through `organizationSiteIds` exactly as
 * {@link listOrganizationRuns} does (ADR-0028): the ids can only be this
 * caller's own, so the tenant boundary is structural rather than a predicate
 * someone has to remember, and no caller supplies an organization id.
 *
 * RESOLVES THE IDS ITSELF rather than accepting a page of them. The portfolio
 * shows a window of sites and needs runs only for that window, so passing the
 * page's ids would be the cheaper call — and it would also be a function that
 * reads whatever site ids it is handed. Cheaper is not worth that; the map is
 * built for the whole organization and the route picks its page out of it.
 *
 * NULLS LAST on `started_at`, matching the two run lists above: Postgres sorts
 * NULLs FIRST in DESC order, so a queued run that never started would otherwise
 * outrank the run that actually happened and become "the latest run".
 */
export async function latestRunPerSite(
  db: Database,
  scope: OrganizationScope
): Promise<ReadonlyMap<string, SitemapRunRow>> {
  const siteNames = await organizationSiteIds(db, scope);

  if (siteNames.size === 0) {
    return new Map();
  }

  const rows = await internalDatabase(db)
    .selectDistinctOn([sitemapRun.siteId], COLUMNS)
    .from(sitemapRun)
    .where(inArray(sitemapRun.siteId, [...siteNames.keys()]))
    .orderBy(
      asc(sitemapRun.siteId),
      sql`${sitemapRun.startedAt} desc nulls last`,
      desc(sitemapRun.createdAt)
    );

  return new Map(rows.map((row) => [row.siteId, row]));
}
