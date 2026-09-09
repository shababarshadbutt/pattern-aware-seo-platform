import { z } from "zod";

/**
 * The wire contract, as zod schemas.
 *
 * These do two jobs that generics cannot. Params get **validated**: a
 * path segment that is not a UUID is rejected with a 400 before any query
 * runs, where previously it reached Postgres and came back as a 500 carrying
 * the raw SQL — the wrong status and an information leak in one response.
 *
 * Responses get **serialized through a declared shape**, so the wire format is
 * chosen here rather than being whatever columns a repository happens to
 * select. Unknown keys are stripped, which means adding a column to a table
 * does not silently start publishing it. The cost is that a schema which
 * drifts from reality fails loudly — which is why every route has a test.
 */

const uuid = z.uuid();

/**
 * Every list is `.readonly()`.
 *
 * The repositories return `readonly T[]` deliberately, and unlike a readonly
 * property, a readonly ARRAY is not assignable to a mutable one — so without
 * this the handlers would not typecheck against their own response schemas.
 */

export const siteParams = z.object({ siteId: uuid });

export const patternParams = z.object({ siteId: uuid, patternId: uuid });

/**
 * A run addressed on its own, with no site in the path.
 *
 * Deliberate: the fleet run list has no site either, and a detail route the
 * reader arrives at from there should not have to carry one. The membership
 * check the missing `siteId` would have driven is not skipped — it moves into
 * `findOrganizationRunById`, which can only see runs belonging to sites in the
 * caller's own organization (ADR-0028).
 */
export const runParams = z.object({ runId: uuid });

/**
 * A timestamp, accepted as either a `Date` or an already-serialized string.
 *
 * DELIBERATELY NOT A `.transform()`. A transform makes zod's input and output
 * types differ, and the type provider types a reply by its OUTPUT — so a
 * transformed schema demands the handler already return strings while the
 * repositories return `Date`. The union keeps input and output the same, and
 * JSON serialization renders a `Date` as an ISO string on the wire regardless,
 * which is what the client parses.
 */
const isoDate = z.union([z.string(), z.date()]);

const nullableIsoDate = z.union([z.string(), z.date(), z.null()]);

export const siteSummary = z.object({
  id: uuid,
  organizationId: uuid,
  name: z.string(),
  baseUrl: z.string(),
  host: z.string(),
  tier: z.enum(["standard", "priority", "bulk"]),
  isActive: z.boolean(),
  dailyRequestCap: z.number().nullable(),
  minRequestIntervalMs: z.number().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: nullableIsoDate
});

export const runSummary = z.object({
  id: uuid,
  siteId: uuid,
  status: z.enum([
    "pending",
    "running",
    "complete",
    "degraded",
    "failed",
    "cancelled"
  ]),
  statusReason: z.string().nullable(),
  isDryRun: z.boolean(),
  workerId: z.string().nullable(),
  heartbeatAt: nullableIsoDate,
  startedAt: nullableIsoDate,
  completedAt: nullableIsoDate,
  totalFiles: z.number(),
  parsedFiles: z.number(),
  totalUrls: z.number(),
  totalPatterns: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate
});

export const samplingHealthSummary = z.object({
  id: uuid,
  siteId: uuid,
  sitemapRunId: uuid.nullable(),
  windowStart: isoDate,
  windowEnd: isoDate,
  patternsTotal: z.number(),
  patternsLowConfidence: z.number(),
  patternsExpanded: z.number(),
  patternsBlocked: z.number(),
  patternsNeedsReview: z.number(),
  samplesDrawn: z.number(),
  httpRequests: z.number(),
  getEscalations: z.number(),
  circuitBreaks: z.number()
});

/**
 * One sitemap file in a run.
 *
 * `storageKey` is deliberately NOT published. It names a location in our own
 * object store, no screen has a use for it, and the response schema strips what
 * it does not declare — so leaving it out here is what keeps it off the wire
 * rather than a comment asking people not to render it. `contentDigest` does
 * travel: it is what distinguishes a genuinely shrunken sitemap from a
 * truncated download, which is a question a reader of this table will have.
 */
