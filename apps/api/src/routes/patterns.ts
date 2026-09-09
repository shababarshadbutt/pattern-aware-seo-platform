import {
  countObservations,
  countPatterns,
  countPatternsByStatus,
  countRunObservations,
  type Database,
  findPatternById,
  findSiteById,
  findSnapshotsByPattern,
  latestPatternSample,
  listObservations,
  listPatternFiles,
  listPatternsRanked,
  listRuns,
  listSnapshotsByPatterns,
  type SitemapRunRow,
  type SiteScope,
  siteScopeWithin,
  sumPatternPopulation
} from "@pattern-aware/database";

import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { rollUpPatternImpact, withImpactBounds } from "../findings.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import {
  errorResponse,
  patternDetailResponse,
  patternParams,
  patternsQuery,
  patternsResponse,
  siteParams
} from "../schemas.js";

/**
 * The run these screens read from.
 *
 * "Latest" is not always the right run to show: a run that is still `pending`
 * or `running` has no finished patterns yet, and a `failed` run's rows are
 * not trustworthy. `degraded` (finished with some patterns blocked/needs
 * review) is still a real result and belongs on screen, so it counts as
 * complete for this purpose. `listRuns` already orders newest first, so the
 * first match here is the most recent usable run.
 */
async function latestCompleteRun(
  db: Database,
  siteScope: SiteScope
): Promise<SitemapRunRow | undefined> {
  const runs = await listRuns(db, siteScope, 10);

  return runs.find(
    (run) => run.status === "complete" || run.status === "degraded"
  );
}

/**
 * Confirm the site exists AND belongs to the resolved organization.
 *
 * Every route below reads rows keyed on `siteId`, and the repositories for
 * runs, patterns, samples and observations all filter on `site_id` alone —
 * correctly, since a `SiteScope` is supposed to have been vouched for already.
 * `siteScopeWithin` explicitly does not vouch for it: it carries the
 * organization across but cannot check membership, and says so. Without this
 * call a caller-supplied `siteId` reads another organization's data. Latent
 * today because one organization exists; a cross-tenant read the moment that
 * changes.
 */
async function assertSiteInOrg(
  db: Database,
  siteScope: SiteScope
): Promise<void> {
  if (!(await findSiteById(db, siteScope))) {
    throw ApiProblem.notFound("SITE_NOT_FOUND", "No such site.");
  }
}

/**
 * Pattern list for a site's latest usable run, and single-pattern detail with
 * its sample evidence (individual observations + published findings).
 */
