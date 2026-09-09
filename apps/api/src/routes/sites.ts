import {
  ActiveRunExistsError,
  countPatternsByStatus,
  createSite,
  type Database,
  findActiveRun,
  findRunSamplingHealth,
  findSiteById,
  InvalidSiteUrlError,
  listRuns,
  listSamplingHealth,
  listSites,
  listSnapshotsByImpact,
  SiteHostConflictError,
  type SitemapRunRow,
  type SiteRow,
  type SiteScope,
  siteScopeWithin,
  startRun,
  updateSite
} from "@pattern-aware/database";

import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { withImpactBounds } from "../findings.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import type { RunTrigger } from "../run-trigger.js";
import {
  analyticsQuery,
  errorResponse,
  runSummary,
  runTriggerBody,
  siteAnalyticsResponse,
  siteCreateBody,
  siteDetailResponse,
  siteParams,
  siteSummary,
  sitesResponse,
  siteUpdateBody
} from "../schemas.js";

/** How many of a site's findings the overview carries. */
const SITE_FINDING_LIMIT = 50;

/**
 * Resolve a caller-supplied site id to a VERIFIED scope, or 404.
 *
 * `siteScopeWithin` carries the organization across but cannot verify the site
 * belongs to it — its own doc says the caller owes that check, and
 * `findSiteById` performs it because that query filters on both ids. A site
 * belonging to another organization therefore finds nothing rather than
 * returning their data.
 *
 * SHARED, not inlined, because the M7 defect was exactly this check being
 * present on one route and missing on another: `routes/patterns.ts` built a
 * scope from a caller-supplied `siteId` and never called `findSiteById`, so
 * both pattern routes read another organization's rows. One function means a
 * new site route cannot forget it — the same reason `resolveRunScope` exists in
 * `routes/runs.ts`.
 *
 * Returns the row as well as the scope, because every caller needs it and a
 * second `findSiteById` to fetch it would be a second chance to get it wrong.
 */
async function resolveSiteScope(
  db: Database,
  config: ApiConfig,
  siteId: string
): Promise<{ readonly siteScope: SiteScope; readonly site: SiteRow }> {
  const orgScope = await resolveDefaultOrgScope(db, config);
  const siteScope = siteScopeWithin(orgScope, siteId);
  const site = await findSiteById(db, siteScope);

  if (!site) {
    throw ApiProblem.notFound("SITE_NOT_FOUND", "No such site.");
  }

  return { siteScope, site };
}

/**
 * Sites list + single-site overview.
 *
 * Both routes resolve the organization scope on every request rather than
 * once at startup: `resolveDefaultOrgScope` is memoised internally, so this
 * costs nothing after the first successful lookup, and it means the API
 * comes up fine before `pnpm seed:demo` has run — the first request after
 * seeding just starts working instead of needing a restart.
 */