export const sitemapFileSummary = z.object({
  id: uuid,
  siteId: uuid,
  sitemapRunId: uuid,
  url: z.string(),
  fileOrdinal: z.number(),
  filename: z.string().nullable(),
  parseStatus: z.enum([
    "pending",
    "downloading",
    "parsing",
    "parsed",
    "failed",
    "skipped"
  ]),
  urlCount: z.number(),
  byteSize: z.number().nullable(),
  isGzip: z.boolean(),
  contentDigest: z.string().nullable(),
  parseError: z.string().nullable(),
  parsedAt: nullableIsoDate,
  createdAt: isoDate,
  updatedAt: isoDate
});

/**
 * Patterns and URLs per status for one run.
 *
 * Both figures travel because they tell different stories: twelve blocked
 * patterns is unremarkable until you see they hold nine million URLs. Both are
 * COUNTED — a parsed population, not a sampled estimate — so unlike an impact
 * figure they may be rendered bare (DESIGN.md section 9, ADR-0008).
 */
export const patternStatusCountSummary = z.object({
  status: z.enum([
    "unsampled",
    "sampling",
    "measured",
    "blocked",
    "needs_review"
  ]),
  count: z.number(),
  populationCount: z.number()
});

/**
 * Patterns and URLs bucketed by PATH depth.
 *
 * SEGMENTS IN A TEMPLATE, NOT CLICKS FROM A ROOT DOCUMENT. `/catalog/{slug}`
 * is two. The design this fills draws a link-depth histogram, which would need
 * a link graph this platform does not build — so the screen rendering this must
 * say which depth it means, or a reader will assume the crawler metric it
 * resembles. Both figures are COUNTED and may render bare.
 */
export const patternDepthCountSummary = z.object({
  segmentCount: z.number(),
  count: z.number(),
  populationCount: z.number()
});

/**
 * One HTTP outcome and how many probes produced it.
 *
 * `isSoft404` travels beside the status because a 200 that is really a
 * missing page is not a healthy 200 — folding them together would report a
 * site as fine while a fifth of its sample was a soft 404. `httpStatus` is
 * null when the probe got no response at all, which is distinct from a 5xx:
 * the server did not answer, so there is nothing to classify.
 */
export const observationTallySummary = z.object({
  httpStatus: z.number().nullable(),
  isSoft404: z.boolean(),
  count: z.number()
});

/** A prior run, reduced to what a time series needs. */
export const runPointSummary = z.object({
  id: uuid,
  startedAt: nullableIsoDate,
  totalUrls: z.number(),
  totalPatterns: z.number(),
  status: z.enum([
    "pending",
    "running",
    "complete",
    "degraded",
    "failed",
    "cancelled"
  ])
});

export const patternSummary = z.object({
  id: uuid,
  siteId: uuid,
  sitemapRunId: uuid,
  template: z.string(),
  segmentCount: z.number(),
  populationCount: z.number(),
  fileCount: z.number(),
  status: z.enum([
    "unsampled",
    "sampling",
    "measured",
    "blocked",
    "needs_review"
  ]),
  statusReason: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate
});

export const patternSampleSummary = z.object({
  id: uuid,
  patternId: uuid,
  sitemapRunId: uuid,
  round: z.number(),
  method: z.literal("min_heap_by_hash"),
  kRequested: z.number(),
  kThresholdHash: z.number(),
  sampleSize: z.number(),
  populationAtDraw: z.number(),
  stratumCount: z.number(),
  drawnAt: isoDate
});

/**
 * A published finding.
 *
 * Carries `severityWeight` and the derived impact bounds because impact is an
 * ESTIMATED quantity and ADR-0008 forbids rendering one without its interval.
 * The bounds are computed, not stored — see `withImpactBounds` in findings.ts.
 */
export const auditSnapshotSummary = z.object({
  id: uuid,
  patternId: uuid,
  patternSampleId: uuid,
  sitemapRunId: uuid,
  httpStatus: z.number(),
  evidenceTier: z.enum(["counted", "estimated", "blocked"]),
  observedCount: z.number(),
  sampleSize: z.number(),
  populationCount: z.number(),
  pointEstimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  confidenceBand: z.enum(["confident", "approximate", "low"]),
  /** The level the interval was computed at, so the screen can say "95%". */
  confidenceLevel: z.number(),
  severityClass: z.enum([
    "gone",
    "not_found",
    "soft_not_found",
    "server_error",
    "redirect_chain",
    "redirect_single",
    "ok",
    "blocked",
    "unknown"
  ]),
  severityWeight: z.number(),
  impactScore: z.number(),
  impactLow: z.number(),
  impactHigh: z.number(),
  estimatorVersion: z.string(),
  computedAt: isoDate
});