export function registerPatternRoutes(
  app: ApiInstance,
  db: Database,
  config: ApiConfig
): void {
  app.get(
    "/sites/:siteId/patterns",
    {
      schema: {
        params: siteParams,
        querystring: patternsQuery,
        response: {
          200: patternsResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      await assertSiteInOrg(db, siteScope);

      const { sort, status, limit, offset } = request.query;
      const run = await latestCompleteRun(db, siteScope);

      if (!run) {
        /**
         * NOT a 404. The site exists; it has no finished run yet. Returning
         * "not found" made a freshly-onboarded site look identical to a typo
         * in the URL, and the screen could not tell the reader which it was.
         */
        return {
          sitemapRunId: null,
          patterns: [],
          total: 0,
          sort,
          status,
          statusCounts: [],
          observedUrls: 0,
          totalUrls: 0
        };
      }

      const patterns = await listPatternsRanked(db, siteScope, run.id, {
        sort,
        status,
        limit,
        offset
      });

      /**
       * One query for the whole page's findings, not one per row.
       *
       * Grouped in memory afterwards because the grouping is over at most a
       * page of patterns — the expensive part was the round trips.
       */
      const findings = await listSnapshotsByPatterns(
        db,
        siteScope,
        patterns.map((pattern) => pattern.id)
      );

      const byPattern = new Map<string, (typeof findings)[number][]>();

      for (const finding of findings) {
        const bucket = byPattern.get(finding.patternId);

        if (bucket) {
          bucket.push(finding);
        } else {
          byPattern.set(finding.patternId, [finding]);
        }
      }

      /**
       * `total` and `statusCounts` come from their own queries over the whole
       * run, never from `patterns.length`. A card that counts the page and
       * labels it the run is the defect D3a found on both fleet screens, and
       * the filter reaches `total` so the footer describes the same collection
       * the rows do.
       */
      const [total, statusCounts, observedUrls] = await Promise.all([
        countPatterns(db, siteScope, run.id, { status }),
        countPatternsByStatus(db, siteScope, run.id),
        countRunObservations(db, siteScope, run.id, {})
      ]);

      return {
        sitemapRunId: run.id,
        patterns: patterns.map((pattern) => {
          const own = byPattern.get(pattern.id) ?? [];
          const impact = rollUpPatternImpact(own);
          /**
           * Ranked on the POINT score, never a bound — ranking on an upper
           * bound floats the least-understood findings to the top, since a wide
           * interval means thin evidence rather than a big problem. The same
           * rule `listSnapshotsByImpact` documents.
           */
          const worst = own.reduce<(typeof own)[number] | undefined>(
            (worstSoFar, finding) =>
              worstSoFar === undefined ||
              finding.impactScore > worstSoFar.impactScore
                ? finding
                : worstSoFar,
            undefined
          );

          return {
            ...pattern,
            /**
             * `rankScore` is deliberately NOT sent. It is a bare summed point
             * value with no interval, kept in the repository so paging can
             * happen in SQL; shipping it would put a sampled figure on the wire
             * that a screen could render bare. `impact` carries the same total
             * with its bounds.
             */
            rankScore: undefined,
            findingCount: pattern.findingCount,
            impact,
            worstHttpStatus: worst?.httpStatus,
            worstSeverityClass: worst?.severityClass
          };
        }),
        total,
        sort,
        status,
        statusCounts,
        observedUrls,
        totalUrls: run.totalUrls
      };
    }
  );

  app.get(
    "/sites/:siteId/patterns/:patternId",
    {
      schema: {
        params: patternParams,
        response: {
          200: patternDetailResponse,
          400: errorResponse,
          404: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);
      const siteScope = siteScopeWithin(orgScope, request.params.siteId);

      await assertSiteInOrg(db, siteScope);

      const pattern = await findPatternById(
        db,
        siteScope,
        request.params.patternId
      );

      if (!pattern) {
        throw ApiProblem.notFound("PATTERN_NOT_FOUND", "No such pattern.");
      }

      const sample = await latestPatternSample(db, siteScope, pattern.id);
      const findings = await findSnapshotsByPattern(db, siteScope, pattern.id);

      return {
        pattern,
        latestSample: sample,
        findings: findings.map(withImpactBounds),
        observations: sample
          ? await listObservations(db, siteScope, sample.id, 200)
          : [],
        /**
         * Where this pattern's URLs actually live, and the population summed
         * from those same rows.
         *
         * `listPatternFiles` is counts per file, never URLs — a pattern with
         * 40 million URLs has one row here per file it appears in. The sum is
         * sent because it can DISAGREE with `pattern.populationCount`: the two
         * are written by different steps, and a mismatch means a file was
         * parsed twice or not at all. That is the M6 undercount hazard, where a
         * crash between an in-memory accumulation and its single end-of-run
         * write leaves a run finishing "clean" with a population permanently
         * short. Showing both is what makes it visible.
         */
        files: await listPatternFiles(db, siteScope, pattern.id),
        populationFromFiles: await sumPatternPopulation(
          db,
          siteScope,
          pattern.id
        ),
        /**
         * The `n` of the estimate, as distinct from what was drawn. A gap
         * against `latestSample.sampleSize` is a verification pass that did
         * not finish, which otherwise reads as a smaller sample nobody
         * ordered.
         */
        observedCount: sample
          ? await countObservations(db, siteScope, sample.id)
          : 0
      };
    }
  );
}
