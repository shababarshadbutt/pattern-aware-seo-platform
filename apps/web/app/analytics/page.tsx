import Link from "next/link";

import { ApiErrorPanel } from "../../components/api-error";
import { PageBody, TopBar } from "../../components/app-shell";
import { BarChart } from "../../components/bar-chart";
import { Donut } from "../../components/donut";
import { Meter } from "../../components/meter";
import { Panel } from "../../components/panel";
import { SamplingHealthGrid } from "../../components/sampling-health";
import { Sparkline } from "../../components/sparkline";
import { StackedBar } from "../../components/stacked-bar";
import { StatCards } from "../../components/stat-cards";
import { StatusBadge } from "../../components/status-badge";
import {
  ANALYTICS_WINDOW_COUNT,
  ApiError,
  getSiteAnalytics,
  listSites,
  type SiteAnalytics,
  type SiteSummary
} from "../../lib/api";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  coverageFraction,
  formatCoverage,
  formatTrend,
  runStatusSlices,
  trendPercent
} from "../../lib/run-analysis";
import {
  patternStatusTone,
  rowAccentStyle,
  runStatusTone
} from "../../lib/status";

/**
 * Per-site operational analytics, on the DESIGN.md section 7.2 composition.
 *
 * THE RAIL ITEM THIS BACKS WAS DISABLED ON PURPOSE, and reversing that is only
 * half right. ADR-0028 ruled Tools and Analytics unbuildable because they "have
 * no schema, no pipeline stage and no data, so a screen for them would have to
 * invent numbers". That was correct about STITCH's Analytics screen — Core Web
 * Vitals, internal links, structured data, none of which this platform
 * measures — and wrong about this platform's: `sampling_health` is the schema,
 * `runFinalize` is the stage that writes it, and `listSamplingHealth` was a
 * working per-site time series that no HTTP route had ever called. Tools stays
 * disabled. See ADR-0034.
 *
 * NOTHING ON THIS SCREEN GOES THROUGH `<Estimate>`, and that is a decision
 * rather than an oversight. Every figure here is a row count from a finished
 * run — requests spent, escalations, patterns by status — so none of them is
 * sampled and none can carry an interval. A card showing "estimated affected
 * URLs" would have to come from `listSnapshotsByImpact` and would have to
 * render through the adapter; that is the Issues screen's job, not this one's.
 */

export const dynamic = "force-dynamic";

/**
 * The four KPI cards, every one COUNTED (DESIGN.md section 5).
 *
 * Read from the LATEST WINDOW, never summed across the page. Summing a capped
 * series and labelling it a site total is the manufactured-precision failure
 * section 9 bans and the one the Issues screen documents: a figure that means
 * "at least N" presented as "N". A real total would need its own aggregate
 * query, not arithmetic over whatever rows happened to be fetched.
 *
 * Coverage and escalation share are deliberately NOT cards. Both are ratios,
 * and a card frames a counted figure — but more importantly
 * `getEscalations / samplesDrawn` divides probes by PATTERNS, two different
 * units, and would be a plausible-looking number that means nothing. Coverage
 * lives in a panel below, where its denominator can be stated.
 */
function statsFor(analytics: SiteAnalytics) {
  const [latest, previous] = analytics.health;
  const byStatus = new Map(
    analytics.patternStatus.map((entry) => [entry.status, entry.count] as const)
  );

  const measured = byStatus.get("measured") ?? 0;
  const unmeasured =
    (byStatus.get("blocked") ?? 0) + (byStatus.get("needs_review") ?? 0);

  const trend =
    latest === undefined
      ? undefined
      : trendPercent(latest.httpRequests, previous?.httpRequests);

  return [
    {
      label: "http requests",
      value: formatCount(latest?.httpRequests ?? 0),
      title:
        "Probe requests the most recent run spent. Charged per actual request, so an escalated check counts two — a HEAD plus a GET. Excludes sitemap file downloads.",
      /*
       * Toned `unknown`, not healthy or critical. More requests than last run
       * is not news on its own — a bigger sitemap costs more to sample — so the
       * chip reports the change and lets the reader judge it.
       */
      ...(trend === undefined
        ? {}
        : { chip: { text: formatTrend(trend), tone: "unknown" as const } })
    },
    {
      label: "get escalations",
      value: formatCount(latest?.getEscalations ?? 0),
      title:
        "HEAD checks that had to be re-requested as a capped GET, either to sniff a soft 404 or because the host rejected HEAD."
    },
    {
      label: "patterns measured",
      value: formatCount(measured),
      title: "Patterns the latest run produced an actionable estimate for."
    },
    {
      label: "blocked or needs review",
      value: formatCount(unmeasured),
      title:
        "Patterns carrying no measurement — the host refused us, or the escalation cap was hit and the pattern was flagged rather than probed further. An absence of evidence, not a site defect.",
      /*
       * The card meant to be read first, taking the warning border for the
       * reason ADR-0032 gives: the honest analogue of the design's "Action
       * Req." card, built from a counted figure rather than an estimate.
       */
      ...(unmeasured > 0
        ? {
            chip: { text: "no measurement", tone: "warning" as const },
            emphasis: "warning" as const
          }
        : {})
    }
  ];
}

