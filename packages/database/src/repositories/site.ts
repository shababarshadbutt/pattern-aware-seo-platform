import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { createSitePartitionsWith } from "../partitions.js";
import { isUniqueViolation } from "../pg-errors.js";
import { site } from "../schema/tenancy.js";
import {
  type OrganizationScope,
  type SiteScope,
  siteScopeWithin
} from "../scope.js";

export interface SiteRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly host: string;
  readonly tier: "standard" | "priority" | "bulk";
  readonly isActive: boolean;
  readonly dailyRequestCap: number | null;
  readonly minRequestIntervalMs: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

const COLUMNS = {
  id: site.id,
  organizationId: site.organizationId,
  name: site.name,
  baseUrl: site.baseUrl,
  host: site.host,
  tier: site.tier,
  isActive: site.isActive,
  dailyRequestCap: site.dailyRequestCap,
  minRequestIntervalMs: site.minRequestIntervalMs,
  createdAt: site.createdAt,
  updatedAt: site.updatedAt,
  deletedAt: site.deletedAt
} as const;

/**
 * Each optional property spells out `| undefined` because this repo compiles
 * with `exactOptionalPropertyTypes`: a caller holding a validated body, where
 * an omitted field really is `undefined`, does not satisfy the type without it.
 * Same reason `UpdateSiteInput` below does.
 */
export interface CreateSiteInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier?: SiteRow["tier"] | undefined;
  readonly dailyRequestCap?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
}

/** Thrown when a site's base URL cannot be parsed into a host. */
export class InvalidSiteUrlError extends Error {
  public override readonly name = "InvalidSiteUrlError";
}

function hostFrom(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    throw new InvalidSiteUrlError(
      `Site base URL is not a valid absolute URL: ${JSON.stringify(baseUrl)}`
    );
  }
}

/**
 * Onboard a site: insert the row and create its partitions, atomically.
 *
 * Both halves are in one transaction because Postgres DDL is transactional and
 * the two are meaningless apart. A site row without partitions accepts no
 * patterns, no files and no observations — and it would fail at ingestion time,
 * hours later and far from the cause, rather than here where the fix is
 * obvious. See ADR-0003.
 *
 * The host is derived from `base_url` rather than accepted separately, so the
 * value the outbound rate limiter buckets on can never disagree with the URL
 * the crawler actually requests.
 */
export async function createSite(
  db: Database,
  scope: OrganizationScope,
  input: CreateSiteInput
): Promise<{ readonly row: SiteRow; readonly scope: SiteScope }> {
  const host = hostFrom(input.baseUrl);

  try {
    return await insertSiteWithPartitions(db, scope, input, host);
  } catch (error) {
    /**
     * `uq_site_organization_host` mapped, not left to surface raw.
     *
     * FOUND BY EXPOSING THIS FUNCTION OVER HTTP (ADR-0037). It had exactly one
     * caller — the seed script, which guards against re-seeding — so a
     * duplicate host had never been reached and the violation propagated as a
     * generic database error. Onboarding a domain that is already monitored is
     * the single most ordinary mistake this endpoint will see, and it was
     * answering a 500. `updateSite` already mapped the same constraint; the
     * create path simply never had.
     */
    if (isUniqueViolation(error)) {
      throw new SiteHostConflictError(host);
    }

    throw error;
  }
}

async function insertSiteWithPartitions(
  db: Database,
  scope: OrganizationScope,
  input: CreateSiteInput,
  host: string
): Promise<{ readonly row: SiteRow; readonly scope: SiteScope }> {
  const row = await internalDatabase(db).transaction(async (tx) => {
    const [inserted] = await tx
      .insert(site)
      .values({
        organizationId: scope.organizationId,
        name: input.name,
        baseUrl: input.baseUrl,
        host,
        ...(input.tier === undefined ? {} : { tier: input.tier }),
        ...(input.dailyRequestCap === undefined
          ? {}
          : { dailyRequestCap: input.dailyRequestCap }),
        ...(input.minRequestIntervalMs === undefined
          ? {}
          : { minRequestIntervalMs: input.minRequestIntervalMs })
      })
      .returning(COLUMNS);

    if (!inserted) {
      throw new Error("insert into site returned no row");
    }

    await createSitePartitionsWith(tx, inserted.id);

    return inserted;
  });

  return { row, scope: siteScopeWithin(scope, row.id) };
}

