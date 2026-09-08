import { and, desc, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { pattern } from "../schema/pattern.js";
import { sampleObservation } from "../schema/sampling.js";
import type { SiteScope } from "../scope.js";

/**
 * What a probe found, one row per sampled URL.
 *
 * APPEND-ONLY, and that is a correction to the legacy engine rather than a
 * preference: it deleted a pattern's sampled URLs before every insert, which
 * destroyed exactly the history that trends, regression detection and any
 * future model training depend on. Nothing here updates or deletes.
 *
 * Uniqueness is on the URL within a draw, NOT on `url_hash` — see migration
 * 0001. The hash is chosen for distribution, and the min-heap retains the
 * smallest hashes, so hash collisions cluster precisely in the retained sample
 * and a hash-keyed constraint silently rejected real observations.
 */

export type HttpMethodUsed = "HEAD" | "GET";

export interface SampleObservationInsert {
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly sitemapFileId?: string | null;
  readonly locOrdinal?: number | null;
  readonly urlHash: number;
  readonly url: string;
  readonly stratumLabel?: string | null;
  readonly httpStatus?: number | null;
  readonly methodUsed?: HttpMethodUsed | null;
  readonly escalatedToGet?: boolean;
  readonly isSoft404?: boolean;
  readonly errorReason?: string | null;
  readonly responseMs?: number | null;
}

/**
 * Append a batch of observations.
 *
 * Conflicts are ignored rather than updated: a retried verify job re-probing
 * the same URL within the same draw must not overwrite the first result, both
 * because that first result is the one an estimate may already have been
 * computed from, and because two differing results for one URL is itself a
 * signal worth keeping rather than collapsing.
 *
 * Returns how many rows were actually written, which is not always what was
 * passed — the difference is a retry's duplicates, and a caller that reports
 * the input length instead would overstate `n`.
 */
export async function appendSampleObservations(
  db: Database,
  scope: SiteScope,
  observations: readonly SampleObservationInsert[]
): Promise<number> {
  if (observations.length === 0) {
    return 0;
  }

  const written = await internalDatabase(db)
    .insert(sampleObservation)
    .values(
      observations.map((observation) => ({
        siteId: scope.siteId,
        patternId: observation.patternId,
        patternSampleId: observation.patternSampleId,
        sitemapFileId: observation.sitemapFileId ?? null,
        locOrdinal: observation.locOrdinal ?? null,
        urlHash: observation.urlHash,
        url: observation.url,
        stratumLabel: observation.stratumLabel ?? null,
        httpStatus: observation.httpStatus ?? null,
        methodUsed: observation.methodUsed ?? null,
        escalatedToGet: observation.escalatedToGet ?? false,
        isSoft404: observation.isSoft404 ?? false,
        errorReason: observation.errorReason ?? null,
        responseMs: observation.responseMs ?? null
      }))
    )
    .onConflictDoNothing({
      target: [
        sampleObservation.siteId,
        sampleObservation.patternSampleId,
        sampleObservation.url
      ]
    })
    .returning({ id: sampleObservation.id });

  return written.length;
}

export interface ObservationTally {
  readonly httpStatus: number | null;
  readonly isSoft404: boolean;
  readonly count: number;
}

/**
 * Outcomes for one draw, grouped the way the estimator consumes them.
 *
 * Aggregated in the database rather than by reading rows into memory: this
 * query runs once per pattern on a site with thousands of them, and the
 * per-URL rows are never needed — only the counts per distinct outcome.
 */
export async function tallyObservations(
  db: Database,
  scope: SiteScope,
  patternSampleId: string
): Promise<readonly ObservationTally[]> {
  const rows = await internalDatabase(db)
    .select({
      httpStatus: sampleObservation.httpStatus,
      isSoft404: sampleObservation.isSoft404,
      // A string, because node-postgres returns bigint as one rather than
      // guessing at a value that may exceed a JS safe integer.
      count: sql<string>`count(*)::bigint`
    })
    .from(sampleObservation)
    .where(
      and(
        eq(sampleObservation.siteId, scope.siteId),
        eq(sampleObservation.patternSampleId, patternSampleId)
      )
    )
    .groupBy(sampleObservation.httpStatus, sampleObservation.isSoft404);

  return rows.map((row) => ({
    httpStatus: row.httpStatus,
    isSoft404: row.isSoft404,
    count: Number(row.count)
  }));
}

export interface SampleObservationRow {
  readonly id: string;
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly url: string;
  readonly urlHash: number;
  readonly httpStatus: number | null;
  readonly methodUsed: HttpMethodUsed | null;
  readonly escalatedToGet: boolean;
  readonly isSoft404: boolean;
  readonly errorReason: string | null;
  readonly responseMs: number | null;
  readonly observedAt: Date;
}

const OBSERVATION_COLUMNS = {
  id: sampleObservation.id,
  patternId: sampleObservation.patternId,
  patternSampleId: sampleObservation.patternSampleId,
  url: sampleObservation.url,
  urlHash: sampleObservation.urlHash,
  httpStatus: sampleObservation.httpStatus,
  methodUsed: sampleObservation.methodUsed,
  escalatedToGet: sampleObservation.escalatedToGet,
  isSoft404: sampleObservation.isSoft404,
  errorReason: sampleObservation.errorReason,
  responseMs: sampleObservation.responseMs,
  observedAt: sampleObservation.observedAt
} as const;

/**
 * Individual probed URLs for one draw, most recently observed first.
 *
 * The sample-evidence screen's job is "show me exactly which URLs were
 * checked and what came back" — a tally answers "how many," this answers
 * "which ones." Capped rather than unbounded: a draw is at most
 * `SAMPLE_MAX_EXPANDED` (1,200 by default), so a page-sized limit here is a
 * display concern, not a correctness one.
 */
export async function listObservations(
  db: Database,
  scope: SiteScope,
  patternSampleId: string,
  limit = 100
): Promise<readonly SampleObservationRow[]> {
  return internalDatabase(db)
    .select(OBSERVATION_COLUMNS)
    .from(sampleObservation)
    .where(
      and(
        eq(sampleObservation.siteId, scope.siteId),
        eq(sampleObservation.patternSampleId, patternSampleId)
      )
    )
    .orderBy(desc(sampleObservation.observedAt))
    .limit(limit);
}

/** How many URLs have been observed for one draw. The `n` of an estimate. */
export async function countObservations(
  db: Database,
  scope: SiteScope,
  patternSampleId: string
): Promise<number> {
  const [row] = await internalDatabase(db)
    .select({ count: sql<string>`count(*)::bigint` })
    .from(sampleObservation)
    .where(
      and(
        eq(sampleObservation.siteId, scope.siteId),
        eq(sampleObservation.patternSampleId, patternSampleId)
      )
    );

  return Number(row?.count ?? 0);
}

/** An observation carrying the pattern it belongs to, for a run-wide listing. */
export interface RunObservationRow extends SampleObservationRow {
  readonly patternTemplate: string;
}

/** Which HTTP outcomes an explorer may filter to. */
export type HttpStatusClass =
  | "ok"
  | "redirect"
  | "client_error"
  | "server_error"
  | "error";

function statusClassPredicate(statusClass: HttpStatusClass) {
  switch (statusClass) {
    case "ok":
      return sql`${sampleObservation.httpStatus} between 200 and 299`;
    case "redirect":
      return sql`${sampleObservation.httpStatus} between 300 and 399`;
    case "client_error":
      return sql`${sampleObservation.httpStatus} between 400 and 499`;
    case "server_error":
      return sql`${sampleObservation.httpStatus} >= 500`;
    // A probe that never got a status at all — a timeout, a DNS failure, a
    // refused connection. Distinct from a 5xx: the server did not answer, so
    // there is nothing to classify, and folding it into "server error" would
    // report a site defect where there may be none.
    case "error":
      return sql`${sampleObservation.httpStatus} is null`;
  }
}

/**
 * Every observation in a run, newest first.
 *
 * THESE ARE THE SAMPLE, NOT THE POPULATION, and a caller rendering them owes
 * the reader that distinction. A run over a 40-million-URL site holds at most a
 * few thousand rows here — one per URL actually probed — so a paginated list of
 * them that reads like a full crawl listing would teach precisely the model this
 * platform exists to refute.
 *
 * `sample_observation` carries no `sitemap_run_id`, so run scope is reached by
 * joining `pattern`, which does. The join pairs `site_id` with `id` because
 * both tables are partitioned by `site_id` under a composite primary key
 * (ADR-0010) — that pairing is what keeps it inside one partition, and it is
 * the same pairing the post-M3 hardening pass added FKs for.
 *
 * KNOWN COST, stated rather than discovered later:
 * `idx_sample_observation_pattern_observed` serves pattern scope, not run
 * scope, so this is a partition scan joined to the run's patterns. It is
 * bounded by how many URLs were PROBED, never by how many exist, which is the
 * difference between thousands and tens of millions — but do not repurpose it
 * for anything population-shaped.
 */
export async function listRunObservations(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  options: {
    readonly limit?: number;
    readonly offset?: number;
    readonly statusClass?: HttpStatusClass;
  } = {}
): Promise<readonly RunObservationRow[]> {
  const conditions = [
    eq(sampleObservation.siteId, scope.siteId),
    eq(pattern.sitemapRunId, sitemapRunId)
  ];

  if (options.statusClass !== undefined) {
    conditions.push(statusClassPredicate(options.statusClass));
  }

  const rows = await internalDatabase(db)
    .select({ ...OBSERVATION_COLUMNS, patternTemplate: pattern.template })
    .from(sampleObservation)
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, sampleObservation.siteId),
        eq(pattern.id, sampleObservation.patternId)
      )
    )
    .where(and(...conditions))
    /*
     * A tie-break on id, because `observed_at` is not unique — a batch of
     * probes written together shares a timestamp, and without a deterministic
     * second key the same row can appear on two pages of an offset-paged list
     * while another never appears at all.
     */
    .orderBy(desc(sampleObservation.observedAt), desc(sampleObservation.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  return rows;
}

/**
 * How many observations a run holds — the honest denominator for a paged list.
 *
 * Counts PROBES, not URLs. A screen pairing this with "of N" must say which,
 * since the two differ by the whole point of the product.
 */
export async function countRunObservations(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  options: { readonly statusClass?: HttpStatusClass } = {}
): Promise<number> {
  const conditions = [
    eq(sampleObservation.siteId, scope.siteId),
    eq(pattern.sitemapRunId, sitemapRunId)
  ];

  if (options.statusClass !== undefined) {
    conditions.push(statusClassPredicate(options.statusClass));
  }

  const [row] = await internalDatabase(db)
    .select({ count: sql<string>`count(*)::bigint` })
    .from(sampleObservation)
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, sampleObservation.siteId),
        eq(pattern.id, sampleObservation.patternId)
      )
    )
    .where(and(...conditions));

  return Number(row?.count ?? 0);
}