export const sampleObservationSummary = z.object({
  id: uuid,
  patternId: uuid,
  patternSampleId: uuid,
  url: z.string(),
  urlHash: z.number(),
  httpStatus: z.number().nullable(),
  methodUsed: z.enum(["HEAD", "GET"]).nullable(),
  escalatedToGet: z.boolean(),
  isSoft404: z.boolean(),
  errorReason: z.string().nullable(),
  responseMs: z.number().nullable(),
  observedAt: isoDate
});

export const sitesResponse = z.object({
  sites: z.array(siteSummary).readonly()
});

/**
 * A finding on a site's own list.
 *
 * Carries the pattern template but not the site name — the screen IS the site,
 * where the fleet list has to name one. Same estimate-bearing fields as every
 * other finding shape, so `<Estimate>` accepts it without a second code path.
 */
export const siteFindingSummary = auditSnapshotSummary.extend({
  patternTemplate: z.string()
});

export const siteDetailResponse = z.object({
  site: siteSummary,
  latestRun: runSummary.optional(),
  samplingHealth: samplingHealthSummary.optional(),
  findings: z.array(siteFindingSummary).readonly()
});

/**
 * `sitemapRunId` is nullable rather than the route 404-ing.
 *
 * "This site has no finished run yet" is not "this site does not exist" —
 * conflating them made a freshly-onboarded site indistinguishable from a typo
 * in the URL. An empty list with a null run id lets the screen say which.
 */
/**
 * A pattern's findings rolled into one impact figure.
 *
 * FIELD NAMES ARE DELIBERATELY THOSE OF `auditSnapshotSummary`, so the web's
 * one sanctioned adapter renders it and `lib/adr-0008-guard.test.ts` already
 * polices it. See `rollUpPatternImpact` for why this is not `scorePatternImpact`.
 *
 * Optional, and the absence means something: a pattern with no published
 * finding is not a pattern measured at zero. `evidenceTier: "blocked"` is the
 * third state — findings exist but every one is an absence of evidence.
 */
export const patternImpactRollup = z.object({
  evidenceTier: z.enum(["counted", "estimated", "blocked"]),
  pointEstimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  observedCount: z.number(),
  confidenceLevel: z.number(),
  impactScore: z.number(),
  impactLow: z.number(),
  impactHigh: z.number(),
  confidenceBand: z.enum(["confident", "approximate", "low"]),
  sampleSize: z.number(),
  populationCount: z.number(),
  countedFindings: z.number()
});

/**
 * A pattern as the triage explorer needs it.
 *
 * `findingCount` is COUNTED — a number of published claims, not a volume of
 * URLs — so it is safe in a KPI card where `impact` is not.
 */
export const patternRankSummary = patternSummary.extend({
  findingCount: z.number(),
  impact: patternImpactRollup.optional(),
  /** The worst finding's status and class, for a badge. Absent when none. */
  worstHttpStatus: z.number().optional(),
  worstSeverityClass: auditSnapshotSummary.shape.severityClass.optional()
});

/**
 * `sitemapRunId` is nullable rather than the route 404-ing.
 *
 * "This site has no finished run yet" is not "this site does not exist" —
 * conflating them made a freshly-onboarded site indistinguishable from a typo
 * in the URL. An empty list with a null run id lets the screen say which.
 *
 * `total` and `statusCounts` are computed over the WHOLE RUN under the active
 * filter, never over the returned page. A card that sums the visible rows and
 * labels it the run is the defect D3a found on both fleet screens.
 */
export const patternsResponse = z.object({
  sitemapRunId: uuid.nullable(),
  patterns: z.array(patternRankSummary).readonly(),
  total: z.number(),
  sort: z.enum(["population", "impact"]),
  status: patternSummary.shape.status.optional(),
  statusCounts: z
    .array(
      z.object({
        status: patternSummary.shape.status,
        count: z.number(),
        populationCount: z.number()
      })
    )
    .readonly(),
  /** URLs this run's sampler actually probed. Counted, not estimated. */
  observedUrls: z.number(),
  /** URLs the run discovered from sitemaps. Discovered, never requested. */
  totalUrls: z.number()
});

