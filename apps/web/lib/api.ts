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

/**
 * The API's base address, for the one caller that needs to build a URL itself.
 *
 * Exported only so the CSV export route can proxy a stream, which cannot go
 * through `getJson`. Server-only by construction: `WEB_API_URL` has no
 * `NEXT_PUBLIC_` prefix, so a client component reading this gets the localhost
 * default and not the deployment's API.
 */
export function apiUrl(): string {
  return API_URL;
}

/**
 * Server-side credentials for the deployment Basic Auth stopgap (see
 * `apps/api/src/basic-auth.ts`). Read directly from `process.env` rather than
 * through `@pattern-aware/shared`'s `getConfig()`, matching `API_URL` above —
 * this process has no reason to validate the rest of that schema.
 *
 * Absent in local dev, where the API runs with no Basic Auth hook at all.
 */
function authHeaders(): Record<string, string> {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;

  if (user === undefined || password === undefined) {
    return {};
  }

  return {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
  };
}

/**
 * Fetch options carrying this deployment's Basic Auth header, for the two
 * export route handlers that call `fetch` directly instead of through
 * {@link getJson}.
 */
export function apiFetchInit(
  init: RequestInit = {}
): RequestInit & { readonly headers: Record<string, string> } {
  return {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string>) }
  };
}

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
    response = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      headers: authHeaders()
    });
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

export type FileParseStatus =
  | "pending"
  | "downloading"
  | "parsing"
  | "parsed"
  | "failed"
  | "skipped";

export interface SitemapFileSummary {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string;
  readonly url: string;
  readonly fileOrdinal: number;
  readonly filename: string | null;
  readonly parseStatus: FileParseStatus;
  readonly urlCount: number;
  readonly byteSize: number | null;
  readonly isGzip: boolean;
  readonly contentDigest: string | null;
  readonly parseError: string | null;
  readonly parsedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Patterns and URLs per status for one run — both COUNTED figures. */
export interface PatternStatusCount {
  readonly status: PatternStatus;
  readonly count: number;
  readonly populationCount: number;
}

export function listSites(): Promise<{
  readonly sites: readonly SiteSummary[];
}> {
  return getJson("/sites");
}

/**
 * One row of the fleet portfolio.
 *
 * COUNTS ONLY, and the absence is the notable part: there is no health score
 * here because this platform computes none anywhere. The Stitch screen shows
 * "88.4/100" per project; a composite invented in a serializer would be a
 * figure with no definition, no test and no way for a reader to check it, so
 * the row carries the findings it actually has instead (ADR-0037).
 */
export interface ProjectSummary {
  readonly site: SiteSummary;
  /** Absent when the site has never run. Not an error — a new project. */
  readonly latestRun?: SitemapRunSummary;
  readonly findings: {
    readonly total: number;
    /**
     * Findings whose severity class this platform treats as damage.
     *
     * Excludes `blocked` and `unknown`, which weigh zero severity: a host
     * refusing us is not a site defect, and counting it would let a WAF turn a
     * healthy client into a fleet-wide "requires triage".
     */
    readonly critical: number;
    readonly bySeverity: readonly {
      readonly severityClass: SeverityClassName;
      readonly count: number;
    }[];
  };
}

export interface ProjectsPage {
  readonly projects: readonly ProjectSummary[];
  /** Matching sites, ignoring the page window — the "of M" in the footer. */
  readonly total: number;
  /**
   * Fleet figures over EVERY matching site, not the page.
   *
   * Sent separately from the rows on purpose: a KPI card that sums the page
   * and labels it the fleet is the defect D3a found on both fleet screens.
   */
  readonly totals: {
    readonly sites: number;
    readonly onboardedRecently: number;
    /** Summed across each site's LATEST run — never "crawled". */
    readonly urlsDiscovered: number;
    readonly patterns: number;
    readonly findings: number;
    readonly criticalFindings: number;
  };
}

export interface ProjectsQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly tier?: SiteTier;
  readonly includeInactive?: boolean;
}

/** The querystring both the portfolio read and its CSV export accept. */
export function projectsSearch(query: ProjectsQuery): string {
  const params = new URLSearchParams();

  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }

  if (query.offset !== undefined && query.offset > 0) {
    params.set("offset", String(query.offset));
  }

  if (query.tier !== undefined) {
    params.set("tier", query.tier);
  }

  if (query.includeInactive === true) {
    params.set("includeInactive", "true");
  }

  return params.toString();
}

