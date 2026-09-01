import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { createSitePartitionsWith } from "../partitions.js";
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

export interface CreateSiteInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier?: SiteRow["tier"];
  readonly dailyRequestCap?: number;
  readonly minRequestIntervalMs?: number;
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
export async function listSites(
  db: Database,
  scope: OrganizationScope,
  options: { readonly includeInactive?: boolean } = {}
): Promise<readonly SiteRow[]> {
  const predicates = [
    eq(site.organizationId, scope.organizationId),
    isNull(site.deletedAt)
  ];

  if (options.includeInactive !== true) {
    predicates.push(eq(site.isActive, true));
  }

  return internalDatabase(db)
    .select(COLUMNS)
    .from(site)
    .where(and(...predicates))
    .orderBy(asc(site.createdAt));
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
