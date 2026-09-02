import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { isUniqueViolation } from "../pg-errors.js";
import { sitemapRun } from "../schema/ingestion.js";
import type { SiteScope } from "../scope.js";

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
    .where(and(eq(sitemapRun.id, runId), eq(sitemapRun.siteId, scope.siteId)))
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

/** Recent runs for this site, newest first — the run-history view. */
export async function listRuns(
  db: Database,
  scope: SiteScope,
  limit = 20
): Promise<readonly SitemapRunRow[]> {
  return internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapRun)
    .where(eq(sitemapRun.siteId, scope.siteId))
    .orderBy(desc(sitemapRun.startedAt))
    .limit(limit);
}