/** Bounds the pattern explorer's page. Capped for the ADR-0028 reason. */
export const patternsQuery = z.object({
  sort: z.enum(["population", "impact"]).default("population"),
  status: patternSummary.shape.status.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0)
});

/** One file's contribution to a pattern's population, named not referenced. */
export const patternFileSummary = z.object({
  id: uuid,
  patternId: uuid,
  sitemapFileId: uuid,
  urlCount: z.number(),
  fileUrl: z.string(),
  filename: z.string().nullable(),
  fileOrdinal: z.number()
});

export const patternDetailResponse = z.object({
  pattern: patternSummary,
  latestSample: patternSampleSummary.optional(),
  findings: z.array(auditSnapshotSummary).readonly(),
  observations: z.array(sampleObservationSummary).readonly(),
  files: z.array(patternFileSummary).readonly(),
  /**
   * The population summed from the per-file rows, and the point of sending it
   * is that it can DISAGREE with `pattern.populationCount`.
   *
   * The two are written by different steps, and a mismatch means a file was
   * parsed twice or not at all — which is precisely the M6 hazard where a
   * crash between an in-memory accumulation and its single end-of-run write
   * leaves a run finishing "clean" with a permanently undercounted population.
   * A screen that shows both makes that visible instead of latent.
   */
  populationFromFiles: z.number(),
  /**
   * How many URLs of the latest draw have actually been observed — the `n` of
   * the estimate, as opposed to `latestSample.sampleSize`, which is what was
   * drawn. A gap between them is a verification pass that did not finish.
   */
  observedCount: z.number()
});

/**
 * How many rows a fleet-wide list may return.
 *
 * These two routes are the only ones whose result set is not bounded by
 * something in the URL — a site's patterns are bounded by the site, a
 * pattern's findings by the pattern, but "every site's worst findings" grows
 * with the fleet. So the cap is explicit and enforced at the edge rather than
 * left to a repository default, and `max` means a caller cannot ask for the
 * whole table by passing `?limit=100000`.
 */
export const fleetQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

/**
 * How far back the per-site analytics series may reach.
 *
 * Capped at the edge for the reason `fleetQuery` is: this result set grows with
 * the site's RUN HISTORY rather than with anything bounded by the URL, so a
 * caller must not be able to ask for the whole table with `?windows=100000`.
 * 200 matches the other capped lists, so a reader has one number to remember
 * rather than a per-route table of them.
 *
 * Named `windows` rather than `limit` because the rows are health windows, not
 * a page of a list — a caller paging this would be asking the wrong question,
 * since the series is the point.
 */
export const analyticsQuery = z.object({
  windows: z.coerce.number().int().min(1).max(200).default(30)
});

/**
 * One site's operational history — the Analytics screen's whole payload.
 *
 * Every figure here is COUNTED, not estimated: these are rows in
 * `sampling_health` and `sitemap_run`, not sampled quantities, which is why
 * nothing in this response passes through the ADR-0008 interval shape. A
 * sampled figure would have to arrive as an `auditSnapshotSummary` and render
 * through `components/estimate.tsx`.
 */
export const siteAnalyticsResponse = z.object({
  site: siteSummary,
  /** Health windows, NEWEST FIRST, as `listSamplingHealth` returns them. */
  health: z.array(samplingHealthSummary).readonly(),
  /**
   * What was ASKED for, so the screen can say a truncated history is truncated
   * rather than presenting a capped page as the whole record — the same pairing
   * `fileCount` makes with `files` on the run detail, and the D3a finding that
   * both fleet screens counted their own page and called it the fleet.
   */
  windowLimit: z.number(),
  /** The runs behind those windows, OLDEST FIRST so a series reads left to right. */
  runs: z.array(runPointSummary).readonly(),
  latestRun: runSummary.optional(),
  /** Pattern outcomes for the latest run. Counted, so it may render bare. */
  patternStatus: z.array(patternStatusCountSummary).readonly()
});

/**
 * A finding on the fleet-wide list.
 *
 * Extends the per-pattern shape with the labels a cross-site row needs to be
 * attributable at all: the site it belongs to and the pattern it describes.
 * `siteId` travels too — not as data the reader sees, but because the row has
 * to link back into the drill-down, which is keyed on it. That is why it is
 * added here rather than to `auditSnapshotSummary`, where it would start
 * publishing on every per-pattern response that has no use for it.
 */
