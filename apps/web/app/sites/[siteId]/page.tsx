import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../components/api-error";
import { PageBody, TopBar } from "../../../components/app-shell";
import {
  Estimate,
  estimateFromSnapshot,
  impactFromSnapshot
} from "../../../components/estimate";
import { SamplingHealthGrid } from "../../../components/sampling-health";
import { StatCards } from "../../../components/stat-cards";
import { StatusBadge } from "../../../components/status-badge";
import {
  ApiError,
  getSite,
  listPatterns,
  type PatternSummary,
  type SiteDetail
} from "../../../lib/api";
import { formatCount, formatDateTime } from "../../../lib/format";
import {
  patternStatusTone,
  rowAccentStyle,
  runStatusTone,
  severityTone
} from "../../../lib/status";

export const dynamic = "force-dynamic";

/**
 * The latest run's counted figures.
 *
 * Sampling health USED to be squeezed in here as two of its nine numbers — low
 * confidence and blocked — which is how the other seven stayed invisible while
 * the API sent them on every request. They now have their own section, so this
 * strip is the run's counts and nothing else.
 */
function statsFor(detail: SiteDetail) {
  const { latestRun } = detail;

  if (!latestRun) {
    return [];
  }

  return [
    { label: "urls", value: formatCount(latestRun.totalUrls) },
    { label: "patterns", value: formatCount(latestRun.totalPatterns) },
    {
      label: "files parsed",
      value: `${formatCount(latestRun.parsedFiles)}/${formatCount(latestRun.totalFiles)}`
    }
  ];
}