/**
 * Read the site a scope points at.
 *
 * Filters on the organization as well as the id, so a scope aimed at another
 * tenant's site returns nothing rather than their data. This is the check
 * `siteScopeWithin` documents that it cannot perform itself, and it is why
 * every read goes through here rather than selecting on `id` alone.
 */
export async function findSiteById(
  db: Database,
  scope: SiteScope
): Promise<SiteRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(site)
    .where(
      and(
        eq(site.id, scope.siteId),
        eq(site.organizationId, scope.organizationId),
        isNull(site.deletedAt)
      )
    )
    .limit(1);

  return row;
}

/** Every live site in the organization, oldest first. */
export interface ListSitesOptions {
  readonly includeInactive?: boolean | undefined;
  /** Narrow to one tier, for the portfolio's tier filter. */
  readonly tier?: SiteRow["tier"] | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/**
 * The predicates every site read shares.
 *
 * Extracted so {@link listSites} and {@link countSites} cannot disagree about
 * what a site IS. A portfolio footer reading "showing 1-5 of 18" is wrong in a
 * way nobody notices if the count applies a filter the page does not, and the
 * two being separate queries is exactly the shape that invites it.
 */
function siteFilters(scope: OrganizationScope, options: ListSitesOptions) {
  const predicates = [
    eq(site.organizationId, scope.organizationId),
    isNull(site.deletedAt)
  ];

  if (options.includeInactive !== true) {
    predicates.push(eq(site.isActive, true));
  }

  if (options.tier !== undefined) {
    predicates.push(eq(site.tier, options.tier));
  }

  return and(...predicates);
}

export async function listSites(
  db: Database,
  scope: OrganizationScope,
  options: ListSitesOptions = {}
): Promise<readonly SiteRow[]> {
  const query = internalDatabase(db)
    .select(COLUMNS)
    .from(site)
    .where(siteFilters(scope, options))
    .orderBy(asc(site.createdAt));

  /*
   * Applied only when asked. Every caller that predates the portfolio expects
   * the whole list, and a default page size would silently truncate them.
   */
  if (options.limit === undefined) {
    return query;
  }

  return query.limit(options.limit).offset(options.offset ?? 0);
}

/**
 * How many sites match, ignoring the page window.
 *
 * The portfolio's footer needs the total to say "of 18", and its pagination
 * needs it to know whether a next page exists. Shares {@link siteFilters} with
 * the list above so the two can only ever describe the same set.
 */
export async function countSites(
  db: Database,
  scope: OrganizationScope,
  options: ListSitesOptions = {}
): Promise<number> {
  const [row] = await internalDatabase(db)
    .select({ total: sql<number>`count(*)::int` })
    .from(site)
    .where(siteFilters(scope, options));

  return row?.total ?? 0;
}

/**
 * The organization's site ids and names, for a cross-site read.
 *
 * PACKAGE-INTERNAL, and deliberately not exported from `index.ts`: it hands
 * back ids rather than a scope, so it is not a way to reach another
 * organization's data — it is the input the organization-scoped queries in
 * `audit-snapshot.ts` and `sitemap-run.ts` need, and nothing outside this
 * package can call it.
 *
 * Those queries take this list and filter `site_id = ANY(...)` rather than
 * joining `site` on `organization_id`. Both of the tables they read are
 * partitioned by `site_id` with site-leading indexes
 * (`idx_audit_snapshot_site_impact`, `idx_sitemap_run_site_started`), so an
 * organization filter reached through a join prunes no partitions and cannot
 * use either index to satisfy its ORDER BY. An explicit id list prunes, and
 * lets Postgres merge the per-partition indexes into globally sorted output
 * because `site_id` is constant within a partition.
 *
 * It also makes the tenant boundary structural rather than a predicate someone
 * has to remember: the only ids a caller can obtain come from its own
 * `OrganizationScope`.
 *
 * Matches `listSites`' default — live, active sites — so the fleet screens and
 * the sites list agree about which sites exist.
 */
export async function organizationSiteIds(
  db: Database,
  scope: OrganizationScope
): Promise<ReadonlyMap<string, string>> {
  const rows = await internalDatabase(db)
    .select({ id: site.id, name: site.name })
    .from(site)
    .where(
      and(
        eq(site.organizationId, scope.organizationId),
        isNull(site.deletedAt),
        eq(site.isActive, true)
      )
    );

  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Thrown when a site's new base URL collides with another site's host. */
export class SiteHostConflictError extends Error {
  public override readonly name = "SiteHostConflictError";

  public constructor(public readonly host: string) {
    super(`Another site in this organization already uses host ${host}`);
  }
}

/**
 * The fields a site's settings screen may change.
 *
 * Each optional property spells out `| undefined` because this repo compiles
 * with `exactOptionalPropertyTypes`: without it, a caller holding a validated
 * partial body (where an absent field really is `undefined`) does not satisfy
 * the type. Omitted means "leave alone"; an explicit `null` on either cap means
 * "clear it back to the inherited default", which is a different edit.
 */
export interface UpdateSiteInput {
  readonly name?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly tier?: SiteRow["tier"] | undefined;
  readonly isActive?: boolean | undefined;
  readonly dailyRequestCap?: number | null | undefined;
  readonly minRequestIntervalMs?: number | null | undefined;
}

/**
 * Change a site's configuration.
 *
 * THE HOST IS RE-DERIVED, NEVER ACCEPTED. `createSite` derives `host` from
 * `base_url` so the value the outbound rate limiter buckets on can never
 * disagree with the URL the crawler actually requests — and an update that took
 * a new base URL while leaving the old host in place would break exactly that,
 * silently, in the direction that matters: probes would be paced against a
 * bucket for a domain nobody is requesting any more.
 *
 * A duplicate host becomes {@link SiteHostConflictError} rather than a raw
 * driver error, because `(organization_id, host)` is unique and "somebody
 * already monitors that domain" is an ordinary answer a form has to show, not
 * a 500.
 *
 * Filters on the organization as well as the id, like every other read and
 * write here, so an update aimed at another tenant's site changes nothing and
 * reports that it changed nothing.
 *
 * Note what this does NOT do: nothing here migrates queued jobs when `tier`
 * changes. Queues are namespaced `{tier}:{siteId}:{stage}`, so a re-tier while
 * work is in flight leaves that work addressed to the old namespace. The
 * caller owes the check — see `findActiveRun`.
 */
export async function updateSite(
  db: Database,
  scope: SiteScope,
  input: UpdateSiteInput
): Promise<SiteRow | undefined> {
  const changes: Record<string, unknown> = { updatedAt: sql`now()` };

  if (input.name !== undefined) {
    changes.name = input.name;
  }

  if (input.baseUrl !== undefined) {
    changes.baseUrl = input.baseUrl;
    changes.host = hostFrom(input.baseUrl);
  }

  if (input.tier !== undefined) {
    changes.tier = input.tier;
  }

  if (input.isActive !== undefined) {
    changes.isActive = input.isActive;
  }

  // Explicitly `null`-able rather than skipped when null: clearing a per-site
  // cap back to "inherit the platform default" is a real edit, and treating
  // null as "no change" would make it unclearable through this path.
  if (input.dailyRequestCap !== undefined) {
    changes.dailyRequestCap = input.dailyRequestCap;
  }

  if (input.minRequestIntervalMs !== undefined) {
    changes.minRequestIntervalMs = input.minRequestIntervalMs;
  }

  try {
    const [row] = await internalDatabase(db)
      .update(site)
      .set(changes)
      .where(
        and(
          eq(site.id, scope.siteId),
          eq(site.organizationId, scope.organizationId),
          isNull(site.deletedAt)
        )
      )
      .returning(COLUMNS);

    return row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SiteHostConflictError(
        input.baseUrl === undefined ? "unknown" : hostFrom(input.baseUrl)
      );
    }

    throw error;
  }
}

/**
 * Soft-delete a site.
 *
 * The partitions and their data are deliberately left in place: keeping them is
 * what makes the delete reversible, and dropping tens of millions of rows
 * because someone mis-clicked is not recoverable. A deliberate hard delete uses
 * `dropSitePartitions`.
 */
export async function softDeleteSite(
  db: Database,
  scope: SiteScope
): Promise<boolean> {
  const rows = await internalDatabase(db)
    .update(site)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()`, isActive: false })
    .where(
      and(
        eq(site.id, scope.siteId),
        eq(site.organizationId, scope.organizationId),
        isNull(site.deletedAt)
      )
    )
    .returning({ id: site.id });

  return rows.length > 0;
}