export const organizationFindingSummary = auditSnapshotSummary.extend({
  siteId: uuid,
  siteName: z.string(),
  patternTemplate: z.string()
});

export const issuesResponse = z.object({
  issues: z.array(organizationFindingSummary).readonly()
});

/** A run on the fleet-wide list — the per-site shape plus its site's name. */
export const organizationRunSummary = runSummary.extend({
  siteName: z.string()
});

export const runsResponse = z.object({
  runs: z.array(organizationRunSummary).readonly()
});

/**
 * One run's detail: the files it read and what its patterns became.
 *
 * Declared here rather than beside the other detail shapes because it reuses
 * `organizationRunSummary` — a `const` referenced before its own declaration is
 * a temporal-dead-zone error at import, not a hoisted forward reference.
 *
 * The run shape is the fleet one, carrying `siteName`: the route resolves the
 * run through the organization rather than a site in the path, so the site it
 * belongs to is something the response has to state rather than something the
 * caller already knew.
 */
export const runDetailResponse = z.object({
  run: organizationRunSummary,
  files: z.array(sitemapFileSummary).readonly(),
  /**
   * How many file rows exist, so the screen can say "showing 200 of 4,812"
   * rather than presenting a truncated list as if it were the whole run.
   *
   * Counted, not read from `run.totalFiles`: that column is a progress counter
   * a stage writes, so it is a claim about the run rather than a fact about the
   * rows this response just returned. Disagreement between the two is itself
   * worth being able to see.
   */
  fileCount: z.number(),
  patternStatus: z.array(patternStatusCountSummary).readonly(),
  samplingHealth: samplingHealthSummary.optional(),
  /** Patterns bucketed by PATH depth, for the distribution panel. */
  depthDistribution: z.array(patternDepthCountSummary).readonly(),
  /** Largest patterns by population, and the single smallest. */
  topPatterns: z.array(patternSummary).readonly(),
  smallestPattern: patternSummary.optional(),
  /**
   * The previous run's URL count, so the screen can show a trend.
   *
   * Absent on a site's first run, and optional rather than zero: a first run
   * has no trend, and a zero would render either as no change or as a total
   * collapse depending on which way the arithmetic runs.
   */
  previousTotalUrls: z.number().optional(),
  /** Probe outcomes across the run, for the distribution widget. */
  httpOutcomes: z.array(observationTallySummary).readonly(),
  /**
   * Recent runs for this site, OLDEST FIRST so a series reads left to right.
   * Includes this run, so a screen can mark where it sits in the history.
   */
  recentRuns: z.array(runPointSummary).readonly()
});

export const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
});

/**
 * A site settings edit — the API's first request BODY schema.
 *
 * Every field optional, because the form sends only what changed: an untouched
 * control must not be able to overwrite a column somebody else edited between
 * the page load and the save.
 *
 * The two caps are `.nullable()` and that is meaningful rather than permissive.
 * Null is how a site says "inherit the platform default", so clearing a cap is
 * a real edit and has to be expressible — distinct from omitting the field,
 * which means "leave it alone".
 *
 * `.strict()` so an unknown key is a 400 rather than being quietly dropped.
 * The response schemas strip unknown keys deliberately, but a WRITE is the
 * opposite case: silently ignoring a field the caller believed it was setting
 * is how a form appears to save something it did not.
 */
export const siteUpdateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    baseUrl: z.url().max(2048).optional(),
    tier: z.enum(["standard", "priority", "bulk"]).optional(),
    isActive: z.boolean().optional(),
    dailyRequestCap: z.number().int().min(1).nullable().optional(),
    minRequestIntervalMs: z.number().int().min(0).nullable().optional()
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update."
  });

/** The organization the API is acting as. Identity only — no counts, no policy. */
export const organizationSummary = z.object({
  id: uuid,
  name: z.string(),
  slug: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate
});

/**
 * One operational limit, with the fact of whether anything applies it.
 *
 * `enforcedAt` is the file that consumes the value, or null. It travels on the
 * wire rather than being decided by the screen: a page that classified these
 * itself would be a hand-maintained list rotting one commit after someone wires
 * a limit up. The API derives it from `POLICY_LIMITS`, and a test fails when
 * the manifest and the code disagree.
 */