/**
 * Outcomes across a whole run, grouped the same way {@link tallyObservations}
 * groups one draw.
 *
 * Aggregated in the database rather than by paging rows and counting in
 * application code: the explorer already reads observations a page at a time,
 * and a distribution built from one page would describe the page rather than
 * the run — the same error the depth histogram avoids by grouping in SQL.
 *
 * Run scope comes from the paired `pattern` join, exactly as
 * {@link listRunObservations} does, and carries the same caveat: bounded by how
 * many URLs were PROBED, never by how many exist.
 *
 * `isSoft404` travels alongside the status because a 200 that is really a
 * missing page is not a healthy 200, and a chart that folded the two together
 * would report a site as fine while a fifth of its sample was a soft 404.
 */
export async function tallyRunObservations(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<readonly ObservationTally[]> {
  const rows = await internalDatabase(db)
    .select({
      httpStatus: sampleObservation.httpStatus,
      isSoft404: sampleObservation.isSoft404,
      count: sql<string>`count(*)::bigint`
    })
    .from(sampleObservation)
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, sampleObservation.siteId),
        eq(pattern.id, sampleObservation.patternId)
      )
    )
    .where(
      and(
        eq(sampleObservation.siteId, scope.siteId),
        eq(pattern.sitemapRunId, sitemapRunId)
      )
    )
    .groupBy(sampleObservation.httpStatus, sampleObservation.isSoft404)
    .orderBy(sampleObservation.httpStatus);

  return rows.map((row) => ({
    httpStatus: row.httpStatus,
    isSoft404: row.isSoft404,
    count: Number(row.count)
  }));
}