export function registerSiteRoutes(
  app: ApiInstance,
  db: Database,
  config: ApiConfig,
  runTrigger?: RunTrigger
): void {
  app.get(
    "/sites",
    { schema: { response: { 200: sitesResponse, 503: errorResponse } } },
    async () => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      return { sites: await listSites(db, orgScope) };
    }
  );

  app.get(
    "/sites/:siteId",
    {
      schema: {
        params: siteParams,
        response: {
          200: siteDetailResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const { siteScope, site } = await resolveSiteScope(
        db,
        config,
        request.params.siteId
      );

      const runs = await listRuns(db, siteScope, 1);
      const latestRun = runs[0];

      return {
        site,
        latestRun,
        samplingHealth: latestRun
          ? await findRunSamplingHealth(db, siteScope, latestRun.id)
          : undefined,
        /**
         * The site's own findings, worst first.
         *
         * NOT filtered to `latestRun`. A finding is stamped with the run that
         * produced it, and a site whose newest run is still `running` — or
         * `failed` — would otherwise show an empty findings list while the
         * measurements from its last good run are sitting right there. The
         * ranking is on `impact_score`, so the worst live finding leads
         * regardless of which run published it.
         *
         * Capped, because a site's findings grow with its patterns and this
         * response is a site OVERVIEW; the pattern drill-down is where a
         * finding's full evidence lives.
         */
        findings: (
          await listSnapshotsByImpact(db, siteScope, {
            limit: SITE_FINDING_LIMIT
          })
        ).map(withImpactBounds)
      };
    }
  );

  /**
   * Change a site's configuration. THE FIRST MUTATION IN THIS API.
   *
   * Everything before it was a GET, so two things are true of this route that
   * are not true of any other and are worth stating rather than discovering:
   *
   * NO AUTHENTICATION EXISTS. The organization is still resolved from
   * `DEFAULT_ORGANIZATION_SLUG` through a system scope (ADR-0026), so anyone who
   * can reach this port can edit any site in that organization. That is an
   * internal-only posture, not a reviewed one, and it is the reason CORS must be
   * narrowed and a real session added before this is exposed beyond a developer
   * machine. The web app posts through a Next Server Action, so a browser never
   * calls this directly — but that is a property of the client, not protection
   * of the endpoint.
   *
   * PATCH, not PUT, and the body is a partial. The form sends only fields the
   * user actually changed, so an untouched control cannot overwrite a column
   * somebody else edited between the page load and the save.
   */
  /**
   * Onboard a project.
   *
   * THE API'S SECOND MUTATION, and the first that creates anything. It exists
   * because the Stitch portfolio screen's primary action is "Add New Project"
   * and `createSite` had no caller outside the seed script — the same shape
   * ADR-0034 found for `listSamplingHealth`: a tested, working capability that
   * no HTTP route could reach, so no screen could offer it.
   *
   * WHAT THE REPOSITORY GUARANTEES AND THIS ROUTE THEREFORE DOES NOT REDO. The
   * insert and the partition DDL are one transaction (ADR-0003), so a site row
   * without partitions cannot exist; and `host` is DERIVED from `base_url`
   * rather than accepted, so the bucket the outbound rate limiter throttles on
   * can never disagree with the URL actually requested. Both are properties of
   * `createSite`, not of this handler, which is why the body has no `host`
   * field to send.
   *
   * STILL NO AUTH (ADR-0026). Anyone who can reach this port can onboard a site
   * into the configured organization, and onboarding one creates partitions —
   * an internal-only posture that needs CORS narrowed and a session before it
   * leaves a developer machine.
   */
  app.post(
    "/sites",
    {
      schema: {
        body: siteCreateBody,
        response: {
          201: siteSummary,
          400: errorResponse,
          409: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request, reply) => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      try {
        const { row } = await createSite(db, orgScope, request.body);

        return await reply.code(201).send(row);
      } catch (error) {
        if (error instanceof SiteHostConflictError) {
          throw ApiProblem.conflict(
            "HOST_IN_USE",
            `Another site in this organization already monitors ${error.host}.`
          );
        }

        if (error instanceof InvalidSiteUrlError) {
          // zod already rejects a non-URL; `hostFrom` is what decides whether a
          // URL yields a usable host, and only it can answer that.
          throw new ApiProblem(
            400,
            "INVALID_REQUEST",
            "Base URL is not a valid absolute URL."
          );
        }

        throw error;
      }
    }
  );

  app.patch(
    "/sites/:siteId",
    {
      schema: {
        params: siteParams,
        body: siteUpdateBody,
        response: {
          200: siteSummary,
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request) => {
      /*
       * The membership check runs before the write, via the same helper the
       * read routes use. On a write the consequence of skipping it is worse
       * than a leak — it would be an edit to another tenant's row.
       */
      const { siteScope, site: existing } = await resolveSiteScope(
        db,
        config,
        request.params.siteId
      );

      /**
       * A TIER CHANGE IS REFUSED WHILE A RUN IS IN FLIGHT.
       *
       * Queues are namespaced `{tier}:{siteId}:{stage}`, so re-tiering a site
       * mid-run leaves its already-queued jobs addressed to the old namespace
       * and nothing migrates them — the run would stall with no error, which is
       * the "completed without succeeding" failure shape §1.5 is about. Refusing
       * is the honest option until a migration exists.
       *
       * `findActiveRun` had no callers anywhere before this; the D3a audit
       * listed it among the queries that existed and were reachable by nothing.
       */
      if (
        request.body.tier !== undefined &&
        request.body.tier !== existing.tier
      ) {
        const active = await findActiveRun(db, siteScope);

        if (active) {
          throw ApiProblem.conflict(
            "RUN_IN_FLIGHT",
            `Cannot change tier while run ${active.id} is ${active.status}: queues are namespaced by tier, and nothing migrates work already queued under "${existing.tier}".`
          );
        }
      }

      try {
        const updated = await updateSite(db, siteScope, request.body);

        if (!updated) {
          // Deleted between the read above and this write.
          throw ApiProblem.notFound("SITE_NOT_FOUND", "No such site.");
        }

        return updated;
      } catch (error) {
        if (error instanceof SiteHostConflictError) {
          throw ApiProblem.conflict(
            "HOST_IN_USE",
            `Another site in this organization already monitors ${error.host}.`
          );
        }

        if (error instanceof InvalidSiteUrlError) {
          // Belt and braces: zod already rejects a non-URL, but `hostFrom` is
          // what decides whether a URL yields a usable host.
          throw new ApiProblem(
            400,
            "INVALID_REQUEST",
            "Base URL is not a valid absolute URL."
          );
        }

        throw error;
      }
    }
  );

  /**
   * Start a run. THE FIRST THING IN THIS PLATFORM THAT ACTUALLY STARTS
   * MEASURED WORK over HTTP — every route before this one only read or wrote
   * rows. Before this route existed, nothing could: `scripts/live-run.ts`
   * (a manual, out-of-process script) was the only way to drive a run at
   * all, because nothing called `attachSite` and nothing enqueued `discover`.
   *
   * DOES NOT ENQUEUE `discover` DIRECTLY. Posting to that site's queue would
   * be pointless if nothing is listening on it yet — a newly onboarded site
   * has no `Worker` attached until something calls `attachSite`, which lives
   * in the WORKER process, not this one. So this route posts a small message
   * to `ATTACH_REQUESTS_QUEUE` instead: the worker's own listener attaches
   * the site (a no-op if already attached) and only then starts the run,
   * which is what guarantees the `discover` job always has something
   * listening before it is ever enqueued.
   *
   * `startRun` IS CALLED HERE, SYNCHRONOUSLY, not by the worker. The
   * `sitemap_run` row — and therefore `uq_sitemap_run_one_active_per_site`'s
   * exclusion — has to exist before this responds, so a second call racing
   * the first is rejected by the database rather than by two attach
   * requests both trying to start a run for the same site.
   *
   * STILL NO AUTH (ADR-0026), and this is the route where that matters most
   * so far: anyone who can reach this port can point real HTTP traffic at
   * any site in the configured organization's origin.
   *
   * `runTrigger` MAY BE UNDEFINED. Widening every route's config to require
   * `REDIS_URL` would undo the exact fix `api-config.ts`'s docblock records
   * twice already, so this is injected as its own optional dependency
   * instead (see `run-trigger.ts`) — omitted, a test simply gets a 503
   * rather than needing a live Redis to build the app at all.
   */
  app.post(
    "/sites/:siteId/runs",
    {
      schema: {
        params: siteParams,
        // NULLISH, not just every field within it optional: the ordinary
        // call needs no input at all ("audit this site's own sitemap"), and
        // Fastify's JSON body parser hands a bodyless POST to the validator
        // as `null` rather than `{}` or `undefined` — an all-optional object
        // schema still rejects `null` unless the schema itself allows it.
        body: runTriggerBody.nullish(),
        response: {
          201: runSummary,
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request, reply) => {
      if (runTrigger === undefined) {
        throw new ApiProblem(
          503,
          "RUN_TRIGGER_NOT_CONFIGURED",
          "This deployment has no Redis connection configured for starting runs."
        );
      }

      const { siteScope, site } = await resolveSiteScope(
        db,
        config,
        request.params.siteId
      );

      let run: SitemapRunRow;

      try {
        run = await startRun(db, siteScope, { workerId: "api" });
      } catch (error) {
        if (error instanceof ActiveRunExistsError) {
          throw ApiProblem.conflict(
            "RUN_IN_FLIGHT",
            `Site ${site.id} already has a run in flight.`
          );
        }

        throw error;
      }

      await runTrigger.requestRun({
        organizationId: site.organizationId,
        siteId: site.id,
        tier: site.tier,
        sitemapRunId: run.id,
        sitemapUrl:
          request.body?.sitemapUrl ??
          new URL("/sitemap.xml", site.baseUrl).href,
        baseUrl: site.baseUrl,
        expectedHost: site.host
      });

      return await reply.code(201).send(run);
    }
  );

  /**
   * One site's operational history — the Analytics screen.
   *
   * Under `/sites/:siteId/` rather than a top-level `/analytics?site=` because
   * that would put the tenant boundary on a query string. `siteParams`' UUID
   * validation and the `findSiteById` membership check both key off a path
   * param, and ADR-0028's organization-scoped shape applies only to routes with
   * NO site in the path (`/issues`, `/runs`), which resolve their ids from the
   * scope instead of accepting one.
   *
   * `listSamplingHealth` gets its FIRST CALLER here. It has existed and been
   * tested since M1 and was named in ADR-0028 as one of four queries the
   * database answered that no HTTP route could reach; it was the last one still
   * unreachable.
   */
  app.get(
    "/sites/:siteId/analytics",
    {
      schema: {
        params: siteParams,
        querystring: analyticsQuery,
        response: {
          200: siteAnalyticsResponse,
          400: errorResponse,
          404: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request) => {
      const { siteScope, site } = await resolveSiteScope(
        db,
        config,
        request.params.siteId
      );

      const windows = request.query.windows;

      const [health, runs] = await Promise.all([
        listSamplingHealth(db, siteScope, windows),
        listRuns(db, siteScope, windows)
      ]);

      const latestRun = runs[0];

      return {
        site,
        health,
        windowLimit: windows,
        /*
         * Reversed to OLDEST FIRST. `listRuns` returns newest first, which is
         * right for a list and wrong for a series: a sparkline drawn from it
         * would run backwards in time while looking perfectly plausible.
         */
        runs: [...runs].reverse().map((run) => ({
          id: run.id,
          startedAt: run.startedAt,
          totalUrls: run.totalUrls,
          totalPatterns: run.totalPatterns,
          status: run.status
        })),
        latestRun,
        /*
         * Scoped to the latest run rather than the whole site: a pattern's
         * status belongs to the run that measured it, and summing statuses
         * across runs would count the same pattern once per run.
         */
        patternStatus: latestRun
          ? await countPatternsByStatus(db, siteScope, latestRun.id)
          : []
      };
    }
  );
}