/** The site chips, matching the Settings screen's selector (ADR-0031). */
function SiteChips({
  selected,
  sites
}: {
  readonly selected: SiteSummary;
  readonly sites: readonly SiteSummary[];
}) {
  return (
    <nav aria-label="Project" className="mt-5 flex flex-wrap gap-2">
      {sites.map((site) => (
        <Link
          aria-current={site.id === selected.id ? "true" : undefined}
          className={
            site.id === selected.id
              ? "rounded-sm border border-accent bg-surface px-3 py-1.5 text-xs font-medium text-accent-text"
              : "rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
          }
          href={`/analytics?site=${site.id}`}
          key={site.id}
        >
          {site.name}
        </Link>
      ))}
    </nav>
  );
}

const WINDOW_COLUMNS = [
  "window end",
  "run",
  "patterns",
  "samples",
  "requests",
  "escalations",
  "low conf.",
  "expanded",
  "blocked",
  "review"
] as const;

export default async function AnalyticsPage({
  searchParams
}: {
  readonly searchParams: Promise<{ readonly site?: string }>;
}) {
  const params = await searchParams;

  let sites: readonly SiteSummary[];

  try {
    ({ sites } = await listSites());
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Analytics" }]} />
        <PageBody>
          <ApiErrorPanel
            message={
              error instanceof ApiError
                ? error.message
                : "Unknown error contacting the API."
            }
          />
        </PageBody>
      </>
    );
  }

  const selected =
    sites.find((site) => site.id === params.site) ?? sites[0] ?? undefined;

  /**
   * ZERO SITES RENDERS NO FIGURES AT ALL, not four cards reading 0.
   *
   * A zero in a KPI card is a measurement, and there is nothing here to have
   * measured — the same section 1.5 indistinguishability that makes a parsed
   * file with no URLs say NO URLS rather than render green and healthy.
   */
  if (selected === undefined) {
    return (
      <>
        <TopBar items={[{ label: "Analytics" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-2 max-w-prose text-sm text-secondary">
            No sites yet — run pnpm seed:demo to create the demo organization.
          </p>
        </PageBody>
      </>
    );
  }

  const crumbs = [
    { label: "Analytics" },
    { label: selected.name, href: `/sites/${selected.id}` }
  ];

  let analytics: SiteAnalytics;

  try {
    analytics = await getSiteAnalytics(selected.id, ANALYTICS_WINDOW_COUNT);
  } catch (error) {
    return (
      <>
        <TopBar items={crumbs} />
        <PageBody>
          <ApiErrorPanel
            message={
              error instanceof ApiError
                ? error.message
                : "Unknown error contacting the API."
            }
          />
        </PageBody>
      </>
    );
  }

  const latest = analytics.health[0];
  const { latestRun, runs } = analytics;

  /*
   * Oldest first, matching `runs`. `health` arrives newest first because that
   * is right for a table; a series drawn from it would run backwards in time
   * while looking entirely plausible.
   */
  const series = [...analytics.health].reverse();

  const discovered = latestRun?.totalUrls ?? 0;

  const coverage =
    latest === undefined
      ? undefined
      : coverageFraction(latest.httpRequests, discovered);

  const runById = new Map(runs.map((run) => [run.id, run] as const));

  /*
   * Patterns that came back with a number, as a share of the patterns the run
   * found. Derived by subtraction from the health row rather than read from
   * `patternStatus`, so both sides of the meter come from the SAME window and
   * cannot disagree — `patternStatus` describes the latest run, which is not
   * necessarily the latest health window if a run is still in flight.
   */
  const measuredPatterns =
    latest === undefined
      ? 0
      : Math.max(
          0,
          latest.patternsTotal -
            latest.patternsBlocked -
            latest.patternsNeedsReview
        );

  return (
    <>
      <TopBar items={crumbs} />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-2 max-w-prose text-sm text-secondary">
          What sampling {selected.host} has cost, and how reliably it has
          measured — one window per finished run.
        </p>

        {sites.length > 1 && <SiteChips selected={selected} sites={sites} />}

        {latest === undefined ? (
          <p className="mt-8 max-w-prose rounded-md border border-border-subtle bg-surface-raised px-5 py-5 text-sm text-secondary">
            No health record yet — these figures are written when a run is
            finalised.
          </p>
        ) : (
          <>
            <div className="mt-6">
              <StatCards stats={statsFor(analytics)} />
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <Panel title="Request cost over recent runs">
                <Sparkline
                  label="Probe requests spent per run, oldest first"
                  points={series.map((window) => ({
                    value: window.httpRequests,
                    title: `${formatCount(window.httpRequests)} requests in the window ending ${formatDateTime(window.windowEnd)}`
                  }))}
                />
                <p className="mt-4 font-mono text-xl tabular-nums" data-numeric>
                  {formatCount(latest.httpRequests)}
                </p>
                <p className="mt-1 font-mono text-2xs uppercase tracking-wider text-tertiary">
                  latest of {series.length}{" "}
                  {series.length === 1 ? "window" : "windows"}
                </p>
                <p className="mt-3 max-w-prose text-xs text-tertiary">
                  Charged per actual request, not per check: an escalated check
                  is a HEAD plus a GET and counts two. A probe that never got a
                  response is charged one and may have cost two, so this is a
                  floor rather than an exact total.
                </p>
              </Panel>

              <Panel title="Pattern outcomes">
                {/*
                  Deliberately identical to the run detail's middle panel. The
                  same fact should look the same on both screens; a second
                  visual language for it would imply a second meaning.
                */}
                <StackedBar
                  label="Patterns by status in the latest run"
                  segments={[...analytics.patternStatus]
                    .sort((a, b) => b.count - a.count)
                    .map((entry) => ({
                      label: entry.status.replace(/_/g, " "),
                      secondary: `${formatCount(entry.populationCount)} URLs`,
                      tone: patternStatusTone(entry.status),
                      value: entry.count
                    }))}
                />
              </Panel>

              <Panel title="Sampling coverage">
                {coverage === undefined ? (
                  <p className="text-sm text-secondary">
                    The latest run discovered no URLs, so there is no coverage
                    to report.
                  </p>
                ) : (
                  <>
                    <p className="font-mono text-xl tabular-nums" data-numeric>
                      {formatCoverage(coverage)}
                    </p>
                    <p className="mt-2 max-w-prose text-xs text-tertiary">
                      Of the URLs the latest run discovered, this share was
                      actually requested. A small number here is the product
                      working, not a shortfall.
                    </p>
                    <div className="mt-5 flex flex-col gap-4">
                      <Meter
                        formatted={`${formatCount(latest.httpRequests)} / ${formatCount(discovered)}`}
                        label="requests vs URLs discovered"
                        max={discovered}
                        value={latest.httpRequests}
                      />
                      {/*
                        BOTH OPERANDS COUNT PATTERNS. The obvious-looking meter
                        here is `samplesDrawn / patternsTotal`, and it is wrong:
                        `samples_drawn` counts DRAWS, and an expanded pattern
                        contributes two, so the ratio exceeded 1 and rendered a
                        113% bar reading "9 / 8" the moment the demo grew a
                        round-2 draw. That is the same units error the KPI
                        comment above rejects for escalation share — caught here
                        only because the bar overflowed its track visibly.
                      */}
                      <Meter
                        formatted={`${formatCount(measuredPatterns)} / ${formatCount(latest.patternsTotal)}`}
                        label="patterns carrying a measurement"
                        max={latest.patternsTotal}
                        tone="muted"
                        value={measuredPatterns}
                      />
                    </div>
                  </>
                )}
              </Panel>
            </div>

            {/*
              A SECOND WIDGET ROW OF TWO, permitted by DESIGN.md section 7.2 and
              capped there at what earns its place. A third would be filling
              space: the two below answer questions a reader actually brings —
              "is the sampling producing usable numbers?" and "does this site's
              audit finish?" — and nothing else here does.
            */}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <Panel title="Patterns at low confidence, per run">
                <BarChart
                  bars={series.map((window) => ({
                    label: formatDateTime(window.windowEnd).slice(5, 10),
                    title: `${window.patternsLowConfidence} of ${window.patternsTotal} patterns at low confidence in the window ending ${formatDateTime(window.windowEnd)}`,
                    value: window.patternsLowConfidence
                  }))}
                  caption={`A rising share is a paging signal, not a cosmetic one: a site whose patterns are mostly low-confidence is producing numbers nobody should act on. Drawn against ${formatCount(latest.patternsTotal)} patterns, not against the tallest bar — otherwise an unchanging count fills every column and reads as "all of them".`}
                  label="Low-confidence patterns per run, oldest first"
                  reference={latest.patternsTotal}
                />
              </Panel>

              <Panel title="Run outcomes">
                <Donut
                  centreLabel={runs.length === 1 ? "run" : "runs"}
                  centreValue={formatCount(runs.length)}
                  label="How this site's recent runs ended"
                  segments={runStatusSlices(runs).map((slice) => ({
                    label: slice.label.replace(/_/g, " "),
                    tone: runStatusTone(slice.label),
                    value: slice.value
                  }))}
                />
                <p className="mt-4 max-w-prose text-xs text-tertiary">
                  A degraded run finished but said so — its numbers are real and
                  incomplete, which is why it is not folded in with the ones
                  that completed cleanly.
                </p>
              </Panel>
            </div>

            <h2 className="mt-10 text-lg font-semibold tracking-tight">
              Sampling health
            </h2>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              The latest window in full.
            </p>
            <div className="mt-4">
              <SamplingHealthGrid health={latest} />
            </div>

            <h2 className="mt-10 text-lg font-semibold tracking-tight">
              Health windows
            </h2>
            <div className="mt-4 overflow-x-auto rounded-md border border-border-subtle bg-surface-raised">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <caption className="sr-only">
                  One row per finished run, newest first, carrying that
                  run&apos;s sampling cost and confidence profile.
                </caption>
                <thead>
                  <tr className="border-b border-border-strong">
                    {WINDOW_COLUMNS.map((heading, index) => (
                      <th
                        className={`px-4 py-2 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary ${index > 1 ? "text-right" : ""}`}
                        key={heading}
                        scope="col"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.health.map((window) => {
                    const run =
                      window.sitemapRunId === null
                        ? undefined
                        : runById.get(window.sitemapRunId);

                    return (
                      <tr
                        className="border-b border-border-subtle transition-colors last:border-b-0 hover:bg-surface"
                        key={window.id}
                        style={
                          run === undefined
                            ? undefined
                            : rowAccentStyle(runStatusTone(run.status))
                        }
                      >
                        <td className="px-4 py-2 font-mono text-xs text-secondary">
                          {formatDateTime(window.windowEnd)}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs">
                          {window.sitemapRunId === null ? (
                            /*
                             * `sitemap_run_id` is nullable for the cross-run
                             * rollup the schema anticipates. Labelled rather
                             * than linked, because there is no one run to open.
                             */
                            <span className="text-tertiary">rollup</span>
                          ) : (
                            <Link
                              className="text-accent-text hover:underline"
                              href={`/runs/${window.sitemapRunId}`}
                            >
                              {run === undefined ? (
                                "open"
                              ) : (
                                <StatusBadge
                                  label={run.status}
                                  tone={runStatusTone(run.status)}
                                />
                              )}
                            </Link>
                          )}
                        </td>
                        {[
                          window.patternsTotal,
                          window.samplesDrawn,
                          window.httpRequests,
                          window.getEscalations,
                          window.patternsLowConfidence,
                          window.patternsExpanded,
                          window.patternsBlocked,
                          window.patternsNeedsReview
                        ].map((value, index) => (
                          <td
                            className="px-4 py-2 text-right font-mono text-xs tabular-nums"
                            data-numeric
                            key={WINDOW_COLUMNS[index + 2]}
                          >
                            {formatCount(value)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 font-mono text-2xs uppercase tracking-wider text-tertiary">
              {/*
                The cap is stated rather than implied. A page of 30 presented as
                the whole history is the D3a failure both fleet screens had.
              */}
              showing {analytics.health.length} of the last{" "}
              {analytics.windowLimit} windows
            </p>
          </>
        )}
      </PageBody>
    </>
  );
}
