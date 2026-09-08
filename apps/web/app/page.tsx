import Link from "next/link";
import { ApiErrorPanel } from "../components/api-error";
import { PageBody, TopBar } from "../components/app-shell";
import { StatCards } from "../components/stat-cards";
import { StatusBadge } from "../components/status-badge";
import { ApiError, listSites, type SiteSummary } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { rowAccentStyle, siteActiveTone } from "../lib/status";

export const dynamic = "force-dynamic";

function statsFor(sites: readonly SiteSummary[]) {
  const active = sites.filter((s) => s.isActive).length;
  const priority = sites.filter((s) => s.tier === "priority").length;

  return [
    { label: "sites", value: String(sites.length) },
    { label: "active", value: String(active) },
    { label: "priority tier", value: String(priority) }
  ];
}

export default async function SitesPage() {
  let sites: readonly SiteSummary[];

  try {
    ({ sites } = await listSites());
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Sites" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
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
      <TopBar items={[{ label: "Sites" }]} />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
        <p className="mt-2 max-w-prose text-sm text-secondary">
          Every site being monitored. Pick one to see its patterns and sampling
          confidence, or open the{" "}
          <Link className="text-accent-text hover:underline" href="/projects">
            Projects portfolio
          </Link>{" "}
          for each site&rsquo;s latest run and findings side by side.
        </p>
        {/*
          THE DUPLICATION IS REAL AND FLAGGED RATHER THAN HIDDEN. ADR-0028 ruled
          Projects a duplicate of Overview; with the portfolio built (ADR-0037)
          the relationship is the other way round — this table is now a strict
          subset of that screen. Folding it in, or re-scoping Overview to a
          fleet dashboard, is a deliberate decision about what the landing
          screen is for, so it is recorded as owed rather than made in passing
          while building something else.
        */}

        <div className="mt-8">
          <StatCards stats={statsFor(sites)} />
        </div>

        {sites.length === 0 ? (
          <p className="mt-8 text-sm text-secondary">
            No sites yet.{" "}
            <code className="font-mono text-xs text-tertiary">
              pnpm seed:demo
            </code>{" "}
            creates one with realistic pattern and sample data.
          </p>
        ) : (
          <table className="mt-8 w-full border-collapse text-sm">
            <caption className="sr-only">Monitored sites</caption>
            <thead>
              <tr className="border-b border-border-strong text-left">
                <th
                  scope="col"
                  className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Name
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Host
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Tier
                </th>
                <th
                  scope="col"
                  className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Status
                </th>
                <th
                  scope="col"
                  className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                >
                  Onboarded
                </th>
              </tr>
            </thead>
            <tbody>
              {sites.map((site) => {
                const tone = siteActiveTone(site.isActive);

                return (
                  <tr
                    key={site.id}
                    className="border-b border-border-subtle transition-colors hover:bg-surface"
                    style={rowAccentStyle(tone)}
                  >
                    <th
                      scope="row"
                      className="py-3 pr-4 pl-3 text-left font-normal"
                    >
                      <Link
                        href={`/sites/${site.id}`}
                        className="hover:text-accent-text hover:underline"
                      >
                        {site.name}
                      </Link>
                    </th>
                    <td className="py-3 pr-4 font-mono text-xs text-secondary">
                      {site.host}
                    </td>
                    <td className="py-3 pr-4 font-mono text-xs uppercase tracking-wider text-secondary">
                      {site.tier}
                    </td>
                    <td className="py-3 pr-4">
                      <StatusBadge
                        tone={tone}
                        label={site.isActive ? "active" : "inactive"}
                      />
                    </td>
                    <td
                      className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                    >
                      {formatDateTime(site.createdAt)}
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