export const policyLimitSummary = z.object({
  key: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.enum(["rps", "count", "fraction", "ms", "bytes"]),
  enforcedAt: z.string().nullable()
});

/**
 * Read-only platform settings.
 *
 * Per-site policy is deliberately NOT here: `GET /sites` already returns every
 * site column, so repeating them would mean a second declaration of
 * `siteSummary` to drift from the first. The screen makes two calls.
 */
export const settingsResponse = z.object({
  organization: organizationSummary,
  policy: z.array(policyLimitSummary).readonly(),
  /**
   * Per-site columns that are stored and served but applied by nothing.
   *
   * Sent so the screen can badge the per-site table it builds from `/sites`
   * without deciding enforcement for itself — same reason as `enforcedAt`
   * above.
   */
  siteColumns: z.array(policyLimitSummary.omit({ value: true })).readonly()
});

/** One probed URL, carrying the pattern it was drawn from. */
export const runObservationSummary = sampleObservationSummary.extend({
  patternTemplate: z.string()
});

/**
 * A page of a run's observations.
 *
 * `total` counts PROBES, not URLs — a screen pairing them with "of N" has to
 * say which, because the two differ by the entire point of the product. See
 * the note on `listRunObservations`.
 */
export const runObservationsResponse = z.object({
  observations: z.array(runObservationSummary).readonly(),
  total: z.number()
});

/** Which HTTP outcomes an explorer may filter to. */
export const observationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z
    .enum(["ok", "redirect", "client_error", "server_error", "error"])
    .optional()
});

// --- Projects portfolio ----------------------------------------------------

/**
 * The severity classes a portfolio row breaks its findings into.
 *
 * The full enum, not a shortened one: `blocked` and `unknown` both weigh zero
 * severity and neither is a defect (see `schema/enums.ts`), so folding them
 * into a single "other" bucket would let a WAF blocking us read as a clean
 * site — and dropping them would make the row's counts not add up to its
 * total, which a reader will notice and distrust.
 */
export const severityClass = z.enum([
  "gone",
  "not_found",
  "soft_not_found",
  "server_error",
  "redirect_chain",
  "redirect_single",
  "ok",
  "blocked",
  "unknown"
]);

/**
 * One row of the fleet portfolio.
 *
 * COUNTS ONLY. Every number here is a counted quantity — sites, URLs
 * discovered, patterns, findings — and none is an estimate. That is what makes
 * the row safe to render as a table cell and a KPI card: an estimate carries an
 * interval and belongs in `<Estimate>` (ADR-0008), and summing estimated
 * volumes across a fleet would manufacture a precise-looking total out of
 * uncertain parts, which DESIGN.md bans by name.
 *
 * THERE IS NO HEALTH SCORE, and its absence is deliberate rather than pending.
 * The Stitch screen shows "88.4/100" per project and a fleet average beside it;
 * this platform computes no such number anywhere, and a composite invented in a
 * serializer would be a figure with no definition, no test and no way for a
 * reader to check it. The row carries the findings it actually has instead.
 */
export const projectSummary = z.object({
  site: siteSummary,
  /** Absent when the site has never run. Not an error — a new project. */
  latestRun: runSummary.optional(),
  findings: z.object({
    total: z.number(),
    /**
     * Findings whose severity class this platform treats as damage.
     *
     * Derived from the same table `severityFor` ranks with (ADR-0014), never
     * re-decided in the interface: `blocked` and `unknown` are excluded because
     * a host refusing us is not a site defect.
     */
    critical: z.number(),
    bySeverity: z
      .array(z.object({ severityClass, count: z.number() }))
      .readonly()
  })
});

/**
 * The portfolio's own filters, cap and window.
 *
 * `limit`/`offset` rather than the fleet lists' bare `limit`, because this
 * screen paginates: its footer says "showing 1-N of M" and offers prev/next,
 * which needs a window and a total rather than a top-N. Capped at the edge for
 * the reason `fleetQuery` is — the result set grows with the fleet, not with
 * anything bounded by the URL.
 *
 * There is no `cadence` filter and there will not be one until a scheduler
 * exists: the Stitch screen offers one, and `site` has no cadence column,
 * no job runs on a schedule, and nothing anywhere stores an interval.
 */
