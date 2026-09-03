import Link from "next/link";
import { ApiErrorPanel } from "../components/api-error";
import { StatStrip } from "../components/stat-strip";
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
      <main className="mx-auto max-w-5xl px-6 py-12">
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
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Sites</h1>
      <p className="mt-2 max-w-prose text-sm text-secondary">
        Every site being monitored. Pick one to see its patterns and sampling
        confidence.
      </p>

      <div className="mt-8">
        <StatStrip stats={statsFor(sites)} />
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
                  className="border-b border-border-subtle"
                  style={rowAccentStyle(tone)}
                >
                  <th
                    scope="row"
                    className="py-3 pr-4 pl-3 text-left font-normal"
                  >
                    <Link
                      href={`/sites/${site.id}`}
                      className="hover:text-accent hover:underline"
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
    </main>
  );
}
