import { Readable } from "node:stream";
import {
  countPatternsByDepth,
  countPatternsByStatus,
  countRunObservations,
  countSitemapFiles,
  type Database,
  findOrganizationRunById,
  findRunSamplingHealth,
  listOrganizationRuns,
  listPatternsByPopulation,
  listRunObservations,
  listRuns,
  listSitemapFiles,
  type SiteScope,
  siteScopeWithin,
  tallyRunObservations
} from "@pattern-aware/database";

import type { ApiConfig } from "../api-config.js";
import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import { resolveDefaultOrgScope } from "../org-scope.js";
import {
  errorResponse,
  fleetQuery,
  observationQuery,
  runDetailResponse,
  runObservationsResponse,
  runParams,
  runsResponse
} from "../schemas.js";

/**
 * How many of a run's files one response may carry.
 *
 * A run over a 90M-URL site is thousands of files and no reader needs them all
 * at once, so the list is capped and the response sends `fileCount` alongside
 * it — a truncated list presented as the whole run is the failure this pairing
 * exists to prevent. Matches the 200 the observation list uses.
 */
const FILE_PAGE_SIZE = 200;

/**
 * How many runs the history sparkline reaches back over.
 *
 * Also what the trend chip compares against — it takes the first row that
 * is not this run, so opening an older run still finds its predecessor
 * rather than assuming the caller opened the newest.
 */
const RUN_HISTORY_POINTS = 12;

/** How many of the largest patterns the connectivity panel shows. */
const TOP_PATTERN_COUNT = 3;

/** Rows per page while streaming an export. */
const EXPORT_PAGE_SIZE = 500;

/**
 * Absolute ceiling on an exported file.
 *
 * A run's observations are bounded by its sample, so this should never be
 * reached — it exists because an export that silently stopped at a page
 * boundary would be a truncated file presented as a complete one, and a hard
 * limit that announces itself in the file is the lesser failure.
 */
const EXPORT_MAX_ROWS = 100_000;

/**
 * Resolve a run id to a verified site scope.
 *
 * Shared by all three run-detail routes so the membership check cannot be
 * present on one and missing on another. The scope is built from the site id
 * the LOOKUP returned, never from anything the caller sent — which is what
 * makes `siteScopeWithin` safe here (ADR-0029).
 */
async function resolveRunScope(
  db: Database,
  config: ApiConfig,
  runId: string
): Promise<{ readonly siteScope: SiteScope; readonly runId: string }> {
  const orgScope = await resolveDefaultOrgScope(db, config);
  const run = await findOrganizationRunById(db, orgScope, runId);

  if (!run) {
    throw ApiProblem.notFound("RUN_NOT_FOUND", "No such run.");
  }

  return { siteScope: siteScopeWithin(orgScope, run.siteId), runId: run.id };
}

/** RFC 4180 quoting: wrap, and double any embedded quote. */
function csvCell(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }

  return `"${String(value).replaceAll('"', '""')}"`;
}

const CSV_HEADER = [
  "url",
  "pattern",
  "http_status",
  "method",
  "escalated_to_get",
  "is_soft_404",
  "error_reason",
  "response_ms",
  "observed_at"
].join(",");

/**
 * A run's observations as CSV, a page at a time.
 *
 * An async generator rather than a built string: the rows never all exist at
 * once, so the response streams and the process holds one page. See the note at
 * the route for why that matters more as a habit than as a present necessity.
 */
async function* streamObservationCsv(
  db: Database,
  siteScope: SiteScope,
  runId: string
): AsyncGenerator<string> {
  yield `${CSV_HEADER}
`;

  for (let offset = 0; offset < EXPORT_MAX_ROWS; offset += EXPORT_PAGE_SIZE) {
    const page = await listRunObservations(db, siteScope, runId, {
      limit: EXPORT_PAGE_SIZE,
      offset
    });

    if (page.length === 0) {
      return;
    }

    for (const row of page) {
      yield `${[
        csvCell(row.url),
        csvCell(row.patternTemplate),
        csvCell(row.httpStatus),
        csvCell(row.methodUsed),
        csvCell(row.escalatedToGet),
        csvCell(row.isSoft404),
        csvCell(row.errorReason),
        csvCell(row.responseMs),
        csvCell(row.observedAt.toISOString())
      ].join(",")}
`;
    }

    if (page.length < EXPORT_PAGE_SIZE) {
      return;
    }
  }

  // Said in the file itself, not only in a log: a reader opening this needs to
  // know the list stops short.
  yield `"TRUNCATED at ${EXPORT_MAX_ROWS} rows — refine the run or use the API."
`;
}

/**
 * Run history across every site in the organization, plus one run's detail.
 *
 * Scoped the same way as `/issues` and for the same reason: no `siteId` in the
 * path means no membership check to perform here, so the boundary lives in
 * `listOrganizationRuns` and `findOrganizationRunById`, which derive their site
 * ids from the `OrganizationScope` rather than from anything the caller sends
 * (ADR-0028).
 */
