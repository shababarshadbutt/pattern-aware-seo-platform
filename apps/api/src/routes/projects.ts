import { Readable } from "node:stream";

import {
  countOrganizationSnapshotsBySeverity,
  countSites,
  type Database,
  type ListSitesOptions,
  latestRunPerSite,
  listSites,
  type SeverityClassName,
  type SitemapRunRow,
  type SiteRow
} from "@pattern-aware/database";

import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import { projectsQuery, projectsResponse } from "../schemas.js";

/**
 * The fleet portfolio: every site in the organization, with what is known
 * about each.
 *
 * NAMED FOR THE DESIGN'S LABEL, KEYED ON THE PRODUCT'S ENTITY. "Projects" is
 * what the Stitch navigation rail calls the sites list and what the screen is
 * titled; `site` is the entity, and `/sites` remains its collection — creating
 * one is still `POST /sites`. This is the same split `Crawls` → `/runs` already
 * makes (ADR-0027): a presentational label does not rename a table.
 *
 * WHY THIS IS A SEPARATE ROUTE FROM `GET /sites`. That route returns site rows.
 * This one returns a READ MODEL assembled from three tables, shaped for one
 * screen — the row plus its latest run plus its findings by severity. Widening
 * `GET /sites` to carry all of it would make every existing caller pay for
 * aggregates it does not read, and would put the fleet's totals on a response
 * whose name promises a list.
 *
 * THREE QUERIES, NOT ONE PER ROW. `listSites` pages the window,
 * `latestRunPerSite` and `countOrganizationSnapshotsBySeverity` each answer for
 * the whole organization in a single pass. The obvious implementation — loop
 * the page, ask per site — is a query per row, which is fine at eighteen sites
 * and is precisely the shape that stops being fine with nobody noticing.
 *
 * ADR-0037.
 */
export function registerProjectRoutes(
  app: ApiInstance,
  db: Database,
  config: ApiConfig
): void {
  app.get(
    "/projects",
    {
      schema: {
        querystring: projectsQuery,
        response: { 200: projectsResponse }
      }
    },
    async (request) => {
      const scope = await resolveDefaultOrgScope(db, config);
      const filters: ListSitesOptions = {
        includeInactive: request.query.includeInactive,
        ...(request.query.tier === undefined
          ? {}
          : { tier: request.query.tier })
      };

      const [page, total, runs, severities, allMatching] = await Promise.all([
        listSites(db, scope, {
          ...filters,
          limit: request.query.limit,
          offset: request.query.offset
        }),
        countSites(db, scope, filters),
        latestRunPerSite(db, scope),
        countOrganizationSnapshotsBySeverity(db, scope),
        /*
         * The whole matching set, for the fleet totals below. Separate from the
         * page deliberately: a KPI card computed from the page and labelled the
         * fleet is the D3a defect, where both fleet screens counted 50 rows and
         * called it the total. `site` is a small, unpartitioned table — this is
         * a cheap read, and the totals being wrong is not cheap.
         */
        listSites(db, scope, filters)
      ]);

      const findingsBySite = groupSeverities(severities);

      return {
        projects: page.map((site) => projectRow(site, runs, findingsBySite)),
        total,
        totals: fleetTotals(allMatching, runs, findingsBySite)
      };
    }
  );

  app.get(
    "/projects/export.csv",
    {
      /*
       * No response schema, for the reason `GET /runs/:runId/export.csv` has
       * none: the serializer types `reply.send` from the declared shapes and
       * this route sends a stream. Failures still reach `registerErrorHandler`.
       */
      schema: { querystring: projectsQuery }
    },
    async (request, reply) => {
      const scope = await resolveDefaultOrgScope(db, config);
      const filters: ListSitesOptions = {
        includeInactive: request.query.includeInactive,
        ...(request.query.tier === undefined
          ? {}
          : { tier: request.query.tier })
      };

      const [sites, runs, severities] = await Promise.all([
        /*
         * The whole matching set, NOT the screen's page — an export of what you
         * happened to be looking at, named "portfolio", is a truncated file
         * presented as a complete one. Bounded by the site table, which is one
         * row per monitored domain and cannot grow the way an observation list
         * does, so there is no truncation notice to write here.
         */
        listSites(db, scope, filters),
        latestRunPerSite(db, scope),
        countOrganizationSnapshotsBySeverity(db, scope)
      ]);

      const findingsBySite = groupSeverities(severities);

      void reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          'attachment; filename="projects-portfolio.csv"'
        );

      return reply.send(
        Readable.from(streamPortfolioCsv(sites, runs, findingsBySite))
      );
    }
  );
}

/**
 * Severity classes this platform treats as damage.
 *
 * `blocked` and `unknown` are absent and that is the load-bearing part:
 * `schema/enums.ts` gives both a zero severity weight because a host refusing
 * us is not a site defect, and `severityTone` already maps both to `unknown`
 * rather than a warning. Counting them here would let a WAF turn a healthy
 * client into a fleet-wide "requires triage".
 *
 * `redirect_single` is excluded too: one hop is a working URL, ranked below
 * every real fault by the ADR-0014 table.
 */
const CRITICAL_SEVERITIES: ReadonlySet<SeverityClassName> = new Set([
  "gone",
  "not_found",
  "soft_not_found",
  "server_error",
  "redirect_chain"
]);

