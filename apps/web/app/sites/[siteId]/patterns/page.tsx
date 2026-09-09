import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../../components/api-error";
import { PageBody, TopBar } from "../../../../components/app-shell";
import {
  Estimate,
  estimateFromSnapshot,
  impactFromSnapshot
} from "../../../../components/estimate";
import { Meter } from "../../../../components/meter";
import { Pagination } from "../../../../components/pagination";
import { Panel } from "../../../../components/panel";
import { StackedBar } from "../../../../components/stacked-bar";
import { StatCards } from "../../../../components/stat-cards";
import { StatusBadge } from "../../../../components/status-badge";
import { FilterPills, StatusStrip } from "../../../../components/toolbar";
import {
  ApiError,
  getSite,
  listPatterns,
  type PatternRankSummary,
  type PatternSort,
  type PatternStatus,
  type PatternsPage
} from "../../../../lib/api";
import { formatCount } from "../../../../lib/format";
import { pageWindow } from "../../../../lib/projects";
import { coverageFraction, formatCoverage } from "../../../../lib/run-analysis";
import {
  httpStatusTone,
  patternStatusTone,
  rowAccentStyle,
  severityTone
} from "../../../../lib/status";

export const dynamic = "force-dynamic";

/**
 * Pattern Intelligence — the ranked triage view over a run's patterns.
 *
 * COMPOSITION TAKEN FROM THE STITCH "Sitemap Analyzer" SCREEN
 * (`screen source/sitemap_analyzer/`), which is the design's population screen
 * and the closest one in subject: a meta strip and header action, four KPI
 * cards, a segmented health bar with a counted legend, then a table. Its
 * FIGURES are refused where this platform cannot produce them, which is
 * DESIGN.md section 7.1's rule — the structure is the design's, the contents
 * are the product's — and is why this screen needs no "provisional" marking the
 * way an invented composition would (ADR-0031).
 *
 * Three of the design's figures are deliberately absent:
 *
 * - "Indexability 94%". Nothing here measures index state — no robots.txt
 *   fetch, no meta-robots parse, no Search Console. A number would have to be
 *   invented, and it would be the most confident-looking figure on the page.
 * - "URLs Submitted" beside "URLs Discovered". That pair is a Search Console
 *   distinction; this platform has one number, so it shows one.
 * - A run-wide "estimated affected URLs" card. Summing intervals across
 *   patterns is a statistical choice this screen does not make, and summing
 *   only the visible page would be the D3a defect — a card describing the page
 *   while labelled as the run. The estimate stays per row, where its interval
 *   belongs.
 *
 * Everything sampled goes through `<Estimate>` (ADR-0008). Nothing on this page
 * formats an estimate itself; `lib/adr-0008-guard.test.ts` fails the build if it
 * ever does.
 */

const PAGE_SIZE = 25;

const STATUS_FILTERS: readonly {
  readonly label: string;
  readonly value: PatternStatus | undefined;
}[] = [
  { label: "All", value: undefined },
  { label: "Measured", value: "measured" },
  { label: "Needs review", value: "needs_review" },
  { label: "Blocked", value: "blocked" },
  { label: "Unsampled", value: "unsampled" }
];

function isStatus(value: string | undefined): value is PatternStatus {
  return STATUS_FILTERS.some(
    (filter) => filter.value !== undefined && filter.value === value
  );
}

function linkTo(
  siteId: string,
  next: {
    readonly sort: PatternSort;
    readonly status?: PatternStatus | undefined;
    readonly page?: number;
  }
): string {
  const query = new URLSearchParams();

  if (next.sort !== "population") {
    query.set("sort", next.sort);
  }

  if (next.status) {
    query.set("status", next.status);
  }

  if (next.page && next.page > 1) {
    query.set("page", String(next.page));
  }

  const suffix = query.size > 0 ? `?${query.toString()}` : "";

  return `/sites/${siteId}/patterns${suffix}`;
}

/**
 * The run's pattern mix as a segmented bar, per the design's health overview.
 *
 * Population travels as the secondary figure because the two tell different
 * stories: twelve blocked patterns is unremarkable until they hold nine
 * million URLs.
 */