export function listProjects(query: ProjectsQuery = {}): Promise<ProjectsPage> {
  const search = projectsSearch(query);

  return getJson(`/projects${search === "" ? "" : `?${search}`}`);
}

/**
 * Onboard a project.
 *
 * POSTs to `/sites`, not `/projects`: "Projects" is the design's label for the
 * screen and `site` is the entity, so the collection you create into keeps the
 * entity's name — the same split `Analyses` → `/runs` already makes.
 *
 * Shares `patchSite`'s error handling for the same reason: the API's 409 says
 * which host is already monitored, and that is the only part of the failure a
 * reader can act on.
 */
export async function createProject(input: {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier?: SiteTier;
}): Promise<SiteSummary> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/sites`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(input),
      cache: "no-store"
    });
  } catch (error) {
    throw new ApiError(
      0,
      `Could not reach the API at ${API_URL}. Is "pnpm dev" running the api workspace? (${(error as Error).message})`
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      readonly error?: { readonly message?: string };
    } | null;

    throw new ApiError(
      response.status,
      body?.error?.message ?? `${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as SiteSummary;
}

export interface SiteDetail {
  readonly site: SiteSummary;
  readonly latestRun?: SitemapRunSummary;
  readonly samplingHealth?: SamplingHealthSummary;
  /** The site's own findings, worst first — see `SiteFinding`. */
  readonly findings: readonly SiteFinding[];
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

/**
 * A pattern's findings rolled into one still-estimated impact figure.
 *
 * FIELD NAMES ARE THOSE OF `AuditSnapshotSummary` on purpose, so
 * `impactFromSnapshot` renders this with no second adapter — and so
 * `lib/adr-0008-guard.test.ts`, which scans for those exact names, already
 * polices any screen that tries to format it directly.
 */
export interface PatternImpactRollup {
  readonly evidenceTier: EvidenceTier;
  /** URLs estimated affected — the unweighted sum, distinct from impact. */
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly observedCount: number;
  readonly confidenceLevel: number;
  readonly impactScore: number;
  readonly impactLow: number;
  readonly impactHigh: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly sampleSize: number;
  readonly populationCount: number;
  /** Findings that carry damage. An absence of evidence is not one. */
  readonly countedFindings: number;
}

export interface PatternRankSummary extends PatternSummary {
  /** Published claims about this pattern. COUNTED — safe in a KPI card. */
  readonly findingCount: number;
  /**
   * Absent when the pattern has no published finding AT ALL.
   *
   * That is not the same as a total of zero, and the screen must not render it
   * as one: a pattern nothing published, a pattern whose every finding is an
   * absence of evidence (`evidenceTier: "blocked"`) and a pattern genuinely
   * measured at zero are three states, and collapsing them reports a host
   * refusing us as a clean bill of health.
   */
  readonly impact?: PatternImpactRollup;
  readonly worstHttpStatus?: number;
  readonly worstSeverityClass?: SeverityClassName;
}

export interface PatternsPage {
  /** Null when the site has no finished run — NOT the same as "no patterns". */
  readonly sitemapRunId: string | null;
  readonly patterns: readonly PatternRankSummary[];
  /** Over the whole run under the active filter, never over the page. */
  readonly total: number;
  readonly sort: PatternSort;
  readonly status?: PatternStatus;
  readonly statusCounts: readonly {
    readonly status: PatternStatus;
    readonly count: number;
    readonly populationCount: number;
  }[];
  /** URLs the sampler actually probed. Counted. */
  readonly observedUrls: number;
  /** URLs discovered from sitemaps — discovered, never all requested. */
  readonly totalUrls: number;
}

export type PatternSort = "population" | "impact";

export interface ListPatternsOptions {
  readonly sort?: PatternSort;
  readonly status?: PatternStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export function listPatterns(
  siteId: string,
  options: ListPatternsOptions = {}
): Promise<PatternsPage> {
  const query = new URLSearchParams();

  if (options.sort) {
    query.set("sort", options.sort);
  }

  if (options.status) {
    query.set("status", options.status);
  }

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options.offset !== undefined) {
    query.set("offset", String(options.offset));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return getJson(`/sites/${encodeURIComponent(siteId)}/patterns${suffix}`);
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

/**
 * A measurement, in the shape everything that publishes one uses.
 *
 * SHARED SO THERE IS ONE OF IT. A published finding is this plus a severity and
 * the ids that locate it; the sample-plan tool's answer is exactly this and
 * nothing more. `<Estimate>` reads these fields and is the only module allowed
 * to format them (ADR-0008), so a second shape would mean a second adapter, and
 * a second adapter is a second chance to render an estimate without its
 * interval.
 */
export interface SampledMeasurement {
  readonly evidenceTier: EvidenceTier;
  readonly observedCount: number;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly pointEstimate: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly confidenceBand: ConfidenceBandName;
  /** The level the interval was computed at, e.g. 0.95. */
  readonly confidenceLevel: number;
}

/**
 * The fields `impactFromSnapshot` needs to render impact with its interval.
 *
 * Named separately so a rolled-up figure — a pattern's findings summed — can go
 * through the SAME adapter as a single finding. `AuditSnapshotSummary` extends
 * it, so nothing about the finding path changes.
 */
export interface ImpactMeasurement {
  readonly evidenceTier: EvidenceTier;
  readonly sampleSize: number;
  readonly populationCount: number;
  readonly confidenceBand: ConfidenceBandName;
  readonly impactScore: number;
  readonly impactLow: number;
  readonly impactHigh: number;
}

export interface AuditSnapshotSummary
  extends SampledMeasurement,
    ImpactMeasurement {
  readonly id: string;
  readonly patternId: string;
  readonly patternSampleId: string;
  readonly sitemapRunId: string;
  readonly httpStatus: number;
  readonly severityClass: SeverityClassName;
  /** The weight in force when this claim was published. */
  readonly severityWeight: number;
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

/**
 * A finding on a site's own list.
 *
 * Adds the pattern template, which a per-site row needs to be actionable — the
 * pattern id it links on is a UUID no reader recognises. The site name does
 * not travel: the screen is the site. Every estimate-bearing field is
 * inherited, so the same `<Estimate>` adapters accept it.
 */
export interface SiteFinding extends AuditSnapshotSummary {
  readonly patternTemplate: string;
}

/** One file's contribution to a pattern's population. Counts, never URLs. */
export interface PatternFile {
  readonly id: string;
  readonly patternId: string;
  readonly sitemapFileId: string;
  readonly urlCount: number;
  readonly fileUrl: string;
  readonly filename: string | null;
  readonly fileOrdinal: number;
}

export interface PatternDetail {
  readonly pattern: PatternSummary;
  readonly latestSample?: PatternSampleSummary;
  readonly findings: readonly AuditSnapshotSummary[];
  readonly observations: readonly SampleObservationSummary[];
  /** Which files this pattern's URLs live in, largest contributor first. */
  readonly files: readonly PatternFile[];
  /**
   * The population summed from those file rows.
   *
   * Sent so it can be compared with `pattern.populationCount`: the two are
   * written by different steps, and a disagreement means a file was parsed
   * twice or not at all rather than being a rounding difference.
   */
  readonly populationFromFiles: number;
  /**
   * Observations actually recorded for the latest draw — the `n` of the
   * estimate, as opposed to the `sampleSize` that was drawn.
   */
  readonly observedCount: number;
}

export function getPattern(
  siteId: string,
  patternId: string
): Promise<PatternDetail> {
  return getJson(
    `/sites/${encodeURIComponent(siteId)}/patterns/${encodeURIComponent(patternId)}`
  );
}

// --- Fleet-wide (organization-scoped) reads ---------------------------------

/**
 * A finding on the fleet list.
 *
 * Adds the labels a cross-site row needs to be attributable — the site it
 * belongs to and the pattern it describes — plus the `siteId` the row links
 * back on. Every estimate-bearing field is inherited unchanged, so the same
 * `<Estimate>` adapters accept this shape without a second code path.
 */
export interface OrganizationFinding extends AuditSnapshotSummary {
  readonly siteId: string;
  readonly siteName: string;
  readonly patternTemplate: string;
}

/** Every site's findings in the organization, worst first. */
export function listIssues(
  limit?: number
): Promise<{ readonly issues: readonly OrganizationFinding[] }> {
  return getJson(`/issues${limit === undefined ? "" : `?limit=${limit}`}`);
}

/** A run on the fleet list — the per-site shape plus its site's name. */
export interface OrganizationRun extends SitemapRunSummary {
  readonly siteName: string;
}

/** Run history across every site in the organization, newest first. */
export function listRuns(
  limit?: number
): Promise<{ readonly runs: readonly OrganizationRun[] }> {
  return getJson(`/runs${limit === undefined ? "" : `?limit=${limit}`}`);
}

/** Patterns bucketed by PATH depth — segments, not clicks from a root page. */
export interface PatternDepthCount {
  readonly segmentCount: number;
  readonly count: number;
  readonly populationCount: number;
}

/** One probed URL, carrying the pattern it was drawn from. */
export interface RunObservation extends SampleObservationSummary {
  readonly patternTemplate: string;
}

export type HttpStatusClass =
  | "ok"
  | "redirect"
  | "client_error"
  | "server_error"
  | "error";

export interface RunObservations {
  readonly observations: readonly RunObservation[];
  /**
   * How many PROBES the run holds — not how many URLs it discovered.
   *
   * The two differ by the entire point of the product, so a screen pairing this
   * with "showing X of Y" must say which it is counting.
   */
  readonly total: number;
}

/** One probe outcome and how many probes produced it. Counted. */
export interface ObservationTally {
  readonly httpStatus: number | null;
  readonly isSoft404: boolean;
  readonly count: number;
}

/** A prior run, reduced to what a time series needs. */
export interface RunPoint {
  readonly id: string;
  readonly startedAt: string | null;
  readonly totalUrls: number;
  readonly totalPatterns: number;
  readonly status: RunStatus;
}

export interface RunDetail {
  readonly run: OrganizationRun;
  /** Capped by the API — compare against `fileCount` before presenting. */
  readonly files: readonly SitemapFileSummary[];
  /**
   * How many file rows the run actually has.
   *
   * `files` is a page of them. This is what the screen says "showing n of N"
   * against, so a truncated list is never presented as the whole run.
   */
  readonly fileCount: number;
  readonly patternStatus: readonly PatternStatusCount[];
  readonly samplingHealth?: SamplingHealthSummary;
  /** Patterns bucketed by path depth, for the distribution panel. */
  readonly depthDistribution: readonly PatternDepthCount[];
  /** Largest patterns by population, and the single smallest. */
  readonly topPatterns: readonly PatternSummary[];
  readonly smallestPattern?: PatternSummary;
  /**
   * The previous run's URL count.
   *
   * Absent on a first run rather than zero — no trend and a total collapse
   * must not render the same.
   */
  readonly previousTotalUrls?: number;
  /** Probe outcomes across the run, for the distribution widget. */
  readonly httpOutcomes: readonly ObservationTally[];
  /** Recent runs, OLDEST FIRST so a series reads left to right. */
  readonly recentRuns: readonly RunPoint[];
}

/**
 * One run's detail: the files it read and what its patterns became.
 *
 * Addressed by run id alone, with no site — the fleet list this is reached
 * from has no site either. The membership check that a `siteId` would have
 * driven happens inside the API, which can only resolve runs belonging to the
 * caller's own organization (ADR-0028).
 */
export function getRun(runId: string): Promise<RunDetail> {
  return getJson(`/runs/${encodeURIComponent(runId)}`);
}

/**
 * How many rows the fleet screens ask for.
 *
 * Passed EXPLICITLY rather than left to the API's default. The default was 50
 * and no caller ever passed anything, so both fleet screens silently truncated
 * at 50 rows while their own KPI cards counted `rows.length` — a card reading
 * "50 findings" that actually meant "at least 50" is precisely the
 * manufactured-precision failure DESIGN.md section 9 bans. The screens now
 * state the cap they asked for; 200 is the maximum the API allows.
 */
export const FLEET_PAGE_SIZE = 200;

/**
 * How many health windows the Analytics screen asks for.
 *
 * Passed EXPLICITLY, and `getSiteAnalytics` takes it as a REQUIRED parameter
 * rather than an optional one. The D3a finding was that both fleet screens
 * truncated at the API's default while their own KPI cards counted the page and
 * called it the fleet; a required parameter turns that slip into a type error
 * instead of a comment nobody reads. 200 is the maximum the API allows.
 */
export const ANALYTICS_WINDOW_COUNT = 30;

/**
 * One site's operational history.
 *
 * Every figure here is COUNTED — rows in `sampling_health` and `sitemap_run`,
 * not sampled quantities — which is why nothing in this shape carries an
 * interval and nothing on the Analytics screen goes through `<Estimate>`.
 */
export interface SiteAnalytics {
  readonly site: SiteSummary;
  /** Health windows, NEWEST FIRST. */
  readonly health: readonly SamplingHealthSummary[];
  /**
   * What was ASKED for. Compare against `health.length` before presenting a
   * figure derived from the series, so a capped history is never described as
   * the whole record.
   */
  readonly windowLimit: number;
  /** The runs behind those windows, OLDEST FIRST, so a series reads forwards. */
  readonly runs: readonly RunPoint[];
  readonly latestRun?: SitemapRunSummary;
  readonly patternStatus: readonly PatternStatusCount[];
}

export function getSiteAnalytics(
  siteId: string,
  windows: number
): Promise<SiteAnalytics> {
  return getJson(
    `/sites/${encodeURIComponent(siteId)}/analytics?windows=${windows}`
  );
}

// --- Settings (read-only platform policy) ---------------------------------

export type PolicyUnit = "rps" | "count" | "fraction" | "ms" | "bytes";

/**
 * One operational limit, carrying whether anything applies it.
 *
 * `enforcedAt` is the repo-relative file that consumes the value, or `null`
 * when nothing does. IT ARRIVES FROM THE API rather than being decided here:
 * several limits are configured and applied by nothing, and a screen that
 * classified them itself would be a hand-maintained list going stale one commit
 * after somebody wires one up. The API derives it from a manifest that a test
 * checks against the source tree in both directions.
 */
export interface PolicyLimit {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: PolicyUnit;
  readonly enforcedAt: string | null;
}

/** A per-site policy column, described but without a value of its own. */
export type SitePolicyColumn = Omit<PolicyLimit, "value">;

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SettingsDetail {
  readonly organization: OrganizationSummary;
  readonly policy: readonly PolicyLimit[];
  readonly siteColumns: readonly SitePolicyColumn[];
}

/**
 * Read-only platform settings.
 *
 * Per-site policy is not here — `GET /sites` already returns every site column,
 * so the screen pairs this with `listSites()` rather than the API declaring the
 * site shape twice.
 */
export function getSettings(): Promise<SettingsDetail> {
  return getJson("/settings");
}

/**
 * The one write this client makes.
 *
 * PATCH with a partial body: only the fields the form actually changed travel,
 * so an untouched control cannot overwrite a column somebody else edited. See
 * `siteFormPatch` in lib/settings.ts for the diff, and `siteUpdateBody` in the
 * API for the matching contract.
 *
 * Called only from a Server Action — `API_URL` is server-only, and routing the
 * write through the server keeps the API the sole writer.
 */
export async function patchSite(
  siteId: string,
  patch: object
): Promise<SiteSummary> {
  let response: Response;

  try {
    response = await fetch(`${API_URL}/sites/${encodeURIComponent(siteId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
      cache: "no-store"
    });
  } catch (error) {
    throw new ApiError(
      0,
      `Could not reach the API at ${API_URL}. Is "pnpm dev" running the api workspace? (${(error as Error).message})`
    );
  }

  if (!response.ok) {
    /*
     * The API's own message is surfaced, not a generic one. Its 409s are
     * actionable and specific — "another site already monitors that host",
     * "cannot change tier while run X is running" — and replacing them with
     * "save failed" would throw away the only part the reader can act on.
     */
    const body = (await response.json().catch(() => null)) as {
      readonly error?: { readonly message?: string };
    } | null;

    throw new ApiError(
      response.status,
      body?.error?.message ?? `${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as SiteSummary;
}

/** One page of a run's probed URLs, with the true total for the footer. */
export function listRunObservations(
  runId: string,
  options: {
    readonly limit?: number;
    readonly offset?: number;
    readonly status?: HttpStatusClass;
  } = {}
): Promise<RunObservations> {
  const query = new URLSearchParams();

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options.offset !== undefined) {
    query.set("offset", String(options.offset));
  }

  if (options.status !== undefined) {
    query.set("status", options.status);
  }

  const suffix = query.size === 0 ? "" : `?${query.toString()}`;

  return getJson(`/runs/${encodeURIComponent(runId)}/observations${suffix}`);
}

// --- Tools (pure computation, no site data) -------------------------------

/**
 * How many characters the extractor's form will submit.
 *
 * A TRANSPORT bound, not the domain one — the API accepts 5,000 URLs, and this
 * is what fits in a shareable link. The form is a GET so its input lives in the
 * URL and a result can be sent to somebody; ~8,000 characters of typical
 * sitemap URLs expand to roughly 10,500 once form-encoded, inside Node's
 * default 16KB header budget. That is around 130 URLs — four times the
 * parameterisation floor, so the product's real behaviour is fully
 * demonstrable within it.
 */
export const TOOL_FORM_MAX_CHARACTERS = 8_000;

export interface SampleBudgetSummary {
  readonly sampleRate: number;
  readonly minSample: number;
  readonly maxFirstRound: number;
  readonly maxExpanded: number;
  readonly maxExpansionFactor: number;
  readonly maxPopulationFraction: number;
  readonly minPerStratum: number;
}

export type ExpansionReason =
  | "interval_too_wide"
  | "unsampled_strata"
  | "already_precise"
  | "at_expansion_ceiling"
  | "at_population_ceiling"
  | "nothing_left_to_sample";

export interface SamplePlanResult {
  readonly budget: SampleBudgetSummary;
  readonly plan: {
    readonly populationTotal: number;
    readonly sampleTotal: number;
    /** What the rate works out at, not the nominal one the budget names. */
    readonly effectiveRate: number;
  };
  /** Present only once the caller says what the sample found. */
  readonly measurement?: SampledMeasurement;
  readonly expansion?: {
    readonly shouldExpand: boolean;
    readonly reason: ExpansionReason;
    readonly additionalTotal: number;
  };
  readonly thresholds: {
    readonly approximateWidth: number;
    readonly lowWidth: number;
    readonly zeroHitApproximateWidth: number;
    readonly zeroHitLowWidth: number;
  };
  readonly thresholdSource: "package-default";
}

export interface ExtractedPattern {
  readonly template: string;
  readonly segmentCount: number;
  readonly paramCount: number;
  readonly populationCount: number;
  readonly plannedSampleSize: number;
  readonly sample: readonly string[];
}

export interface PatternExtraction {
  readonly host: string;
  readonly hostSource: "supplied" | "derived" | "none";
  readonly hostBreakdown: readonly {
    readonly host: string;
    readonly count: number;
  }[];
  readonly input: {
    readonly submitted: number;
    readonly blank: number;
    readonly analysed: number;
  };
  readonly outcome: {
    readonly matched: number;
    readonly foreign: number;
    readonly unparseable: number;
  };
  readonly foreignSamples: readonly string[];
  readonly unparseableSamples: readonly string[];
  readonly parameterisation: {
    readonly minObservedUrls: number;
    readonly uniqueThreshold: number;
    readonly uniqueRatioThreshold: number;
    readonly observedUrls: number;
    readonly belowFloor: boolean;
    readonly urlsShortOfFloor: number;
    readonly templatesTotal: number;
    readonly templatesParameterised: number;
  };
  readonly patterns: readonly ExtractedPattern[];
}

export function getSamplePlan(query: {
  readonly population: number;
  readonly sampled?: number;
  readonly hits?: number;
}): Promise<SamplePlanResult> {
  const params = new URLSearchParams({
    population: String(query.population)
  });

  if (query.sampled !== undefined) {
    params.set("sampled", String(query.sampled));
  }

  if (query.hits !== undefined) {
    params.set("hits", String(query.hits));
  }

  return getJson(`/tools/sample-plan?${params.toString()}`);
}

/**
 * POST, and it mutates nothing.
 *
 * A body rather than a querystring because the input is arbitrary pasted text
 * and the 5,000-URL cap is unreachable over a URL. The route that serves this
 * is registered with no database handle at all, so it cannot write even by
 * mistake — see `apps/api/src/routes/tools.ts`.
 */
export async function extractPatterns(
  text: string,
  host?: string
): Promise<PatternExtraction> {
  const response = await fetch(`${apiUrl()}/tools/pattern-extraction`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(host === undefined ? { text } : { text, host }),
    cache: "no-store"
  });

  if (!response.ok) {
    /*
     * The API's own message is the actionable part here — the cap and the
     * below-floor explanations both say what to do next — so it is surfaced
     * rather than replaced with a generic failure.
     */
    const body = (await response.json().catch(() => undefined)) as
      | { readonly error?: { readonly message?: string } }
      | undefined;

    throw new ApiError(
      response.status,
      body?.error?.message ?? `Pattern extraction failed (${response.status}).`
    );
  }

  return (await response.json()) as PatternExtraction;
}
