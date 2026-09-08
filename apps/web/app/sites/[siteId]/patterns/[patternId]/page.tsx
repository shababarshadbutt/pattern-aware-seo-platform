import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../../../components/api-error";
import { PageBody, TopBar } from "../../../../../components/app-shell";
import { DefinitionGrid } from "../../../../../components/definition-grid";
import {
  Estimate,
  estimateFromSnapshot,
  impactFromSnapshot
} from "../../../../../components/estimate";
import { StatCards } from "../../../../../components/stat-cards";
import { StatusBadge } from "../../../../../components/status-badge";
import { ApiError, getPattern, getSite } from "../../../../../lib/api";
import { formatCount, formatDateTime } from "../../../../../lib/format";
import {
  patternStatusTone,
  rowAccentStyle,
  severityTone
} from "../../../../../lib/status";

export const dynamic = "force-dynamic";

export default async function PatternDetailPage({
  params
}: {
  readonly params: Promise<{ siteId: string; patternId: string }>;
}) {
  const { siteId, patternId } = await params;

  // Two independent reads, not a joined one: the API doesn't have a
  // "pattern with its parent site" endpoint, and the pattern is the page's
  // real subject — the site fetch exists only to label the breadcrumb, so a
  // failure there degrades to a plain siteId rather than blocking the page.
  const [patternResult, siteResult] = await Promise.allSettled([
    getPattern(siteId, patternId),
    getSite(siteId)
  ]);

  if (patternResult.status === "rejected") {
    const error = patternResult.reason;

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

  const {
    pattern,
    latestSample,
    findings,
    observations,
    files,
    populationFromFiles,
    observedCount
  } = patternResult.value;
  const siteName =
    siteResult.status === "fulfilled" ? siteResult.value.site.name : siteId;
  const tone = patternStatusTone(pattern.status);

  /*
   * The two population figures, compared rather than picked between.
   *
   * `pattern.populationCount` is written by the ingest pass; the per-file rows
   * are written as each file is parsed. They are the same quantity by two
   * routes, so a mismatch is not a rounding difference — it means a file was
   * parsed twice or not at all. That is the M6 hazard where a crash between an
   * in-memory accumulation and its single end-of-run write leaves a run
   * finishing "clean" with a permanently short population, and it is invisible
   * unless a screen puts the two numbers next to each other.
   */
  const populationDisagrees =
    files.length > 0 && populationFromFiles !== pattern.populationCount;

  return (
    <>
      <TopBar
        items={[
          { label: "Sites", href: "/" },
          { label: siteName, href: `/sites/${siteId}` },
          { label: pattern.template, mono: true }
        ]}
      />
      <PageBody>
        <h1 className="font-mono text-xl font-semibold tracking-tight break-all">
          {pattern.template}
        </h1>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <StatusBadge tone={tone} label={pattern.status} />
          {pattern.statusReason && (
            <span className="text-xs text-secondary">
              {pattern.statusReason}
            </span>
          )}
        </div>

        {/*
        <StatStrip>, not a second copy of it. This markup was duplicated
        inline — same dividers, same mono 2xl numerals — so a change to the
        strip's treatment would have landed on the site page and silently
        missed this one.
      */}
        <div className="mt-8">
          <StatCards
            stats={[
              {
                label: "population",
                value: formatCount(pattern.populationCount)
              },
              { label: "segments", value: formatCount(pattern.segmentCount) },
              { label: "files", value: formatCount(pattern.fileCount) }
            ]}
          />
        </div>

        {populationDisagrees && (
          <p className="mt-4 max-w-prose text-xs text-warning">
            This pattern records {formatCount(pattern.populationCount)} URLs
            while its per-file rows sum to {formatCount(populationFromFiles)}.
            The two are written by different steps, so a disagreement means a
            file was parsed twice or not at all — treat this pattern&apos;s
            population, and every estimate scaled by it, as unverified.
          </p>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">
          Latest sample
        </h2>

        {!latestSample ? (
          <p className="mt-4 text-sm text-secondary">
            No sample has been drawn for this pattern yet.
          </p>
        ) : (
          <div className="mt-4">
            <DefinitionGrid
              items={[
                { label: "round", value: String(latestSample.round) },
                {
                  label: "sample size",
                  value: formatCount(latestSample.sampleSize),
                  title: "URLs this draw selected."
                },
                {
                  /*
                   * The `n` of the estimate, beside the size that was drawn.
                   * They differ when a verification pass did not finish, which
                   * otherwise reads as a smaller sample nobody ordered.
                   */
                  label: "observed",
                  value: formatCount(observedCount),
                  title:
                    "URLs actually probed — the n of the estimate. Below the sample size means verification did not finish."
                },
                {
                  label: "population at draw",
                  value: formatCount(latestSample.populationAtDraw)
                },
                { label: "strata", value: String(latestSample.stratumCount) },
                { label: "method", value: latestSample.method, prose: true },
                {
                  label: "k requested",
                  value: formatCount(latestSample.kRequested)
                },
                {
                  label: "drawn at",
                  value: formatDateTime(latestSample.drawnAt)
                }
              ]}
            />
            {observedCount < latestSample.sampleSize && (
              <p className="mt-3 max-w-prose text-xs text-warning">
                {formatCount(latestSample.sampleSize - observedCount)} of the{" "}
                {formatCount(latestSample.sampleSize)} URLs this draw selected
                have no observation recorded. The estimate below rests on{" "}
                {formatCount(observedCount)} probes, not the sample size.
              </p>
            )}
          </div>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">Findings</h2>

        {findings.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">
            {pattern.status === "blocked" || pattern.status === "needs_review"
              ? "No published finding — the host refused verification or the sample could not be completed, which is an absence of measurement, not a clean result."
              : "No findings published for this pattern yet."}
          </p>
        ) : (
          <table className="mt-4 w-full border-collapse text-sm">
            <caption className="sr-only">
              Published findings for this pattern
            </caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th
                  scope="col"
                  className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
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
                  Estimate
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
              {findings.map((finding) => {
                const findingTone = severityTone(finding.severityClass);

                return (
                  <tr
                    key={finding.id}
                    className="border-b border-border-subtle transition-colors hover:bg-surface"
                    style={rowAccentStyle(findingTone)}
                  >
                    <td className="py-3 pr-4 pl-3">
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
                      Through <Estimate>, not formatted here. Impact is an
                      estimated quantity and ADR-0008 does not exempt it.
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
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">
          Population by file
        </h2>
        <p className="mt-1 max-w-prose text-sm text-secondary">
          {/*
            COUNTS PER FILE, NEVER URLS. A pattern with 40 million URLs has one
            row here per file it appears in — this table is the index whose
            absence forced the legacy engine to re-read every &lt;loc&gt; of
            every file to resolve a sample.
          */}
          Which sitemap files this pattern&apos;s URLs live in, largest
          contributor first. A sample resolves by opening the files at the top
          of this list, not by re-reading the sitemap.
        </p>

        {files.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">
            No per-file counts recorded for this pattern.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">
                Per-file URL counts for this pattern
              </caption>
              <thead>
                <tr className="border-b border-border-strong text-left">
                  <th
                    scope="col"
                    className="py-2 pr-4 pl-3 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    #
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    File
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    URLs
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    key={file.id}
                    className="border-b border-border-subtle transition-colors hover:bg-surface"
                  >
                    <td
                      className="py-3 pr-4 pl-3 text-right font-mono text-xs tabular-nums text-tertiary"
                      data-numeric
                    >
                      {file.fileOrdinal}
                    </td>
                    <td
                      className="max-w-[380px] truncate py-3 pr-4 font-mono text-xs text-secondary"
                      title={file.fileUrl}
                    >
                      {file.filename ?? file.fileUrl}
                    </td>
                    <td
                      className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                    >
                      {formatCount(file.urlCount)}
                    </td>
                    <td
                      className="py-3 text-right font-mono text-xs tabular-nums text-tertiary"
                      data-numeric
                    >
                      {/*
                        A share of the summed per-file total, not of
                        `pattern.populationCount` — dividing by a figure the
                        rows disagree with would make the column not add to
                        100% with no way to tell why.
                      */}
                      {populationFromFiles === 0
                        ? "—"
                        : `${((file.urlCount / populationFromFiles) * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h2 className="mt-12 text-lg font-semibold tracking-tight">
          Sample evidence
        </h2>
        <p className="mt-1 text-sm text-secondary">
          Every URL this draw probed, most recently observed first — the
          individual evidence behind the estimate above.
        </p>

        {observations.length === 0 ? (
          <p className="mt-4 text-sm text-secondary">
            No individual observations recorded for this pattern's latest draw.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <caption className="sr-only">
                Individual URL observations for this pattern's latest draw
              </caption>
              <thead>
                <tr className="border-b border-border-strong text-left">
                  <th
                    scope="col"
                    className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    URL
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    HTTP
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Method
                  </th>
                  <th
                    scope="col"
                    className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Flags
                  </th>
                  <th
                    scope="col"
                    className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                  >
                    Observed
                  </th>
                </tr>
              </thead>
              <tbody>
                {observations.map((observation) => (
                  <tr
                    key={observation.id}
                    className="border-b border-border-subtle transition-colors hover:bg-surface"
                  >
                    <td
                      className="max-w-[320px] truncate py-3 pr-4 pl-3 font-mono text-xs text-secondary"
                      title={observation.url}
                    >
                      {observation.url}
                    </td>
                    <td
                      className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
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
        )}
      </PageBody>
    </>
  );
}
