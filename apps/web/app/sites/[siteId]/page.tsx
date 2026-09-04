import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../components/api-error";
import { PageBody, TopBar } from "../../../components/app-shell";
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
  runStatusTone
} from "../../../lib/status";

export const dynamic = "force-dynamic";

function statsFor(detail: SiteDetail) {
  const { latestRun, samplingHealth } = detail;

  if (!latestRun) {
    return [];
  }

  const stats = [
    { label: "urls", value: formatCount(latestRun.totalUrls) },
    { label: "patterns", value: formatCount(latestRun.totalPatterns) },
    {
      label: "files parsed",
      value: `${formatCount(latestRun.parsedFiles)}/${formatCount(latestRun.totalFiles)}`
    }
  ];

  if (samplingHealth) {
    stats.push(
      {
        label: "low confidence",
        value: formatCount(samplingHealth.patternsLowConfidence)
      },
      { label: "blocked", value: formatCount(samplingHealth.patternsBlocked) }
    );
  }

  return stats;
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
          </div>
        ) : (
          <p className="mt-8 text-sm text-secondary">
            This site has no sitemap run yet.
          </p>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">Patterns</h2>

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
