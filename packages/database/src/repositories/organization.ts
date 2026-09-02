import { eq } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { organization } from "../schema/tenancy.js";
import { type OrganizationScope, systemOrganizationScope } from "../scope.js";

export interface OrganizationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// Listed explicitly rather than selected with `*`, so a later ALTER TABLE ADD
// COLUMN does not silently change the shape of every result (standards 2.3).
const COLUMNS = {
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
  createdAt: organization.createdAt,
  updatedAt: organization.updatedAt
} as const;

/**
 * Create an organization and return a scope for it.
 *
 * Returns the scope rather than just the row because an organization is the
 * root of all authority here — there is nothing above it to derive one from, so
 * this is one of only two places a `systemOrganizationScope` is legitimately
 * minted (the other being a scheduler resuming work on an existing tenant).
 */
export async function createOrganization(
  db: Database,
  input: { readonly name: string; readonly slug: string }
): Promise<{
  readonly row: OrganizationRow;
  readonly scope: OrganizationScope;
}> {
  const [row] = await internalDatabase(db)
    .insert(organization)
    .values({ name: input.name, slug: input.slug })
    .returning(COLUMNS);

  if (!row) {
    throw new Error("insert into organization returned no row");
  }

  return { row, scope: systemOrganizationScope(row.id) };
}

/** Look up an organization by its URL-safe slug. */
export async function findOrganizationBySlug(
  db: Database,
  slug: string
): Promise<OrganizationRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  return row;
}

/** Read the organization a scope refers to. */
export async function findOrganization(
  db: Database,
  scope: OrganizationScope
): Promise<OrganizationRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(organization)
    .where(eq(organization.id, scope.organizationId))
    .limit(1);

  return row;
}