export function registerRunRoutes(
  app: ApiInstance,
  db: Database,
  config: ApiConfig
): void {
  app.get(
    "/runs",
    {
      schema: {
        querystring: fleetQuery,
        response: { 200: runsResponse, 400: errorResponse, 503: errorResponse }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      return {
        runs: await listOrganizationRuns(db, orgScope, {
          limit: request.query.limit
        })
      };
    }
  );

  app.get(
    "/runs/:runId",
    {
      schema: {
        params: runParams,
        response: {
          200: runDetailResponse,
          400: errorResponse,
          404: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request) => {
      const orgScope = await resolveDefaultOrgScope(db, config);

      const run = await findOrganizationRunById(
        db,
        orgScope,
        request.params.runId
      );

      if (!run) {
        throw ApiProblem.notFound("RUN_NOT_FOUND", "No such run.");
      }

      /**
       * A `SiteScope` built from the RUN's site id, and that is only safe
       * because of where the id came from.
       *
       * `siteScopeWithin` cannot verify membership — its own doc says the
       * caller owes that check — so building a scope from a caller-supplied id
       * is the M7 cross-tenant defect. Here the id was never supplied: it came
       * back from `findOrganizationRunById`, which can only return runs whose
       * site is in this organization. The membership check happened above, in
       * the lookup, rather than being skipped.
       */
      const siteScope = siteScopeWithin(orgScope, run.siteId);

      /**
       * The run before this one, for the trend chip on the URLs card.
       *
       * Two rows, then the first that is not this run — rather than "the
       * second row", because a caller can open an older run and its
       * predecessor is not simply `runs[1]` of the newest two. Undefined on a
       * first run, which the response models as an absent field rather than a
       * zero: no trend and a total collapse must not render the same.
       */
      const recent = await listRuns(db, siteScope, RUN_HISTORY_POINTS);
      const previous = recent.find((candidate) => candidate.id !== run.id);

      const topPatterns = await listPatternsByPopulation(
        db,
        siteScope,
        run.id,
        TOP_PATTERN_COUNT
      );

      /*
       * The smallest pattern comes from its own ascending read, not from the
       * tail of the list above — that is the smallest of the top N, which is a
       * different and usually wrong answer.
       */
      const [smallestPattern] = await listPatternsByPopulation(
        db,
        siteScope,
        run.id,
        1,
        "asc"
      );

      return {
        run,
        files: await listSitemapFiles(db, siteScope, run.id, {
          limit: FILE_PAGE_SIZE
        }),
        fileCount: await countSitemapFiles(db, siteScope, run.id),
        patternStatus: await countPatternsByStatus(db, siteScope, run.id),
        samplingHealth: await findRunSamplingHealth(db, siteScope, run.id),
        depthDistribution: await countPatternsByDepth(db, siteScope, run.id),
        topPatterns,
        /*
         * Omitted when the smallest is ALREADY IN the top list — not merely
         * when it equals the largest. A run with three patterns shows all
         * three above, so calling one of them out again as "smallest" reads as
         * a rendering bug rather than as extra information. The panel only
         * earns the extra row once there are patterns the top list does not
         * reach.
         */
        smallestPattern: topPatterns.some(
          (candidate) => candidate.id === smallestPattern?.id
        )
          ? undefined
          : smallestPattern,
        previousTotalUrls: previous?.totalUrls,
        httpOutcomes: await tallyRunObservations(db, siteScope, run.id),
        /*
         * Reversed, because `listRuns` is newest-first and a time series
         * reads left to right. Mapped down to the four fields a series
         * needs rather than sending whole run rows the chart would ignore.
         */
        recentRuns: [...recent].reverse().map((point) => ({
          id: point.id,
          startedAt: point.startedAt,
          totalUrls: point.totalUrls,
          totalPatterns: point.totalPatterns,
          status: point.status
        }))
      };
    }
  );

  app.get(
    "/runs/:runId/observations",
    {
      schema: {
        params: runParams,
        querystring: observationQuery,
        response: {
          200: runObservationsResponse,
          400: errorResponse,
          404: errorResponse,
          503: errorResponse
        }
      }
    },
    async (request) => {
      const { siteScope, runId } = await resolveRunScope(
        db,
        config,
        request.params.runId
      );

      const options = {
        limit: request.query.limit,
        offset: request.query.offset,
        ...(request.query.status === undefined
          ? {}
          : { statusClass: request.query.status })
      };

      /**
       * The page and its true total, together.
       *
       * `total` counts PROBES, not URLs — a run over a 40-million-URL site
       * holds a few thousand of these, one per URL actually sampled. The screen
       * pairing them owes the reader that distinction, because a paginated list
       * that reads like a full crawl listing teaches exactly the model this
       * platform exists to refute.
       */
      return {
        observations: await listRunObservations(db, siteScope, runId, options),
        total: await countRunObservations(db, siteScope, runId, {
          ...(request.query.status === undefined
            ? {}
            : { statusClass: request.query.status })
        })
      };
    }
  );

  app.get(
    "/runs/:runId/export.csv",
    {
      /*
       * Params validated, but NO response schema declared — deliberately.
       * The serializer types `reply.send` from the declared shapes, and this
       * route sends a stream rather than an object, so declaring even the error
       * shapes here would make the success path untypeable. Failures still
       * reach `registerErrorHandler` and come back in the standard envelope.
       */
      schema: { params: runParams }
    },
    async (request, reply) => {
      const { siteScope, runId } = await resolveRunScope(
        db,
        config,
        request.params.runId
      );

      void reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="run-${runId}-observations.csv"`
        );

      /**
       * Paged into the response rather than collected and sent.
       *
       * Bounded by the sample rather than the population, so this could not
       * realistically exhaust memory today — but "read every row into an array
       * first" is the exact habit the non-negotiable rules exist to keep out of
       * this codebase, and an export is where it would first look reasonable.
       * The cap is absolute: an export that silently stopped at a page boundary
       * would be a truncated file presented as a complete one.
       */
      return reply.send(
        Readable.from(streamObservationCsv(db, siteScope, runId))
      );
    }
  );
}