export const projectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  tier: z.enum(["standard", "priority", "bulk"]).optional(),
  includeInactive: z.stringbool().default(false)
});

export const projectsResponse = z.object({
  projects: z.array(projectSummary).readonly(),
  /** Matching sites, ignoring the page window — the "of M" in the footer. */
  total: z.number(),
  /**
   * Fleet figures, computed over EVERY matching site rather than the page.
   *
   * Separate from the rows on purpose. A KPI card summing the page and
   * labelling it the fleet is the defect D3a found on both fleet screens, where
   * a card counted 50 rows and called it the total; here the totals come from
   * their own queries and the page cannot influence them.
   */
  totals: z.object({
    sites: z.number(),
    /** Sites onboarded in the last 30 days — the design's "+2 this month". */
    onboardedRecently: z.number(),
    urlsDiscovered: z.number(),
    patterns: z.number(),
    findings: z.number(),
    criticalFindings: z.number()
  })
});

/**
 * Onboarding a project.
 *
 * `.strict()` for the reason `siteUpdateBody` is: silently ignoring a key the
 * caller believed in is worse than refusing it. `host` is absent deliberately —
 * it is derived from `baseUrl` by the repository so the bucket the outbound
 * rate limiter throttles on can never disagree with the URL actually requested.
 */
export const siteCreateBody = z
  .object({
    name: z.string().min(1).max(200),
    baseUrl: z.url().max(2048),
    tier: z.enum(["standard", "priority", "bulk"]).optional(),
    dailyRequestCap: z.number().int().min(1).optional(),
    minRequestIntervalMs: z.number().int().min(0).optional()
  })
  .strict();

/**
 * Start a run. `sitemapUrl` is optional because the ordinary case — audit
 * this site's own sitemap — needs no input at all; the route defaults to
 * `{baseUrl}/sitemap.xml`. Present only for the case where a site's sitemap
 * genuinely lives somewhere else (a CDN-served sitemap next to an
 * apex-domain site, for one).
 */
export const runTriggerBody = z
  .object({
    sitemapUrl: z.url().max(2048).optional()
  })
  .strict();

// --- Tools (pure computation, no database) --------------------------------

/**
 * How many URLs one extraction may analyse.
 *
 * REJECTED ABOVE THE CAP, NEVER TRUNCATED, and the difference matters more here
 * than on a list route. Truncating a list costs the caller rows they can page
 * for. Truncating a pattern extraction changes EVERY number it returns — the
 * populations, the sample draw, and above all the parameterisation decision,
 * which is a function of how many URLs passed through each path position. A
 * `truncated: true` flag over numbers that are all wrong about the input is the
 * §1.5 failure it would appear to be preventing.
 */
export const TOOL_MAX_URLS = 5_000;

/** A second bound on the same input, so a single enormous line cannot pass. */
export const TOOL_MAX_TEXT_CHARACTERS = 512_000;

/**
 * What the sample-plan tool is asked.
 *
 * `population` is `.min(1)`, and that is a CORRECTNESS bound rather than
 * hygiene. At a population of zero `estimateStratified` yields a zero-width
 * interval, `relativeIntervalWidth` sees a width of 0, and the band comes back
 * `confident` — a claim of certainty about nothing, which is precisely the
 * legacy `[0, 0]` defect this product exists to refute, resurfacing at N = 0.
 *
 * The `hits <= sampled` refine is MANDATORY, not defensive: `estimateStratified`
 * throws `InvalidProportionError` on that input, and `errors.ts` maps
 * `ApiProblem` and zod failures only — so without this the caller gets a 500
 * with a stack trace instead of a 400 telling them what they got wrong.
 */
export const samplePlanQuery = z
  .object({
    population: z.coerce.number().int().min(1).max(1_000_000_000),
    sampled: z.coerce.number().int().min(0).optional(),
    hits: z.coerce.number().int().min(0).optional()
  })
  .refine(
    (query) =>
      query.hits === undefined ||
      query.sampled === undefined ||
      query.hits <= query.sampled,
    { message: "hits cannot exceed sampled", path: ["hits"] }
  );

/**
 * A measurement, in the shape everything that publishes one uses.
 *
 * FIELD NAMES ARE DELIBERATELY THOSE OF `auditSnapshotSummary`. `<Estimate>` is
 * the only module allowed to format a sampled figure (ADR-0008), and it reads
 * these names; matching them means the tool's output flows through the existing
 * adapter rather than acquiring a second one. A second adapter is a second
 * chance to render an interval-less estimate.
 */