function statusSegments(page: PatternsPage) {
  return page.statusCounts
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      label: entry.status.replace(/_/g, " "),
      value: entry.count,
      tone: patternStatusTone(entry.status),
      secondary: `${formatCount(entry.populationCount)} URLs`
    }));
}

/**
 * The counted cards that frame the screen. A sampled figure never goes here.
 *
 * THE CARDS DESCRIBE THE RUN, NOT THE FILTER, and the filter governs the table
 * and its footer instead. This row cannot coherently do otherwise: `urls
 * discovered` and `urls sampled` are run-level facts with no per-status
 * subdivision, so filtering only the pattern count produced a card row that
 * contradicted itself — "PATTERNS 0" beside a status panel listing eight and a
 * "needing attention 2" computed from the unfiltered counts. Caught by
 * screenshotting the empty-filter state.
 *
 * This is not a licence to sum the visible page. DESIGN.md section 7.4 bans a
 * card that counts the ROWS IT CAN SEE and labels it the whole; `patternsInRun`
 * comes from `statusCounts`, which the API computes over the entire run.
 */
function statsFor(
  page: PatternsPage,
  patternsInRun: number,
  needsAttention: number
) {
  const coverage = coverageFraction(page.observedUrls, page.totalUrls);

  return [
    {
      label: "urls discovered",
      value: formatCount(page.totalUrls),
      title:
        "Discovered from this site's sitemaps. Not requested — the sampler probes a fraction of these on purpose."
    },
    { label: "patterns", value: formatCount(patternsInRun) },
    {
      label: "urls sampled",
      value: formatCount(page.observedUrls),
      ...(coverage === undefined
        ? {}
        : {
            chip: {
              text: `${formatCoverage(coverage)} of population`,
              tone: "healthy" as const
            }
          }),
      title:
        "URLs this run actually requested. A small share here is the product working, not a shortfall."
    },
    {
      label: "patterns needing attention",
      value: formatCount(needsAttention),
      /*
       * The honest analogue of the design's "Action Req." card. Blocked and
       * needs-review are absences of measurement, so this is a warning rather
       * than a critical — nothing here says the site is broken.
       */
      ...(needsAttention > 0 ? { emphasis: "warning" as const } : {}),
      title:
        "Patterns whose host refused us or whose sample needs a human look. Not site defects — missing measurements."
    }
  ];
}

