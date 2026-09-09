import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../components/api-error";
import { PageBody, TopBar } from "../../../components/app-shell";
import { BarChart } from "../../../components/bar-chart";
import { Donut } from "../../../components/donut";
import {
  AnalyticsIcon,
  CrawlIcon,
  DashboardIcon,
  IssuesIcon
} from "../../../components/icons";
import { Meter } from "../../../components/meter";
import { Panel } from "../../../components/panel";
import {
  CIRCUIT_BREAKS_UNMEASURED_REASON,
  NOT_MEASURED,
  SamplingHealthGrid
} from "../../../components/sampling-health";
import { Sparkline } from "../../../components/sparkline";
import { StackedBar } from "../../../components/stacked-bar";
import { StatCards } from "../../../components/stat-cards";
import { StatusBadge } from "../../../components/status-badge";
import {
  ApiError,
  getRun,
  type HttpStatusClass,
  listRunObservations,
  type RunDetail,
  type RunObservations
} from "../../../lib/api";
import { formatBytes, formatCount, formatDateTime } from "../../../lib/format";
import {
  averageDepth,
  coverageFraction,
  depthBuckets,
  explorerFooter,
  formatCoverage,
  formatTrend,
  outcomeSlices,
  pageWindow,
  trendPercent
} from "../../../lib/run-analysis";
import {
  httpStatusTone,
  patternStatusTone,
  rowAccentStyle,
  runStatusTone,
  sitemapFileTone,
  type Tone
} from "../../../lib/status";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUS_FILTERS: readonly {
  readonly value: HttpStatusClass | "all";
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "2xx" },
  { value: "redirect", label: "3xx" },
  { value: "client_error", label: "4xx" },
  { value: "server_error", label: "5xx" },
  { value: "error", label: "No response" }
];

function statusClassFrom(raw: string | undefined): HttpStatusClass | undefined {
  const match = STATUS_FILTERS.find(
    (filter) => filter.value === raw && filter.value !== "all"
  );

  return match?.value as HttpStatusClass | undefined;
}

/** The HTTP status column's tone — an absent response is not a 5xx. */
function httpTone(status: number | null): Tone {
  if (status === null) {
    return "unknown";
  }

  if (status >= 500) {
    return "critical";
  }

  if (status >= 400) {
    return "critical";
  }

  if (status >= 300) {
    return "warning";
  }

  return "healthy";
}

/**
 * The four figures at the top, every one COUNTED.
 *
 * The design's fourth card is the alarming one — "Broken Internal Links 156,
 * Action Req." — and it cannot be reproduced twice over: there is no link graph,
 * and the nearest real number is an ESTIMATE, which `docs/DESIGN.md` bars from a
 * card because a card cannot carry an interval. The honest equivalent is the
 * count of patterns that produced no measurement at all, which is counted,
 * actionable, and the thing a reader of this screen should look at first.
 */
function statsFor(detail: RunDetail) {
  const { run, patternStatus, depthDistribution } = detail;

  const byStatus = (name: string): number =>
    patternStatus.find((entry) => entry.status === name)?.count ?? 0;

  const unmeasured = byStatus("blocked") + byStatus("needs_review");
  const trend = trendPercent(run.totalUrls, detail.previousTotalUrls);
  const depth = averageDepth(depthDistribution);

  return [
    {
      label: "urls discovered",
      value: formatCount(run.totalUrls),
      icon: CrawlIcon,
      ...(trend === undefined
        ? {}
        : {
            chip: {
              text: formatTrend(trend),
              // A bigger sitemap is not good news and a smaller one is not bad
              // news — it is a change, and the reader decides. Neutral tone.
              tone: "unknown" as Tone
            }
          })
    },
    {
      label: "patterns",
      value: formatCount(run.totalPatterns),
      icon: AnalyticsIcon
    },
    {
      /*
       * PATH DEPTH, NOT LINK DEPTH. The design's equivalent card says "clicks
       * from root", which needs a link graph this platform does not build. The
       * label and the tooltip both say which one this is, because the two
       * resemble each other closely enough to be misread at a glance.
       */
      label: "avg path depth",
      value: depth === undefined ? "—" : depth.toFixed(1),
      icon: DashboardIcon,
      title:
        "Mean path segments per URL, weighted by population. NOT clicks from a home page — this platform samples sitemaps and builds no link graph."
    },
    {
      label: "blocked or needs review",
      value: formatCount(unmeasured),
      icon: IssuesIcon,
      ...(unmeasured > 0
        ? {
            chip: { text: "no measurement", tone: "warning" as Tone },
            emphasis: "warning" as Tone
          }
        : {})
    }
  ];
}