export const sampledMeasurement = z.object({
  evidenceTier: z.enum(["counted", "estimated"]),
  observedCount: z.number(),
  sampleSize: z.number(),
  populationCount: z.number(),
  pointEstimate: z.number(),
  ciLow: z.number(),
  ciHigh: z.number(),
  confidenceLevel: z.number(),
  confidenceBand: z.enum(["confident", "approximate", "low"]),
  estimatorVersion: z.string()
});

export const sampleBudgetSummary = z.object({
  sampleRate: z.number(),
  minSample: z.number(),
  maxFirstRound: z.number(),
  maxExpanded: z.number(),
  maxExpansionFactor: z.number(),
  maxPopulationFraction: z.number(),
  minPerStratum: z.number()
});

export const samplePlanResponse = z.object({
  budget: sampleBudgetSummary,
  plan: z.object({
    populationTotal: z.number(),
    sampleTotal: z.number(),
    /** What the rate WORKS OUT AT, not the nominal one the budget names. */
    effectiveRate: z.number()
  }),
  /** Present only once the caller says what the sample found. */
  measurement: sampledMeasurement.optional(),
  expansion: z
    .object({
      shouldExpand: z.boolean(),
      reason: z.enum([
        "interval_too_wide",
        "unsampled_strata",
        "already_precise",
        "at_expansion_ceiling",
        "at_population_ceiling",
        "nothing_left_to_sample"
      ]),
      additionalTotal: z.number()
    })
    .optional(),
  thresholds: z.object({
    approximateWidth: z.number(),
    lowWidth: z.number(),
    zeroHitApproximateWidth: z.number(),
    zeroHitLowWidth: z.number()
  }),
  /**
   * Always the package default, and said on the wire rather than assumed by the
   * screen — the same reason `enforcedAt` travels on `policyLimitSummary`. The
   * four `CONFIDENCE_*` variables are configured and applied by nothing, so a
   * tool honouring them would disagree with the pipeline while `/settings`
   * truthfully reported they do nothing.
   */
  thresholdSource: z.literal("package-default")
});

/**
 * What the pattern extractor is given.
 *
 * `.strict()` for the reason `siteUpdateBody` is strict: silently ignoring a
 * field the caller believed it set is how a form appears to work.
 */
export const patternExtractionBody = z
  .object({
    text: z.string().min(1).max(TOOL_MAX_TEXT_CHARACTERS),
    host: z.string().min(1).max(253).optional()
  })
  .strict();

export const patternExtractionResponse = z.object({
  /** The host every URL was measured against. */
  host: z.string(),
  hostSource: z.enum(["supplied", "derived", "none"]),
  hostBreakdown: z
    .array(z.object({ host: z.string(), count: z.number() }))
    .readonly(),
  input: z.object({
    submitted: z.number(),
    blank: z.number(),
    analysed: z.number()
  }),
  /**
   * Foreign and unparseable are FINDINGS, not errors. A sitemap full of
   * off-domain URLs is usually a botched migration, and reporting the list as
   * simply smaller would hide it.
   */
  outcome: z.object({
    matched: z.number(),
    foreign: z.number(),
    unparseable: z.number()
  }),
  foreignSamples: z.array(z.string()).readonly(),
  unparseableSamples: z.array(z.string()).readonly(),
  /**
   * Why the URLs did or did not collapse. Carried explicitly because the
   * alternative is a reader concluding the tool is broken when it is applying
   * the rule that stopped the legacy engine merging 2,946 static pages into one
   * meaningless template.
   */
  parameterisation: z.object({
    minObservedUrls: z.number(),
    uniqueThreshold: z.number(),
    uniqueRatioThreshold: z.number(),
    observedUrls: z.number(),
    belowFloor: z.boolean(),
    urlsShortOfFloor: z.number(),
    templatesTotal: z.number(),
    templatesParameterised: z.number()
  }),
  patterns: z
    .array(
      z.object({
        template: z.string(),
        segmentCount: z.number(),
        paramCount: z.number(),
        populationCount: z.number(),
        plannedSampleSize: z.number(),
        sample: z.array(z.string()).readonly()
      })
    )
    .readonly()
});
