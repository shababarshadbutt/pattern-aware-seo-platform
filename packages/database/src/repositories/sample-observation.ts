import { and, desc, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
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
