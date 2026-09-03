import {
  type Database,
  findOrganizationBySlug,
  type OrganizationScope,
  systemOrganizationScope
} from "@pattern-aware/database";
import type { Config } from "@pattern-aware/shared";

/**
 * Thrown when the configured organization slug has no row yet.
 *
 * Not a startup failure: the API is allowed to come up before the demo data
 * is seeded (`pnpm seed:demo`), so this surfaces per-request as a clear 503
 * instead of crashing the process on boot.
 */
export class OrganizationNotSeededError extends Error {
  public override readonly name = "OrganizationNotSeededError";

  public constructor(public readonly slug: string) {
    super(
      `No organization found for slug "${slug}". Run "pnpm seed:demo" first.`
    );
  }
}

let cached: OrganizationScope | undefined;

/**
 * Resolve the single internal organization's scope.
 *
 * PLACEHOLDER UNTIL REAL AUTH EXISTS. Only the internal team reaches this
 * today (see packages/database/src/schema/tenancy.ts), so there is no session
 * to derive an OrganizationScope from — every request acts as one fixed
 * organization, named by DEFAULT_ORGANIZATION_SLUG rather than looked up per
 * request. When session-based auth lands, this function is exactly what gets
 * replaced, and every caller already takes a scope as a parameter rather than
 * reaching for a global, so no call site changes shape.
 *
 * SYSTEM, NOT AUTHENTICATED, and the distinction is not cosmetic.
 * `authenticatedOrganizationScope` stamps `origin: "request"`, which means "a
 * session asserted this membership" — a claim nothing here can make, because
 * there is no session. Every audit log line would have attributed a hardcoded
 * identity to a user. `systemOrganizationScope` is described in scope.ts as
 * deliberately the most awkward of the three names precisely so that
 * platform-internal authority stands out in a diff, which is exactly what
 * this is until auth exists.
 *
 * Cached after the first successful lookup — this changes only when someone
 * re-seeds under a different slug, not per request.
 */
export async function resolveDefaultOrgScope(
  db: Database,
  config: Config
): Promise<OrganizationScope> {
  if (cached) {
    return cached;
  }

  const org = await findOrganizationBySlug(
    db,
    config.DEFAULT_ORGANIZATION_SLUG
  );

  if (!org) {
    throw new OrganizationNotSeededError(config.DEFAULT_ORGANIZATION_SLUG);
  }

  cached = systemOrganizationScope(org.id);

  return cached;
}

/** Test-only: clear the memoised scope between suites. */
export function resetOrgScopeCacheForTesting(): void {
  cached = undefined;
}
