import { notFound } from "next/navigation";
import { ApiErrorPanel } from "../../../../../components/api-error";
import { Breadcrumbs } from "../../../../../components/breadcrumbs";
import {
  Estimate,
  estimateFromSnapshot
} from "../../../../../components/estimate";
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
      <main className="mx-auto max-w-5xl px-6 py-12">
        <Breadcrumbs items={[{ label: "Sites", href: "/" }]} />
        <div className="mt-6">
          <ApiErrorPanel
            message={
              error instanceof ApiError
                ? error.message
                : "Unknown error contacting the API."
            }
          />
        </div>
      </main>
    );
  }

  const { pattern, latestSample, findings, observations } = patternResult.value;
  const siteName =
    siteResult.status === "fulfilled" ? siteResult.value.site.name : siteId;
  const tone = patternStatusTone(pattern.status);

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <Breadcrumbs
        items={[
          { label: "Sites", href: "/" },
          { label: siteName, href: `/sites/${siteId}` },
          { label: pattern.template, mono: true }
        ]}
      />

      <h1 className="mt-2 font-mono text-lg font-semibold tracking-tight break-all">
        {pattern.template}
      </h1>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <StatusBadge tone={tone} label={pattern.status} />
        {pattern.statusReason && (
          <span className="text-xs text-secondary">{pattern.statusReason}</span>
        )}
      </div>

      <div className="mt-8 flex divide-x divide-border-subtle border-y border-border-subtle">
        {[
          { label: "population", value: formatCount(pattern.populationCount) },
          { label: "segments", value: formatCount(pattern.segmentCount) },
          { label: "files", value: formatCount(pattern.fileCount) }
        ].map((stat) => (
          <div key={stat.label} className="flex-1 px-4 py-3">
            <div
              className="font-mono text-2xl leading-none tabular-nums"
              data-numeric
            >
              {stat.value}
            </div>
            <div className="mt-1.5 font-mono text-2xs uppercase tracking-wider text-tertiary">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-lg font-semibold tracking-tight">
        Latest sample
      </h2>

      {!latestSample ? (
        <p className="mt-4 text-sm text-secondary">
          No sample has been drawn for this pattern yet.
        </p>
      ) : (
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
          {[
            { label: "round", value: String(latestSample.round) },
            {
              label: "sample size",
              value: formatCount(latestSample.sampleSize)
            },
            {
              label: "population at draw",
              value: formatCount(latestSample.populationAtDraw)
            },
            { label: "strata", value: String(latestSample.stratumCount) },
            { label: "method", value: latestSample.method },
            {
              label: "k requested",
              value: formatCount(latestSample.kRequested)
            },
            { label: "drawn at", value: formatDateTime(latestSample.drawnAt) }
          ].map((row) => (
            <div key={row.label}>
              <dt className="font-mono text-2xs uppercase tracking-wider text-tertiary">
                {row.label}
              </dt>
              <dd
                className="mt-1 font-mono text-xs tabular-nums text-primary"
                data-numeric
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <h2 className="mt-10 text-lg font-semibold tracking-tight">Findings</h2>

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
                  className="border-b border-border-subtle"
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
                  <td
                    className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                    data-numeric
                  >
                    {finding.impactScore.toFixed(1)}
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

      <h2 className="mt-10 text-lg font-semibold tracking-tight">
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
                  className="border-b border-border-subtle"
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
    </main>
  );
}