export default async function PatternIntelligencePage({
  params,
  searchParams
}: {
  readonly params: Promise<{ siteId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { siteId } = await params;
  const query = await searchParams;

  const rawSort = typeof query.sort === "string" ? query.sort : undefined;
  const sort: PatternSort = rawSort === "impact" ? "impact" : "population";
  const rawStatus = typeof query.status === "string" ? query.status : undefined;
  const status = isStatus(rawStatus) ? rawStatus : undefined;
  const pageNumber = Math.max(
    1,
    Number.parseInt(typeof query.page === "string" ? query.page : "1", 10) || 1
  );
  const offset = (pageNumber - 1) * PAGE_SIZE;

  let detail: Awaited<ReturnType<typeof getSite>>;

  try {
    detail = await getSite(siteId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }

    throw error;
  }

  let page: PatternsPage | undefined;
  let concentration: readonly PatternRankSummary[] = [];
  let loadError: string | undefined;

  try {
    page = await listPatterns(siteId, {
      sort,
      ...(status ? { status } : {}),
      limit: PAGE_SIZE,
      offset
    });

    /**
     * A SECOND, SMALL CALL for the concentration panel, on purpose.
     *
     * "Which patterns hold the most URLs" is a different question from "what is
     * on this page", and answering it from the page would silently change its
     * answer whenever the reader sorted by impact or turned to page two — a
     * panel whose meaning depends on a control that does not appear to govern
     * it. Population order and a fixed five, always.
     */
    concentration = (
      await listPatterns(siteId, { sort: "population", limit: 5 })
    ).patterns;
  } catch (error) {
    loadError =
      error instanceof ApiError
        ? error.message
        : "The pattern list could not be loaded.";
  }

  /** Every pattern in the run, filter or no filter — see `statsFor`. */
  const patternsInRun =
    page?.statusCounts.reduce((total, entry) => total + entry.count, 0) ?? 0;

  const needsAttention =
    page?.statusCounts.reduce(
      (total, entry) =>
        entry.status === "blocked" || entry.status === "needs_review"
          ? total + entry.count
          : total,
      0
    ) ?? 0;

  const largest = concentration[0]?.populationCount ?? 0;
  const window = pageWindow(
    pageNumber,
    PAGE_SIZE,
    page?.patterns.length ?? 0,
    page?.total ?? 0
  );

  return (
    <>
      <TopBar
        items={[
          { label: "Overview", href: "/" },
          { label: detail.site.name, href: `/sites/${siteId}` },
          { label: "Patterns" }
        ]}
      />

      <PageBody>
        <p className="font-mono text-2xs uppercase tracking-wider text-tertiary">
          Pattern intelligence · {detail.site.host} · sampled, never fully
          crawled
        </p>

        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          Pattern Intelligence
        </h1>

        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-secondary">
          Every URL this run discovered, collapsed into patterns and ranked for
          triage. A pattern&rsquo;s affected-URL count is{" "}
          <strong className="font-medium text-primary">estimated</strong> from
          the sample the verifier actually probed, so it carries an interval;
          population and probe counts are counted.{" "}
          <strong className="font-medium text-primary">Impact</strong> is that
          same count weighted by each finding&rsquo;s severity, and is what the
          ranking uses. There is no index-coverage or health score here —
          nothing in this platform measures index state.
        </p>

        {loadError && (
          <div className="mt-6">
            <ApiErrorPanel message={loadError} />
          </div>
        )}

        {page && page.sitemapRunId === null && (
          <p className="mt-6 text-sm text-secondary">
            No completed run yet — patterns appear here once a sitemap run for{" "}
            {detail.site.name} finishes.
          </p>
        )}

        {page && page.sitemapRunId !== null && (
          <>
            <div className="mt-6">
              <StatCards
                stats={statsFor(page, patternsInRun, needsAttention)}
              />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <Panel title="Pattern status">
                {statusSegments(page).length > 0 ? (
                  <StackedBar
                    segments={statusSegments(page)}
                    label="Patterns by measurement status"
                  />
                ) : (
                  <p className="text-sm text-secondary">
                    This run recorded no patterns.
                  </p>
                )}
              </Panel>

              <Panel title="Population concentration">
                {concentration.length > 0 ? (
                  <ul className="flex flex-col gap-3">
                    {concentration.map((pattern) => (
                      <li key={pattern.id}>
                        <Meter
                          label={pattern.template}
                          value={pattern.populationCount}
                          max={largest}
                          formatted={formatCount(pattern.populationCount)}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-secondary">No patterns to rank.</p>
                )}
              </Panel>

              <Panel title="Sampling coverage">
                <SamplingCoverage page={page} />
              </Panel>
            </div>

            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <FilterPills
                label="Filter patterns by measurement status"
                items={STATUS_FILTERS.map((filter) => ({
                  label: filter.label,
                  href: linkTo(siteId, { sort, status: filter.value }),
                  current: filter.value === status
                }))}
              />

              <FilterPills
                label="Sort patterns"
                items={[
                  {
                    label: "By population",
                    href: linkTo(siteId, { sort: "population", status }),
                    current: sort === "population"
                  },
                  {
                    label: "By impact",
                    href: linkTo(siteId, { sort: "impact", status }),
                    current: sort === "impact"
                  }
                ]}
              />
            </div>

            {page.patterns.length === 0 ? (
              <p className="mt-6 text-sm text-secondary">
                {status ? (
                  <>
                    No patterns match this filter.{" "}
                    <Link
                      className="text-accent-text hover:underline"
                      href={linkTo(siteId, { sort })}
                    >
                      Clear it
                    </Link>{" "}
                    to see every pattern in the run.
                  </>
                ) : (
                  "This run recorded no patterns."
                )}
              </p>
            ) : (
              <PatternTable patterns={page.patterns} siteId={siteId} />
            )}

            <div className="mt-4">
              <Pagination
                window={window}
                /*
                 * The noun names what it actually counts. Unfiltered, that is
                 * the run; filtered, it is the matching subset, and saying "in
                 * this run" there would describe a different collection from
                 * the one the rows came from.
                 */
                noun={
                  status
                    ? "patterns matching this filter"
                    : "patterns in this run"
                }
                href={(next) => linkTo(siteId, { sort, status, page: next })}
              />
            </div>

            <div className="mt-8">
              <StatusStrip
                facts={[
                  `Run ${page.sitemapRunId.slice(0, 8)}`,
                  `${formatCount(page.observedUrls)} of ${formatCount(page.totalUrls)} URLs requested`,
                  "Affected counts are estimates and carry intervals"
                ]}
              />
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}

/**
 * The ratio this product exists to justify.
 *
 * A small number here is the platform working, not a shortfall, and the caption
 * says so — a reader who does not already know that reads 2.4% as a failure.
 */
function SamplingCoverage({ page }: { readonly page: PatternsPage }) {
  const coverage = coverageFraction(page.observedUrls, page.totalUrls);

  if (coverage === undefined) {
    return (
      <p className="text-sm text-secondary">
        This run discovered no URLs, so there is no coverage to report.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xl tabular-nums" data-numeric>
        {formatCoverage(coverage)}
      </p>
      <Meter
        label="requests vs URLs discovered"
        value={page.observedUrls}
        max={page.totalUrls}
        formatted={formatCount(page.observedUrls)}
      />
      <p className="text-sm leading-relaxed text-secondary">
        The other {formatCount(page.totalUrls - page.observedUrls)} URLs were
        never requested, which is the point — the estimates below are drawn from
        the {formatCount(page.observedUrls)} that were.
      </p>
    </div>
  );
}

const HEADER =
  "py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary";
const NUMERIC =
  "py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary";

function PatternTable({
  patterns,
  siteId
}: {
  readonly patterns: readonly PatternRankSummary[];
  readonly siteId: string;
}) {
  return (
    <table className="mt-4 w-full border-collapse text-sm">
      <caption className="sr-only">
        Patterns ranked for triage. Affected and impact are estimated from a
        sample and carry intervals.
      </caption>
      <thead>
        <tr className="border-b border-border-strong text-left">
          <th scope="col" className={`${HEADER} pl-3`}>
            Pattern
          </th>
          <th scope="col" className={HEADER}>
            Status
          </th>
          <th scope="col" className={`${HEADER} text-right`}>
            Population
          </th>
          <th scope="col" className={`${HEADER} text-right`}>
            Sampled
          </th>
          <th scope="col" className={HEADER}>
            Worst finding
          </th>
          <th
            scope="col"
            className={`${HEADER} text-right`}
            title="URLs estimated affected by this pattern's findings. Healthy URLs are not counted."
          >
            Affected
          </th>
          <th
            scope="col"
            className={`${HEADER} text-right`}
            title="Affected URLs weighted by each finding's severity, for ranking. Lower than Affected wherever a finding is less severe than a gone page."
          >
            Impact
          </th>
        </tr>
      </thead>
      <tbody>
        {patterns.map((pattern) => {
          const tone = patternStatusTone(pattern.status);

          return (
            <tr
              key={pattern.id}
              className="border-b border-border-subtle transition-colors hover:bg-surface"
              style={rowAccentStyle(tone)}
            >
              <th scope="row" className="py-3 pr-4 pl-3 text-left font-normal">
                <Link
                  href={`/sites/${siteId}/patterns/${pattern.id}`}
                  className="font-mono text-xs hover:text-accent-text hover:underline"
                >
                  {pattern.template}
                </Link>
              </th>
              <td className="py-3 pr-4">
                <StatusBadge tone={tone} label={pattern.status} />
              </td>
              <td className={NUMERIC} data-numeric>
                {formatCount(pattern.populationCount)}
              </td>
              <td className={NUMERIC} data-numeric>
                {/*
                  The n behind the estimate. A pattern with no published finding
                  has no sample to report, and an em dash says that rather than
                  a zero, which would read as "we probed nothing and found
                  nothing" — a measurement nobody made.
                */}
                {pattern.impact ? formatCount(pattern.impact.sampleSize) : "—"}
              </td>
              <td className="py-3 pr-4">
                <WorstFinding pattern={pattern} />
              </td>
              <td className="py-3 pr-4 text-right">
                <PatternFigure pattern={pattern} of="affected" />
              </td>
              <td className="py-3 text-right">
                <PatternFigure pattern={pattern} of="impact" />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The status a reader acts on, beside the class that explains it.
 *
 * THE TONE COMES FROM THE SEVERITY CLASS, and the number and the badge take the
 * same one. They describe a single finding, so two tones in one cell would let
 * a green number sit beside a red badge with nothing to say which to believe.
 *
 * Caught by driving the real seeded data: one pattern is `soft_not_found` at
 * HTTP **200** and another is `ok` at 200. A soft 404 answers 200 while being a
 * "not found" — exactly what the capped GET escalation exists to detect — so
 * colouring by the status code alone paints it the same healthy green as a
 * working page and reports a broken pattern as fine. No test had failed.
 *
 * `httpStatusTone` was the first fix and is the WRONG mapper here: it answers
 * "what did the wire say", which is the question the run explorer's raw
 * observations ask, and it scores a soft 404 `critical`. `severityTone` answers
 * "how bad is this finding" and scores the same class `warning` — a deliberate
 * product judgement that a soft 404 ranks below a hard 404 or a 500. The two
 * disagree BY DESIGN because they answer different questions, and a row that
 * carries a severity class must use the mapper that owns it. `httpStatusTone`
 * is kept only for the case with no class at all.
 */
function WorstFinding({ pattern }: { readonly pattern: PatternRankSummary }) {
  if (pattern.worstHttpStatus === undefined) {
    return (
      <span className="font-mono text-2xs uppercase tracking-wider text-tertiary">
        {pattern.findingCount === 0 ? "no findings" : "no defect"}
      </span>
    );
  }

  const tone = pattern.worstSeverityClass
    ? severityTone(pattern.worstSeverityClass)
    : httpStatusTone(pattern.worstHttpStatus);

  return (
    <span className="flex items-center gap-2">
      <span
        className="font-mono text-xs tabular-nums"
        data-numeric
        style={{ color: `var(--status-${tone})` }}
        title={
          pattern.worstSeverityClass === "soft_not_found"
            ? "Answers HTTP 200 but is a 'not found' page — a soft 404, which is what the GET escalation exists to detect."
            : undefined
        }
      >
        {pattern.worstHttpStatus}
      </span>
      {pattern.worstSeverityClass && (
        <StatusBadge tone={tone} label={pattern.worstSeverityClass} />
      )}
    </span>
  );
}

/**
 * A pattern's rolled-up figure, as the estimate it is.
 *
 * TWO COLUMNS, ONE ROLLUP. `affected` is the URL count summed across the
 * pattern's findings; `impact` is the same sum weighted by each finding's
 * stored severity. They coincide only when every weight is 1.0, and showing
 * just the second would answer the ranking question while leaving the reader's
 * question — how many URLs is this — unanswered.
 *
 * Both go through the ADR-0008 adapters, which is why the API ships the rollup
 * shaped like a measurement: no third code path can format one of these.
 *
 * Three states, kept apart. Nothing published, published-but-every-finding-an-
 * absence-of-evidence, and measured-at-zero all render as "0" unless this says
 * otherwise — and the middle collapsing into the last reports a host refusing
 * us as a clean bill of health (CODING_STANDARDS section 1.5).
 */
function PatternFigure({
  pattern,
  of
}: {
  readonly pattern: PatternRankSummary;
  readonly of: "affected" | "impact";
}) {
  if (!pattern.impact) {
    return (
      <span
        className="font-mono text-2xs uppercase tracking-wider text-tertiary"
        title="No claim has been published for this pattern — it has not been sampled, or its sample produced no finding."
      >
        not measured
      </span>
    );
  }

  return (
    <Estimate
      {...(of === "affected"
        ? estimateFromSnapshot(pattern.impact)
        : impactFromSnapshot(pattern.impact))}
    />
  );
}