/** What a run's probes cost, in requests rather than in checks. */
export interface RunRequestSummary {
  /** Probes recorded — one row per URL actually requested. */
  readonly probes: number;
  /** Probes that cost a GET on top of their HEAD. */
  readonly getEscalations: number;
  /** `probes + getEscalations`. A LOWER BOUND — see the function's docblock. */
  readonly httpRequests: number;
  /**
   * Probes that got no response at all, which is the width of the bound above:
   * each of these cost one request or two, and the row cannot say which.
   */
  readonly noResponseProbes: number;
}

/**
 * What a run actually spent at the origin, charged per REQUEST not per check.
 *
 * Re-derived from the rows rather than accumulated in the worker because the
 * pipeline dispatches every stage as an independent job — `runVerify`'s
 * `requestCount` never reaches `runFinalize`, which is a separate job in a
 * possibly separate process. Deriving is also the more accurate of the two:
 * `ProbeResult.requestCount` resets per profile-ladder rung and `probeUrl`
 * returns only the last rung's result, so the in-memory counter under-counts a
 * retried probe.
 *
 * THE CHARGING RULE, which is the whole reason this is not `count(*)`: an
 * escalated check is a HEAD plus a GET and costs two. Charging per logical
 * check is the measured legacy defect M5 fixed — a nominal 25 req/s ceiling
 * that sustained ~49 req/s because escalations were free in the accounting.
 *
 * `httpRequests` IS A FLOOR, NOT AN EXACT COST, and the three sources of slack
 * are named here rather than discovered later:
 *   - a probe that got no response is charged one and may have cost two (the
 *     transport `catch` in `probe.ts` returns `escalatedToGet: false`),
 *   - a URL probed twice by a retried job writes one row under
 *     `uq_sample_observation_sample_url` and is charged once,
 *   - a multi-rung profile ladder writes one row for several attempts.
 * It is exact for every probe that got a status, INCLUDING the method-rejection
 * path behind the `HEAD_NOT_SUPPORTED` verdict, which sets `escalated_to_get`
 * and so charges two. `noResponseProbes` is returned so the slack is visible to
 * a caller instead of hidden inside one number. Persisting an exact
 * `request_count` per observation is the change to make if the bound ever
 * matters — see ADR-0034.
 *
 * DELIBERATELY EXCLUDED: the sitemap index and file downloads the discover and
 * ingest stages perform. Those are real requests, but this figure is paired
 * with URLs discovered to answer "how much of the population did we have to
 * touch", and folding a fixed per-run download cost into that ratio would
 * misreport the sampling design's efficiency. This is PROBE cost.
 *
 * Run scope comes from the paired `pattern` join for the reason
 * {@link listRunObservations} documents, and carries the same cost caveat:
 * bounded by how many URLs were PROBED, never by how many exist.
 */
export async function summariseRunRequests(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<RunRequestSummary> {
  const [row] = await internalDatabase(db)
    .select({
      probes: sql<string>`count(*)::bigint`,
      escalations: sql<string>`count(*) filter (where ${sampleObservation.escalatedToGet})::bigint`,
      noResponse: sql<string>`count(*) filter (where ${sampleObservation.httpStatus} is null)::bigint`
    })
    .from(sampleObservation)
    .innerJoin(
      pattern,
      and(
        eq(pattern.siteId, sampleObservation.siteId),
        eq(pattern.id, sampleObservation.patternId)
      )
    )
    .where(
      and(
        eq(sampleObservation.siteId, scope.siteId),
        eq(pattern.sitemapRunId, sitemapRunId)
      )
    );

  const probes = Number(row?.probes ?? 0);
  const getEscalations = Number(row?.escalations ?? 0);

  return {
    probes,
    getEscalations,
    httpRequests: probes + getEscalations,
    noResponseProbes: Number(row?.noResponse ?? 0)
  };
}
