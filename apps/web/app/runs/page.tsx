import Link from "next/link";
import { ApiErrorPanel } from "../../components/api-error";
import { PageBody, TopBar } from "../../components/app-shell";
import { StatCards } from "../../components/stat-cards";
import { StatusBadge } from "../../components/status-badge";
import {
  ApiError,
  FLEET_PAGE_SIZE,
  listRuns,
  type OrganizationRun
} from "../../lib/api";
import { formatCount, formatDateTime } from "../../lib/format";
import { rowAccentStyle, runStatusTone } from "../../lib/status";

export const dynamic = "force-dynamic";

/**
 * The KPI row, over the rows this page actually holds.
 *
 * `capped` is why the labels are hedged. Every figure here is derived from the
 * fetched page, so once the fleet has more runs than one page they describe the
 * page and not the fleet — a card reading "200 runs" that means "at least 200"
 * is the manufactured-precision failure DESIGN.md section 9 bans. The honest
 * fix while there is no pagination is to say which one it is.
 */
function statsFor(runs: readonly OrganizationRun[], capped: boolean) {
  const inFlight = runs.filter(
    (run) => run.status === "pending" || run.status === "running"
  ).length;
  const degraded = runs.filter(
    (run) => run.status === "degraded" || run.status === "failed"
  ).length;
  const prefix = capped ? "≥" : "";

  return [
    { label: capped ? "runs (page)" : "runs", value: formatCount(runs.length) },
    { label: "in flight", value: `${prefix}${formatCount(inFlight)}` },
    {
      label: "degraded or failed",
      value: `${prefix}${formatCount(degraded)}`
    },
    {
      label: "urls discovered",
      value: `${prefix}${formatCount(runs.reduce((total, run) => total + run.totalUrls, 0))}`
    }
  ];
}

export default async function RunsPage() {
  let runs: readonly OrganizationRun[];

  try {
    // The limit is passed rather than left to the API's default of 50: the
    // default silently truncated this table while nothing said so.
    ({ runs } = await listRuns(FLEET_PAGE_SIZE));
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Runs" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
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
      <TopBar items={[{ label: "Runs" }]} />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
        {/*
          "Runs" — the entity's own name, and what the schema calls it
          (`sitemap_run`). The rail item that leads here says "Analyses"
          (ADR-0039); neither says "Crawls", which is the Stitch label. A run is
          a sampling pass over a sitemap: it collapses URLs into patterns and
          probes a statistical sample of each. Calling it a crawl on the screen
          that shows the URL counts would teach the reader the wrong model of
          the product.
        */}
        <p className="mt-2 max-w-prose text-sm text-secondary">
          Sitemap runs across every monitored site, newest first. A run
          discovers URLs, collapses them into patterns and samples each — it
          does not request every URL.
        </p>

        {runs.length === 0 ? (
          <p className="mt-8 text-sm text-secondary">
            No runs yet. A run appears here once one has been started for a
            site.
          </p>
        ) : (
          <>
            <div className="mt-8">
              <StatCards
                stats={statsFor(runs, runs.length >= FLEET_PAGE_SIZE)}
              />
            </div>

            {runs.length >= FLEET_PAGE_SIZE && (
              <p className="mt-4 text-xs text-tertiary">
                Showing the {formatCount(FLEET_PAGE_SIZE)} newest runs. There
                are more; the figures above describe this page only.
              </p>
            )}

            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-sm">
                <caption className="sr-only">
                  Sitemap runs across all sites
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
                      Status
                    </th>
                    <th
                      scope="col"
                      className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    >
                      Files
                    </th>
                    <th
                      scope="col"
                      className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    >
                      URLs
                    </th>
                    <th
                      scope="col"
                      className="py-2 pr-4 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    >
                      Patterns
                    </th>
                    <th
                      scope="col"
                      className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
                    >
                      Started
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const tone = runStatusTone(run.status);

                    return (
                      <tr
                        key={run.id}
                        className="border-b border-border-subtle transition-colors hover:bg-surface"
                        style={rowAccentStyle(tone)}
                      >
                        <th
                          scope="row"
                          className="py-3 pr-4 pl-3 text-left font-normal"
                        >
                          <Link
                            href={`/sites/${run.siteId}`}
                            className="hover:text-accent-text hover:underline"
                          >
                            {run.siteName}
                          </Link>
                        </th>
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge tone={tone} label={run.status} />
                            {/*
                              A dry run's numbers are not a measurement of the
                              live site. M7 made the demo seed stop pretending
                              otherwise at the data layer; the screen has to
                              say so too, or the distinction is invisible again.
                            */}
                            {run.isDryRun && (
                              <StatusBadge tone="unknown" label="dry run" />
                            )}
                            {run.statusReason && (
                              <span className="font-mono text-2xs uppercase tracking-wider text-tertiary">
                                {run.statusReason.replace(/_/g, " ")}
                              </span>
                            )}
                          </div>
                        </td>
                        <td
                          className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {formatCount(run.parsedFiles)}/
                          {formatCount(run.totalFiles)}
                        </td>
                        <td
                          className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {formatCount(run.totalUrls)}
                        </td>
                        <td
                          className="py-3 pr-4 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {formatCount(run.totalPatterns)}
                        </td>
                        <td
                          className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                          data-numeric
                        >
                          {/*
                            The link into the run's detail, and the timestamp is
                            what carries it: a run has no name, and its start is
                            the thing a reader recognises it by. Until this
                            existed the row was a dead end — the files it read
                            and what its patterns became had no screen at all.
                          */}
                          <Link
                            href={`/runs/${run.id}`}
                            className="hover:text-accent-text hover:underline"
                          >
                            {run.startedAt
                              ? formatDateTime(run.startedAt)
                              : "not started"}
                          </Link>
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