interface SiteFindings {
  readonly total: number;
  readonly critical: number;
  readonly bySeverity: readonly {
    readonly severityClass: SeverityClassName;
    readonly count: number;
  }[];
}

function groupSeverities(
  rows: readonly {
    readonly siteId: string;
    readonly severityClass: SeverityClassName;
    readonly count: number;
  }[]
): ReadonlyMap<string, SiteFindings> {
  const grouped = new Map<
    string,
    { total: number; critical: number; bySeverity: SiteFindings["bySeverity"] }
  >();

  for (const row of rows) {
    const entry = grouped.get(row.siteId) ?? {
      total: 0,
      critical: 0,
      bySeverity: []
    };

    grouped.set(row.siteId, {
      total: entry.total + row.count,
      critical:
        entry.critical +
        (CRITICAL_SEVERITIES.has(row.severityClass) ? row.count : 0),
      bySeverity: [
        ...entry.bySeverity,
        { severityClass: row.severityClass, count: row.count }
      ]
    });
  }

  return grouped;
}

const NO_FINDINGS: SiteFindings = { total: 0, critical: 0, bySeverity: [] };

function projectRow(
  site: SiteRow,
  runs: ReadonlyMap<string, SitemapRunRow>,
  findingsBySite: ReadonlyMap<string, SiteFindings>
) {
  const latestRun = runs.get(site.id);

  return {
    site,
    /*
     * Absent rather than a zeroed placeholder. A site onboarded ten minutes ago
     * and a site whose run found nothing are different facts, and a row of
     * zeros says the second while meaning the first — the section 1.5 shape.
     */
    ...(latestRun === undefined ? {} : { latestRun }),
    findings: findingsBySite.get(site.id) ?? NO_FINDINGS
  };
}

/**
 * The fleet figures the KPI cards carry.
 *
 * `urlsDiscovered` and `patterns` sum each site's LATEST run, not every run it
 * has ever had: three runs over the same site discovered the same URLs three
 * times, and adding them would report a fleet several times its real size.
 * The label on the card says "discovered", never "crawled" — this platform
 * samples a population, it does not request all of it.
 */
function fleetTotals(
  sites: readonly SiteRow[],
  runs: ReadonlyMap<string, SitemapRunRow>,
  findingsBySite: ReadonlyMap<string, SiteFindings>
) {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let urlsDiscovered = 0;
  let patterns = 0;
  let findings = 0;
  let criticalFindings = 0;
  let onboardedRecently = 0;

  for (const site of sites) {
    const run = runs.get(site.id);

    urlsDiscovered += run?.totalUrls ?? 0;
    patterns += run?.totalPatterns ?? 0;

    const siteFindings = findingsBySite.get(site.id) ?? NO_FINDINGS;

    findings += siteFindings.total;
    criticalFindings += siteFindings.critical;

    if (site.createdAt.getTime() >= thirtyDaysAgo) {
      onboardedRecently += 1;
    }
  }

  return {
    sites: sites.length,
    onboardedRecently,
    urlsDiscovered,
    patterns,
    findings,
    criticalFindings
  };
}

/** RFC 4180 quoting: wrap, and double any embedded quote. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }

  return `"${String(value).replaceAll('"', '""')}"`;
}

const CSV_HEADER = [
  "name",
  "host",
  "base_url",
  "tier",
  "is_active",
  "onboarded_at",
  "last_run_status",
  "last_run_started_at",
  "urls_discovered",
  "patterns",
  "findings",
  "critical_findings"
].join(",");

/**
 * The portfolio as CSV.
 *
 * A generator like the observation export, though the honest reason differs:
 * that one streams because a run's probes genuinely do not fit in memory, and
 * this one is one row per monitored domain. It is written the same way anyway,
 * because "collect it all into an array first" is the habit the non-negotiable
 * rules exist to keep out of this codebase, and an export is exactly where it
 * looks harmless.
 *
 * COLUMN NAMES SAY WHAT THE FIGURES ARE. `urls_discovered`, not
 * `total_crawled`: a spreadsheet outlives the screen that produced it, and a
 * column headed "crawled" teaches the reader the model this product exists to
 * refute. There is no health-score column because there is no health score.
 */
function* streamPortfolioCsv(
  sites: readonly SiteRow[],
  runs: ReadonlyMap<string, SitemapRunRow>,
  findingsBySite: ReadonlyMap<string, SiteFindings>
): Generator<string> {
  yield `${CSV_HEADER}\n`;

  for (const site of sites) {
    const run = runs.get(site.id);
    const findings = findingsBySite.get(site.id) ?? NO_FINDINGS;

    yield `${[
      csvCell(site.name),
      csvCell(site.host),
      csvCell(site.baseUrl),
      csvCell(site.tier),
      csvCell(site.isActive),
      csvCell(site.createdAt.toISOString()),
      csvCell(run?.status ?? null),
      csvCell(run?.startedAt?.toISOString() ?? null),
      csvCell(run?.totalUrls ?? null),
      csvCell(run?.totalPatterns ?? null),
      csvCell(findings.total),
      csvCell(findings.critical)
    ].join(",")}\n`;
  }
}
