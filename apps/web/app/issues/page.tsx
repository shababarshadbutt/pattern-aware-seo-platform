import Link from "next/link";
import { ApiErrorPanel } from "../../components/api-error";
import { PageBody, TopBar } from "../../components/app-shell";
import {
  Estimate,
  estimateFromSnapshot,
  impactFromSnapshot
} from "../../components/estimate";
import { StatCards } from "../../components/stat-cards";
import { StatusBadge } from "../../components/status-badge";
import {
  ApiError,
  FLEET_PAGE_SIZE,
  listIssues,
  type OrganizationFinding
} from "../../lib/api";
import { formatCount, formatDateTime } from "../../lib/format";
import { rowAccentStyle, severityTone } from "../../lib/status";

export const dynamic = "force-dynamic";

/**
 * Counted figures only.
 *
 * Every value here is a row count or a set size — things the database knows
 * exactly — which is why they can sit in a card at all. A sampled figure has
 * to carry its interval (ADR-0008) and belongs in `<Estimate>` inside the
 * table, never summed into a headline number here: adding two estimates
 * without propagating their intervals would manufacture a precise-looking
 * total out of two uncertain ones.
 *
 * `capped` covers the OTHER way a card can overstate what it knows. These are
 * exact counts of the rows on this page, and the page is a page — so once the
 * fleet has more findings than one holds, "findings: 200" means "at least 200"
 * and every derived figure is a lower bound. Same ban, different cause: the
 * label has to say which it is.
 */
function statsFor(issues: readonly OrganizationFinding[], capped: boolean) {
  const sites = new Set(issues.map((issue) => issue.siteId));
  const critical = issues.filter(
    (issue) => severityTone(issue.severityClass) === "critical"
  ).length;
  const blocked = issues.filter(
    (issue) => issue.evidenceTier === "blocked"
  ).length;
  const prefix = capped ? "≥" : "";

  return [
    {
      label: capped ? "findings (page)" : "findings",
      value: formatCount(issues.length)
    },
    {
      label: "sites affected",
      value: `${prefix}${formatCount(sites.size)}`
    },
    { label: "critical", value: `${prefix}${formatCount(critical)}` },
    { label: "no measurement", value: `${prefix}${formatCount(blocked)}` }
  ];
}

export default async function IssuesPage() {
  let issues: readonly OrganizationFinding[];

  try {
    // Passed explicitly: the API's default of 50 was truncating this table
    // while the KPI cards counted the page and called it the fleet.
    ({ issues } = await listIssues(FLEET_PAGE_SIZE));
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Issues" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">Issues</h1>
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

  return (
    <>
      <TopBar items={[{ label: "Issues" }]} />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">Issues</h1>
        <p className="mt-2 max-w-prose text-sm text-secondary">
          Published findings across every monitored site, worst first. Ranked on
          impact — the point estimate weighted by severity — not on how wide a
          finding&apos;s interval is.
        </p>

        {issues.length === 0 ? (
          <p className="mt-8 text-sm text-secondary">
            No findings published yet. Findings appear here once a sitemap run
            has been sampled and verified.
          </p>
        ) : (
          <>
            <div className="mt-8">
              <StatCards
                stats={statsFor(issues, issues.length >= FLEET_PAGE_SIZE)}
              />
            </div>

            {issues.length >= FLEET_PAGE_SIZE && (
              <p className="mt-4 text-xs text-tertiary">
                Showing the {formatCount(FLEET_PAGE_SIZE)} highest-impact
                findings. There are more; the figures above describe this page
                only.
              </p>
            )}

            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-sm">
                <caption className="sr-only">
                  Findings across all sites, worst first
                </caption>
                <thead>
                  <tr className="border-b border-border-strong text-left">
                    <th
                      scope="col"
                      className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    >
                      Site
                    </th>
                    <th
                      scope="col"
                      className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
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
                  {issues.map((issue) => {
                    const tone = severityTone(issue.severityClass);

                    return (
                      <tr
                        key={issue.id}
                        className="border-b border-border-subtle transition-colors hover:bg-surface"
                        style={rowAccentStyle(tone)}
                      >
                        <th
                          scope="row"
                          className="py-3 pr-4 pl-3 text-left font-normal"
                        >
                          <Link
                            href={`/sites/${issue.siteId}`}
                            className="hover:text-accent-text hover:underline"
                          >
                            {issue.siteName}
                          </Link>
                        </th>
                        <td className="py-3 pr-4">
                          {/*
                            Links to the pattern's own evidence page — the
                            drill-down this fleet view exists to feed. Without
                            it "which site is worst" is a dead end rather than
                            the first step of an investigation.
                          */}
                          <Link
                            href={`/sites/${issue.siteId}/patterns/${issue.patternId}`}
                            className="font-mono text-xs hover:text-accent-text hover:underline"
                          >
                            {issue.patternTemplate}
                          </Link>
                        </td>
                        <td className="py-3 pr-4">
                          <StatusBadge
                            tone={tone}
                            label={issue.severityClass}
                          />
                        </td>
                        <td
                          className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {issue.httpStatus}
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {/*
                            Through <Estimate>, never formatted here — ADR-0008,
                            enforced by lib/adr-0008-guard.test.ts, which walks
                            this directory looking for exactly that mistake.
                          */}
                          <Estimate {...estimateFromSnapshot(issue)} />
                        </td>
                        <td className="py-3 pr-4 text-right">
                          <Estimate {...impactFromSnapshot(issue)} />
                        </td>
                        <td
                          className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {formatDateTime(issue.computedAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