export default async function SiteDetailPage({
  params
}: {
  readonly params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;

  let detail: SiteDetail;

  try {
    detail = await getSite(siteId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound();
    }

    return (
      <>
        <TopBar items={[{ label: "Sites", href: "/" }]} />
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

  let patterns: readonly PatternSummary[] = [];
  let noCompletedRun = false;
  let patternsError: string | undefined;

  try {
    ({ patterns } = await listPatterns(siteId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      noCompletedRun = true;
    } else {
      patternsError =
        error instanceof ApiError
          ? error.message
          : "Unknown error contacting the API.";
    }
  }

  return (
    <>
      <TopBar
        items={[{ label: "Sites", href: "/" }, { label: detail.site.name }]}
      />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">
          {detail.site.name}
        </h1>
        <p className="mt-1 font-mono text-xs text-secondary">
          {detail.site.host}
        </p>
        {/*
          The Stitch design reaches Project Settings from a project, so the
          project has to offer the way in.
        */}
        <p className="mt-3 text-xs">
          <Link
            className="text-secondary hover:text-accent-text hover:underline"
            href={`/settings?site=${siteId}`}
          >
            Project settings →
          </Link>
        </p>

        {detail.latestRun ? (
          <div className="mt-8">
            {/*
            The run's state is a BADGE, not a stat-strip value. The strip is
            mono and tabular-nums for numerals; a word rendered in that slot
            reads as a number that failed to load, and it carried no tone, so
            "failed" and "complete" looked identical.
          */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={runStatusTone(detail.latestRun.status)}
                label={detail.latestRun.status}
              />
              {detail.latestRun.isDryRun && (
                <StatusBadge tone="unknown" label="dry run" />
              )}
              {detail.latestRun.statusReason && (
                /*
                A degraded run has to say why on the screen. The reason is
                machine-readable from the finalize stage, so it is shown as
                written rather than mapped to prose that could drift from it.
              */
                <span className="font-mono text-2xs uppercase tracking-wider text-tertiary">
                  {detail.latestRun.statusReason.replace(/_/g, " ")}
                </span>
              )}
            </div>
            <StatCards stats={statsFor(detail)} />
            {/*
              The run this page's figures came from, linked. The run detail is
              where the files it read and its per-status pattern counts live —
              without this the only way in was the fleet Runs table.
            */}
            <p className="mt-3 text-xs text-secondary">
              <Link
                href={`/runs/${detail.latestRun.id}`}
                className="hover:text-accent-text hover:underline"
              >
                View this run&apos;s files and pattern breakdown →
              </Link>
            </p>
          </div>
        ) : (
          <p className="mt-8 text-sm text-secondary">
            This site has no sitemap run yet.
          </p>
        )}

        {detail.samplingHealth && (
          <>
            <h2 className="mt-12 text-lg font-semibold tracking-tight">
              Sampling health
            </h2>
            <p className="mt-1 max-w-prose text-sm text-secondary">
              What the latest run cost and how much of it came back measurable.
              A platform that audits a 90M-URL site without requesting 90M URLs
              has to be able to show the requests it did make.
            </p>
            <div className="mt-4">
              <SamplingHealthGrid health={detail.samplingHealth} />
            </div>
          </>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">Findings</h2>
        <p className="mt-1 max-w-prose text-sm text-secondary">
          This site&apos;s published findings, worst first — ranked on impact,
          the point estimate weighted by severity, never on how wide an interval
          is.
        </p>

        {detail.findings.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">
            No findings published for this site yet. They appear once a run has
            been sampled and verified.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">
                Published findings for {detail.site.name}, worst first
              </caption>
              <thead>
                <tr className="border-b border-border-strong text-left">
                  <th
                    scope="col"
                    className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Pattern
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Severity
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    HTTP
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Affected
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Impact
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Computed
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.findings.map((finding) => {
                  const findingTone = severityTone(finding.severityClass);

                  return (
                    <tr
                      key={finding.id}
                      className="border-b border-border-subtle transition-colors hover:bg-surface"
                      style={rowAccentStyle(findingTone)}
                    >
                      <th
                        scope="row"
                        className="py-3 pr-4 pl-3 text-left font-normal"
                      >
                        <Link
                          href={`/sites/${siteId}/patterns/${finding.patternId}`}
                          className="font-mono text-xs hover:text-accent-text hover:underline"
                        >
                          {finding.patternTemplate}
                        </Link>
                      </th>
                      <td className="py-3 pr-4">
                        <StatusBadge
                          tone={findingTone}
                          label={finding.severityClass}
                        />
                      </td>
                      <td
                        className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                        data-numeric
                      >
                        {finding.httpStatus}
                      </td>
                      <td className="py-3 pr-4 text-right">
                        <Estimate {...estimateFromSnapshot(finding)} />
                      </td>
                      <td className="py-3 pr-4 text-right">
                        {/*
                          Through <Estimate>, like every other sampled figure.
                          Impact is point_estimate x severity_weight, so it is
                          exactly as estimated as the count it weights and
                          ADR-0008 does not exempt it.
                        */}
                        <Estimate {...impactFromSnapshot(finding)} />
                      </td>
                      <td
                        className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                        data-numeric
                      >
                        {formatDateTime(finding.computedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-12 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Patterns</h2>
          {/*
            The triage view over the same rows.
            
            This table is a flat list ordered by population; Pattern
            Intelligence ranks the run by impact, filters by status and pages,
            and is where the affected-URL estimate per pattern lives. Linked
            rather than folded in, because a site overview answering "what is
            here" and a triage screen answering "what should I fix first" are
            two questions.
          */}
          <Link
            className="font-mono text-2xs uppercase tracking-wider text-accent-text hover:underline"
            href={`/sites/${siteId}/patterns`}
          >
            Pattern intelligence &rarr;
          </Link>
        </div>

        {patternsError && (
          <div className="mt-4">
            <ApiErrorPanel message={patternsError} />
          </div>
        )}

        {noCompletedRun && !patternsError && (
          <p className="mt-4 text-sm text-secondary">
            No completed run yet — patterns appear here once a sitemap run for
            this site finishes.
          </p>
        )}

        {!noCompletedRun && !patternsError && patterns.length === 0 && (
          <p className="mt-4 text-sm text-secondary">
            The latest run found no patterns.
          </p>
        )}

        {patterns.length > 0 && (
          <table className="mt-4 w-full border-collapse text-sm">
            <caption className="sr-only">
              Patterns for {detail.site.name}
            </caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th
                  scope="col"
                  className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Template
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Population
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Files
                </th>
                <th
                  scope="col"
                  className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Updated
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
                    <th
                      scope="row"
                      className="py-3 pr-4 pl-3 text-left font-normal"
                    >
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
                    <td
                      className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                    >
                      {formatCount(pattern.populationCount)}
                    </td>
                    <td
                      className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                    >
                      {formatCount(pattern.fileCount)}
                    </td>
                    <td
                      className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                    >
                      {formatDateTime(pattern.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </PageBody>
    </>
  );
}
