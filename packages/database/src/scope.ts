declare const organizationScopeBrand: unique symbol;
declare const siteScopeBrand: unique symbol;

/**
 * Where an authority came from. Logged for audit; never used to make an access
 * decision, because a value that decides access is a value worth forging.
 */
export type ScopeOrigin = "request" | "job" | "system";

/**
 * Proof that a caller is entitled to touch one organization's data.
 *
 * Needed as well as {@link SiteScope} because the operations that create and
 * list sites cannot be site-scoped — the site does not exist yet. Rather than
 * fudge that with an optional scope or a nullable site id, the two levels are
 * distinct types and the narrower one is derived from the wider.
 */
export interface OrganizationScope {
  readonly [organizationScopeBrand]: true;
  readonly organizationId: string;
  readonly origin: ScopeOrigin;
}

/**
 * Proof that a caller is entitled to touch one site's data.
 *
 * Every site-level repository function takes one of these as its first
 * argument, and the brand means it cannot be produced by an object literal —
 * only by {@link siteScopeWithin} or one of the named constructors here. The
 * point is not that the brand survives at runtime (it is erased); it is that
 * there is no path to the data layer that does not pass through a function
 * whose name records where the authority came from, and no way to pass a bare
 * `{ siteId }` from somewhere that never checked anything.
 *
 * Together with the opaque `Database` handle in client.ts — whose public type
 * has no query methods at all — this makes an unscoped read a compile error
 * rather than something a reviewer has to catch. See ADR-0004.
 *
 * `organizationId` is unused by queries today. It is what row-level security
 * binds to in M7, and carrying it from the start means that change touches this
 * file and the policies rather than every call site.
 */
export interface SiteScope {
  readonly [siteScopeBrand]: true;
  readonly organizationId: string;
  readonly siteId: string;
  readonly origin: ScopeOrigin;
}

function makeOrganizationScope(
  organizationId: string,
  origin: ScopeOrigin
): OrganizationScope {
  return Object.freeze({ organizationId, origin }) as OrganizationScope;
}

/**
 * Organization authority from an authenticated session.
 *
 * The caller is asserting the session really does belong to this organization.
 * This constructor cannot verify that itself: it has no database handle by
 * design, since giving it one would make every scope construction a query on
 * the hot path.
 */
export function authenticatedOrganizationScope(
  organizationId: string
): OrganizationScope {
  return makeOrganizationScope(organizationId, "request");
}

/** Organization authority from a job payload written by the enqueuing code. */
export function jobOrganizationScope(
  organizationId: string
): OrganizationScope {
  return makeOrganizationScope(organizationId, "job");
}

/**
 * Organization authority for platform-internal work — fleet schedulers,
 * backfills, onboarding.
 *
 * Deliberately the most awkward of the three names, because it is the one that
 * answers to nobody and should stand out in a diff.
 */
export function systemOrganizationScope(
  organizationId: string
): OrganizationScope {
  return makeOrganizationScope(organizationId, "system");
}

/**
 * Narrow an organization authority to one of its sites.
 *
 * The normal way to get a {@link SiteScope}. The organization id is carried
 * across rather than supplied again, so a site scope can never claim an
 * organization its holder was not already entitled to.
 *
 * The caller still owes one check this cannot do: that the site actually
 * belongs to that organization. `findSiteById` performs it — it filters on both
 * ids — so a scope pointing at someone else's site simply finds nothing rather
 * than returning their data.
 */
export function siteScopeWithin(
  scope: OrganizationScope,
  siteId: string
): SiteScope {
  return Object.freeze({
    organizationId: scope.organizationId,
    siteId,
    origin: scope.origin
  }) as SiteScope;
}

/**
 * Site authority straight from a job payload, for workers that receive both ids
 * and have no organization-level step to narrow from.
 */
export function jobSiteScope(input: {
  readonly organizationId: string;
  readonly siteId: string;
}): SiteScope {
  return Object.freeze({
    organizationId: input.organizationId,
    siteId: input.siteId,
    origin: "job"
  }) as SiteScope;
}

/** Structured logging context. Never interpolate this into a query. */
export function describeScope(
  scope: OrganizationScope | SiteScope
): Record<string, string> {
  const base = {
    organizationId: scope.organizationId,
    scopeOrigin: scope.origin
  };

  return "siteId" in scope ? { ...base, siteId: scope.siteId } : base;
}
