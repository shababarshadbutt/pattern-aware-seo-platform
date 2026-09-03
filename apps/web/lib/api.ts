/**
 * Typed client for `apps/api`.
 *
 * Deliberately its own small fetch layer rather than reusing
 * `@pattern-aware/shared`'s `getConfig()`: that schema requires `DATABASE_URL`
 * and `REDIS_URL`, which this process has no reason to hold or validate — the
 * web app only ever talks to the API over HTTP, never to Postgres directly.
 * `API_URL` is read on its own, with the same dev-default the API itself
 * binds to.
 *
 * Every shape below mirrors a `packages/database` repository row as it comes
 * back over JSON: `Date` columns arrive as ISO strings (Fastify's default
 * JSON serialization calls `Date#toJSON()`), and every `bigint` column in the
 * schema is declared `{ mode: "number" }`, so population counts, URL counts
 * and hashes all arrive as plain `number` — see packages/database/src/schema.
 */

const API_URL = process.env.WEB_API_URL ?? "http://localhost:3001";

/** Thrown for a reachable API that answered with an error status. */
export class ApiError extends Error {
  public override readonly name = "ApiError";

  public constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  let response: Response;

  try {
    // No-store: every screen here is a live operational read (run status,
    // sampling health, latest findings), not content that should survive a
    // stale cache between one manual-test click and the next.
    response = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  } catch (error) {
    throw new ApiError(
      0,
      `Could not reach the API at ${API_URL}${path}. Is "pnpm dev" running the api workspace? (${(error as Error).message})`
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new ApiError(
      response.status,
      `${response.status} ${response.statusText} from ${path}${body ? `: ${body}` : ""}`
    );
  }

  return (await response.json()) as T;
}

// --- Sites ---------------------------------------------------------------

export type SiteTier = "standard" | "priority" | "bulk";

export interface SiteSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly host: string;
  readonly tier: SiteTier;
  readonly isActive: boolean;
  readonly dailyRequestCap: number | null;
  readonly minRequestIntervalMs: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export type RunStatus =
  | "pending"
  | "running"
  | "complete"
  | "degraded"
  | "failed"
  | "cancelled";

export interface SitemapRunSummary {
  readonly id: string;
  readonly siteId: string;
  readonly status: RunStatus;
  readonly statusReason: string | null;
  readonly isDryRun: boolean;
  readonly workerId: string | null;
  readonly heartbeatAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly totalFiles: number;
  readonly parsedFiles: number;
  readonly totalUrls: number;
  readonly totalPatterns: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SamplingHealthSummary {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly patternsTotal: number;
  readonly patternsLowConfidence: number;
  readonly patternsExpanded: number;
  readonly patternsBlocked: number;
  readonly patternsNeedsReview: number;
  readonly samplesDrawn: number;
  readonly httpRequests: number;
  readonly getEscalations: number;
  readonly circuitBreaks: number;
}

export function listSites(): Promise<{ readonly sites: readonly SiteSummary[] }> {
  return getJson("/sites");
}

export interface SiteDetail {
  readonly site: SiteSummary;
  readonly latestRun?: SitemapRunSummary;
  readonly samplingHealth?: SamplingHealthSummary;
}

export function getSite(siteId: string): Promise<SiteDetail> {
  return getJson(`/sites/${encodeURIComponent(siteId)}`);
}

// --- Patterns --------------------------------------------------------------

export type PatternStatus =
  | "unsampled"
  | "sampling"
  | "measured"
  | "blocked"
  | "needs_review";

export interface PatternSummary {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string;
  readonly template: string;
  readonly segmentCount: number;
  readonly populationCount: number;
  readonly fileCount: number;
  readonly status: PatternStatus;
  readonly statusReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listPatterns(
  siteId: string
): Promise<{ readonly sitemapRunId: string; readonly patterns: readonly PatternSummary[] }> {
  return getJson(`/sites/${encodeURIComponent(siteId)}/patterns`);
}

export interface PatternSampleSummary {
  readonly id: string;
  readonly siteId: string;
  readonly patternId: string;
  readonly sitemapRunId: string;
  readonly round: number;
  readonly method: "min_heap_by_hash";
  readonly kRequested: number;
  readonly kThresholdHash: number;
  readonly sampleSize: number;
  readonly populationAtDraw: number;
  readonly stratumCount: number;
  readonly drawnAt: string;
}

export type EvidenceTier = "counted" | "estimated" | "blocked";
export type ConfidenceBandName = "confident" | "approximate" | "low";
export type SeverityClassName =
  | "gone"
  | "not_found"
  | "soft_not_found"
  | "server_error"
  | "redirect_chain"
  | "redirect_single"
  | "ok"
  | "blocked"
  | "unknown";

export interface AuditSnapshotSummary {
  readonly id: string;
  readonly siteId: string;
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly sitemapRunId: string;
  readonly httpStatus: number;
  readonly evidenceTier: EvidenceTier;
  readonly observedCount: number;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly severityClass: SeverityClassName;
  readonly impactScore: number;
  readonly estimatorVersion: string;
  readonly computedAt: string;
}

export type HttpMethodUsed = "HEAD" | "GET";

export interface SampleObservationSummary {
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
  readonly observedAt: string;
}

export interface PatternDetail {
  readonly pattern: PatternSummary;
  readonly latestSample?: PatternSampleSummary;
  readonly findings: readonly AuditSnapshotSummary[];
  readonly observations: readonly SampleObservationSummary[];
}

export function getPattern(
  siteId: string,
  patternId: string
): Promise<PatternDetail> {
  return getJson(
    `/sites/${encodeURIComponent(siteId)}/patterns/${encodeURIComponent(patternId)}`
  );
}