export default async function RunDetailPage({
  params,
  searchParams
}: {
  readonly params: Promise<{ runId: string }>;
  readonly searchParams: Promise<{
    readonly page?: string;
    readonly status?: string;
  }>;
}) {
  const { runId } = await params;
  const query = await searchParams;
  const statusClass = statusClassFrom(query.status);
  const page = Math.max(1, Number(query.page ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let detail: RunDetail;
  let explorer: RunObservations;

  try {
    // Two calls: the panels and the explorer page. Paging must not refetch the
    // distribution and ranking queries, which do not change between pages.
    [detail, explorer] = await Promise.all([
      getRun(runId),
      listRunObservations(runId, {
        limit: PAGE_SIZE,
        offset,
        ...(statusClass === undefined ? {} : { status: statusClass })
      })
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }

    return (
      <>
        <TopBar items={[{ label: "Runs", href: "/runs" }]} />
        <PageBody>
          <div className="mt-6">
            <ApiErrorPanel
              message={
                error instanceof ApiError
                  ? error.message
                  : "Unknown error contacting the API."
              }
            />
          </div>
        </PageBody>
      </>
    );
  }

  const { run, files, fileCount, patternStatus, samplingHealth } = detail;
  const tone = runStatusTone(run.status);
  const buckets = depthBuckets(detail.depthDistribution);
  const window = pageWindow(offset, PAGE_SIZE, explorer.total);
  const largest = detail.topPatterns[0]?.populationCount ?? 0;
  const counterDisagrees = run.totalFiles !== fileCount;
  const probeTotal = detail.httpOutcomes.reduce(
    (sum, outcome) => sum + outcome.count,
    0
  );
  /*
   * `httpRequests` counts every PROBE request the run spent, which is higher
   * than the probe count whenever a HEAD escalated to a GET. It deliberately
   * excludes the sitemap index and file downloads the discover and ingest
   * stages perform: this is the numerator of a coverage ratio against URLs
   * discovered, and folding a fixed per-run download cost into that would
   * misreport how much of the population had to be touched.
   *
   * `|| probeTotal`, not `?? probeTotal`. Until ADR-0034 the finalize stage
   * wrote a literal 0 here, and `??` does not fall back on 0 — so every real
   * run rendered 0.0% coverage and a `0 / N` meter, correct-looking and wrong,
   * while the demo seed's fabricated figures kept it hidden. The stage now
   * derives the number, and this stays as `||` because a genuine zero and an
   * unwritten zero are the same value: falling back to the probe count is
   * right in both cases.
   */
  const requests = samplingHealth?.httpRequests || probeTotal;
  const coverage = coverageFraction(requests, run.totalUrls);

  const filterHref = (value: HttpStatusClass | "all"): string =>
    value === "all" ? `/runs/${run.id}` : `/runs/${run.id}?status=${value}`;

  const pageHref = (next: number): string => {
    const search = new URLSearchParams();

    if (statusClass !== undefined) {
      search.set("status", statusClass);
    }

    if (next > 1) {
      search.set("page", String(next));
    }

    return search.size === 0
      ? `/runs/${run.id}`
      : `/runs/${run.id}?${search.toString()}`;
  };

  return (
    <>
      <TopBar
        items={[
          { label: "Runs", href: "/runs" },
          { label: run.siteName, href: `/sites/${run.siteId}` },
          {
            label: run.startedAt ? formatDateTime(run.startedAt) : "not started"
          }
        ]}
      />
      <PageBody>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Sampling Analysis
            </h1>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              {formatCount(run.totalUrls)} URLs collapsed into{" "}
              {formatCount(run.totalPatterns)} patterns for {run.siteName}, of
              which {formatCount(explorer.total)} were probed.
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/*
              A plain link, not a button: the browser downloads it, and a Next
              route handler proxies the API so WEB_API_URL stays server-only.
            */}
            <a
              className="rounded-sm px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface hover:text-primary"
              href={`/runs/${run.id}/export`}
            >
              Export CSV
            </a>
            <span
              aria-disabled="true"
              className="cursor-not-allowed rounded-sm bg-surface px-4 py-2 text-sm font-medium text-tertiary"
              title="Runs are started by the worker. The API exposes no way to enqueue one, and there is no auth to scope it to."
            >
              Re-run
            </span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <StatusBadge tone={tone} label={run.status} />
          {run.isDryRun && <StatusBadge tone="unknown" label="dry run" />}
          {run.statusReason && (
            <span className="font-mono text-2xs uppercase tracking-wider text-tertiary">
              {run.statusReason.replace(/_/g, " ")}
            </span>
          )}
          <span className="font-mono text-2xs text-tertiary">run {run.id}</span>
        </div>

        <div className="mt-6">
          <StatCards stats={statsFor(detail)} />
        </div>

        {counterDisagrees && (
          <p className="mt-4 max-w-prose text-xs text-warning">
            This run reports {formatCount(run.totalFiles)} files while{" "}
            {formatCount(fileCount)} file rows exist. A run whose counter and
            rows disagree has either not finished recording its files or lost
            some — treat its URL and pattern counts as incomplete.
          </p>
        )}

        {/* The design's three analysis panels, filled with counted data. */}
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <Panel title="Path depth distribution">
            <BarChart
              bars={buckets.map((bucket) => ({
                label: bucket.label,
                value: bucket.patterns,
                title: `${bucket.patterns} patterns at depth ${bucket.label}, holding ${formatCount(bucket.urls)} URLs`
              }))}
              caption="Patterns by path segments in the template — not clicks from a home page."
              label="Patterns by path depth"
            />
          </Panel>

          <Panel title="Pattern status">
            {/*
              Stands where the design puts an "Equity Flow" diagram, which is a
              link-graph visualisation and has no analogue here. A stacked bar
              rather than a list of badges: the question a reader brings to this
              panel is how a run's patterns DIVIDE, and a stack answers it at a
              glance where a column of counts makes them do the arithmetic.
            */}
            <StackedBar
              label="Patterns by status"
              segments={[...patternStatus]
                .sort((a, b) => b.count - a.count)
                .map((entry) => ({
                  label: entry.status,
                  value: entry.count,
                  tone: patternStatusTone(entry.status),
                  secondary: `${formatCount(entry.populationCount)} URLs`
                }))}
            />
          </Panel>

          <Panel title="Pattern population">
            <div className="flex flex-col gap-4">
              {detail.topPatterns.length === 0 ? (
                <p className="text-sm text-secondary">No patterns to rank.</p>
              ) : (
                <>
                  {detail.topPatterns.map((pattern) => (
                    <Meter
                      formatted={formatCount(pattern.populationCount)}
                      key={pattern.id}
                      label={pattern.template}
                      max={largest}
                      value={pattern.populationCount}
                    />
                  ))}
                  {detail.smallestPattern && (
                    <div className="border-t border-border-subtle pt-4">
                      <p className="mb-2 font-mono text-2xs uppercase tracking-wider text-tertiary">
                        Smallest
                      </p>
                      <Meter
                        formatted={formatCount(
                          detail.smallestPattern.populationCount
                        )}
                        label={detail.smallestPattern.template}
                        max={largest}
                        tone="muted"
                        value={detail.smallestPattern.populationCount}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </Panel>
        </div>

        {/*
          A SECOND WIDGET ROW, beyond the design's three panels (ADR-0033).
          The coverage widget is the one that earns it: the platform's whole
          argument is auditing a large site without requesting all of it, and
          that ratio was sitting unvisualised in a definition grid.
        */}
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <Panel title="Probe outcomes">
            <Donut
              centreLabel="probes"
              centreValue={formatCount(probeTotal)}
              label="Probe outcomes by HTTP status"
              segments={outcomeSlices(detail.httpOutcomes).map((slice) => ({
                label: slice.label,
                value: slice.value,
                tone: httpStatusTone(slice.httpStatus, slice.isSoft404),
                title: `${slice.label}: ${slice.value} probes`
              }))}
            />
          </Panel>

          <Panel title="Sampling coverage">
            <div className="flex flex-col gap-5">
              {coverage === undefined ? (
                <p className="text-sm text-secondary">
                  This run discovered no URLs, so there is no coverage to
                  report.
                </p>
              ) : (
                <>
                  <div>
                    <div
                      className="font-mono text-xl leading-none tabular-nums text-primary"
                      data-numeric
                    >
                      {formatCoverage(coverage)}
                    </div>
                    <p className="mt-2 text-2xs text-tertiary">
                      {formatCount(requests)} requests against{" "}
                      {formatCount(run.totalUrls)} URLs. A small number here is
                      the product working, not a shortfall.
                    </p>
                  </div>

                  <Meter
                    formatted={`${formatCount(requests)} / ${formatCount(run.totalUrls)}`}
                    label="URLs requested"
                    max={run.totalUrls}
                    value={requests}
                  />
                  <Meter
                    formatted={`${formatCount(run.parsedFiles)} / ${formatCount(run.totalFiles)}`}
                    label="Sitemap files parsed"
                    max={run.totalFiles}
                    tone="muted"
                    value={run.parsedFiles}
                  />

                  {samplingHealth && (
                    <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4 font-mono text-2xs text-tertiary">
                      <span>
                        {formatCount(samplingHealth.getEscalations)} GET
                        escalations
                      </span>
                      {/*
                       * Not `formatCount(samplingHealth.circuitBreaks)`.
                       * Nothing in the platform produces that number, so a 0
                       * here would report a measurement nobody made — see
                       * `CIRCUIT_BREAKS_UNMEASURED_REASON`.
                       */}
                      <span title={CIRCUIT_BREAKS_UNMEASURED_REASON}>
                        circuit breaks {NOT_MEASURED}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>
          </Panel>

          <Panel title="URLs over recent runs">
            <div className="flex flex-col gap-4">
              <Sparkline
                label="URLs discovered across recent runs"
                points={detail.recentRuns.map((point) => ({
                  value: point.totalUrls,
                  title: point.startedAt
                    ? formatDateTime(point.startedAt)
                    : "not started"
                }))}
              />
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="font-mono text-xl leading-none tabular-nums text-primary"
                  data-numeric
                >
                  {formatCount(run.totalUrls)}
                </span>
                <span className="font-mono text-2xs text-tertiary">
                  {detail.recentRuns.length === 1
                    ? "first run for this site"
                    : `across ${formatCount(detail.recentRuns.length)} runs`}
                </span>
              </div>
            </div>
          </Panel>
        </div>

        <h2 className="mt-12 text-lg font-semibold tracking-tight">
          Sampled URL explorer
        </h2>
        <p className="mt-1 max-w-prose text-sm text-secondary">
          {/*
            THE SENTENCE THIS SCREEN CANNOT SHIP WITHOUT. The design's explorer
            lists every internal link on a site; this one lists the URLs the
            sampler actually probed. Presenting a sample as a census is the one
            claim this product must never make, and a paginated table looks
            exactly like a census unless it says otherwise.
          */}
          Every URL this run actually probed — the sample, not the population.
          The other {formatCount(Math.max(0, run.totalUrls - explorer.total))}{" "}
          URLs were never requested, which is the point.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((filter) => {
            const active =
              filter.value === "all"
                ? statusClass === undefined
                : filter.value === statusClass;

            return (
              <Link
                aria-current={active ? "true" : undefined}
                className={
                  active
                    ? "rounded-sm border border-accent bg-surface px-3 py-1.5 font-mono text-2xs text-accent-text"
                    : "rounded-sm border border-border-subtle px-3 py-1.5 font-mono text-2xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
                }
                href={filterHref(filter.value)}
                key={filter.value}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <caption className="sr-only">
              URLs probed by this run, most recent first
            </caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th
                  className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  URL
                </th>
                <th
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  Pattern
                </th>
                <th
                  className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  HTTP
                </th>
                <th
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  Method
                </th>
                <th
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  Flags
                </th>
                <th
                  className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  scope="col"
                >
                  Observed
                </th>
              </tr>
            </thead>
            <tbody>
              {explorer.observations.map((observation) => (
                <tr
                  className="border-b border-border-subtle transition-colors hover:bg-surface"
                  key={observation.id}
                  style={rowAccentStyle(httpTone(observation.httpStatus))}
                >
                  <td
                    className="max-w-[360px] truncate py-3 pr-4 pl-3 font-mono text-xs text-secondary"
                    title={observation.url}
                  >
                    {observation.url}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-tertiary">
                    {observation.patternTemplate}
                  </td>
                  <td
                    className="py-3 pr-4 text-right font-mono text-xs tabular-nums"
                    data-numeric
                    style={{
                      color: `var(--status-${httpTone(observation.httpStatus)})`
                    }}
                  >
                    {observation.httpStatus ?? "—"}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-secondary">
                    {observation.methodUsed ?? "—"}
                  </td>
                  <td className="py-3 pr-4 font-mono text-2xs text-tertiary">
                    {[
                      observation.escalatedToGet ? "escalated" : null,
                      observation.isSoft404 ? "soft-404" : null,
                      observation.errorReason
                    ]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </td>
                  <td
                    className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                    data-numeric
                  >
                    {formatDateTime(observation.observedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-2xs uppercase tracking-wider text-tertiary">
            {explorerFooter(window, explorer.total)}
          </p>
          <div className="flex items-center gap-2">
            {window.hasPrevious ? (
              <Link
                className="rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
                href={pageHref(page - 1)}
              >
                Previous
              </Link>
            ) : (
              <span className="rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-tertiary">
                Previous
              </span>
            )}
            {window.hasNext ? (
              <Link
                className="rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
                href={pageHref(page + 1)}
              >
                Next
              </Link>
            ) : (
              <span className="rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-tertiary">
                Next
              </span>
            )}
          </div>
        </div>

        <h2 className="mt-12 text-lg font-semibold tracking-tight">
          Sampling health
        </h2>

        {samplingHealth ? (
          <div className="mt-4">
            <SamplingHealthGrid health={samplingHealth} />
          </div>
        ) : (
          <p className="mt-4 text-sm text-secondary">
            No health record yet — these figures are written when a run is
            finalised.
          </p>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">Files</h2>
        <p className="mt-1 max-w-prose text-sm text-secondary">
          {files.length < fileCount
            ? `The sitemap files this run read, in file order — showing ${formatCount(files.length)} of ${formatCount(fileCount)}.`
            : "The sitemap files this run read, in file order."}
        </p>

        {files.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">
            No files recorded for this run.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">
                Sitemap files read by this run
              </caption>
              <thead>
                <tr className="border-b border-border-strong text-left">
                  <th
                    className="py-2 pr-4 pl-3 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    #
                  </th>
                  <th
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    File
                  </th>
                  <th
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    Parse
                  </th>
                  <th
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    URLs
                  </th>
                  <th
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    Size
                  </th>
                  <th
                    className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    scope="col"
                  >
                    Parsed
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => {
                  const fileTone = sitemapFileTone(
                    file.parseStatus,
                    file.urlCount
                  );
                  // See `sitemapFileTone`: a clean parse that yielded nothing
                  // is the one case `parse_status` cannot express.
                  const parsedEmpty =
                    file.parseStatus === "parsed" && file.urlCount === 0;

                  return (
                    <tr
                      className="border-b border-border-subtle transition-colors hover:bg-surface"
                      key={file.id}
                      style={rowAccentStyle(fileTone)}
                    >
                      <td
                        className="py-3 pr-4 pl-3 text-right font-mono text-xs tabular-nums text-tertiary"
                        data-numeric
                      >
                        {file.fileOrdinal}
                      </td>
                      <td
                        className="max-w-[340px] truncate py-3 pr-4 font-mono text-xs text-secondary"
                        title={file.url}
                      >
                        {file.filename ?? file.url}
                        {file.isGzip && (
                          <span className="ml-2 text-2xs uppercase tracking-wider text-tertiary">
                            gz
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge
                            tone={fileTone}
                            label={file.parseStatus}
                          />
                          {/*
                            THE EMPTY PARSE, SAID OUT LOUD. An accepted file
                            that yielded zero URLs looked identical to a
                            healthy one here — the indistinguishability
                            CLAUDE.md's non-negotiable rules forbid. An HTML
                            error page parses as valid, URL-less XML.
                          */}
                          {parsedEmpty && (
                            <StatusBadge tone="warning" label="no urls" />
                          )}
                          {file.parseError && (
                            <span
                              className="max-w-[220px] truncate font-mono text-2xs text-tertiary"
                              title={file.parseError}
                            >
                              {file.parseError}
                            </span>
                          )}
                        </div>
                      </td>
                      <td
                        className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                        data-numeric
                      >
                        {formatCount(file.urlCount)}
                      </td>
                      <td
                        className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                        data-numeric
                      >
                        {file.byteSize === null
                          ? "—"
                          : formatBytes(file.byteSize)}
                      </td>
                      <td
                        className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                        data-numeric
                      >
                        {file.parsedAt ? formatDateTime(file.parsedAt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </>
  );
}
