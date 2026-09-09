import Link from "next/link";

import { ApiErrorPanel } from "../../components/api-error";
import { PageBody, TopBar } from "../../components/app-shell";
import {
  AnalyticsIcon,
  GlobeIcon,
  IssuesIcon,
  LayersIcon,
  SettingsIcon,
  SitemapIcon
} from "../../components/icons";
import { Pagination } from "../../components/pagination";
import { SeverityBar } from "../../components/severity-bar";
import { StatCards } from "../../components/stat-cards";
import { StatusBadge } from "../../components/status-badge";
import {
  FilterPills,
  HeaderAction,
  StatusStrip
} from "../../components/toolbar";
import {
  ApiError,
  listProjects,
  type ProjectSummary,
  type ProjectsPage
} from "../../lib/api";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  PROJECTS_PAGE_SIZE,
  pageParam,
  pageWindow,
  projectRunState,
  RUN_STATE_LABEL,
  TIER_FILTERS,
  tierFilter
} from "../../lib/projects";
import {
  projectRunTone,
  rowAccentStyle,
  runStatusTone,
  siteActiveTone
} from "../../lib/status";
import { NewProjectForm } from "./new-project-form";
import { RunNowAction } from "./run-now-action";

/**
 * The fleet portfolio — the Stitch design's "Projects Portfolio" screen.
 *
 * WHY THIS EXISTS WHEN ADR-0028 SAID IT SHOULD NOT. That ADR ruled Projects a
 * duplicate of Overview, on the evidence available then: "Projects is the
 * design's name for the sites list, which Overview already is." The owner has
 * since supplied the screen, and it is not a sites list — it is a fleet
 * portfolio with its own aggregates, filters, pagination and an onboarding
 * action, over data no route could reach. The verdict is inverted rather than
 * merely revised, and ADR-0037 records why.
 *
 * THREE THINGS THE DESIGN SHOWS THAT THIS PLATFORM CANNOT, each refused rather
 * than approximated — the rule ADR-0031 set for a form's fields and ADR-0032
 * scaled to a screen:
 *
 * 1. A HEALTH SCORE. Stitch shows "94/100" per project and "Avg. Technical
 *    Health 88.4/100" in a card. This platform computes no such number
 *    anywhere. A composite invented here would be the most confident-looking
 *    figure on the screen and the only one with no definition, no test and no
 *    way for a reader to check it. The column carries counted findings instead,
 *    and the intro says the score is absent rather than leaving a reader to
 *    wonder which card it went into.
 * 2. A CRAWL CADENCE. Stitch shows "Weekly (Sun 00:00 UTC)" and offers a
 *    cadence filter. There is no scheduler, no cadence column and nothing
 *    anywhere that stores an interval. The column is LAST RUN, and the cadence
 *    filter renders inert with its reason.
 * 3. "TOTAL CRAWLED PAGES", with a share of them indexable. This platform
 *    samples a population; it does not request all of it, and it has no
 *    indexability signal at all. The figure is URLS DISCOVERED, and the CSV
 *    column is named `urls_discovered` too, because a spreadsheet outlives the
 *    screen that produced it.
 */

export const dynamic = "force-dynamic";

interface ProjectParams {
  readonly page?: string;
  readonly tier?: string;
  readonly inactive?: string;
}

function href(
  params: ProjectParams,
  overrides: Record<string, string>
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...params, ...overrides })) {
    if (typeof value === "string" && value !== "" && value !== "1") {
      search.set(key, value);
    }
  }

  const query = search.toString();

  return query === "" ? "/projects" : `/projects?${query}`;
}

export default async function ProjectsPortfolioPage({
  searchParams
}: {
  readonly searchParams: Promise<ProjectParams>;
}) {
  const params = await searchParams;
  const page = pageParam(params.page);
  const tier = tierFilter(params.tier);
  const includeInactive = params.inactive === "true";

  let data: ProjectsPage;

  try {
    data = await listProjects({
      limit: PROJECTS_PAGE_SIZE,
      offset: (page - 1) * PROJECTS_PAGE_SIZE,
      ...(tier === undefined ? {} : { tier }),
      includeInactive
    });
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Projects" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">
            Projects Portfolio
          </h1>
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

  const window = pageWindow(
    page,
    PROJECTS_PAGE_SIZE,
    data.projects.length,
    data.total
  );
  const exportSearch = new URLSearchParams();

  if (tier !== undefined) {
    exportSearch.set("tier", tier);
  }

  if (includeInactive) {
    exportSearch.set("inactive", "true");
  }

  return (
    <>
      <TopBar items={[{ label: "Projects" }]} />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs tracking-wider text-accent-text">
            FLEET
          </span>
          <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
            · {formatCount(data.totals.sites)} monitored{" "}
            {data.totals.sites === 1 ? "domain" : "domains"}
          </span>
          <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
            · sampled, never fully crawled
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Projects Portfolio
            </h1>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              Every monitored domain, its most recent run and the findings that
              run published. There is no technical-health score here because
              this platform computes none — a site&rsquo;s state is the findings
              it actually has, and each carries its own confidence interval one
              level down.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-start gap-2">
            <HeaderAction
              href={`/projects/export${exportSearch.toString() === "" ? "" : `?${exportSearch.toString()}`}`}
              icon={LayersIcon}
              label="Export portfolio CSV"
            />
            {/*
              THE ONE CLIENT COMPONENT ON THIS SCREEN, kept in a leaf so the
              cards, filters and table all render on the server. It has to be
              one: a create has two outcomes a reader must be able to tell apart
              — onboarded, or that host is already monitored — and reporting
              which happened is not expressible in a Server Component.

              In the header because that is where the design's "Add New Project"
              sits. Closed it is a button; opened it becomes a panel, which
              `flex-wrap` drops onto its own line rather than squeezing the
              title.
            */}
            <NewProjectForm />
          </div>
        </div>

        {/*
          FOUR KPI CARDS, COUNTED ONLY (DESIGN.md 7.2). The design's third card
          is the fleet's average health score, which does not exist; this one
          reports patterns, the counted thing a run actually produces. And every
          figure comes from `totals`, computed over every matching site rather
          than from the page — a card that sums the page and calls it the fleet
          is the defect D3a found on both fleet screens.
        */}
        <div className="mt-6">
          <StatCards
            stats={[
              {
                label: "monitored domains",
                value: formatCount(data.totals.sites),
                icon: GlobeIcon,
                ...(data.totals.onboardedRecently > 0
                  ? {
                      chip: {
                        text: `+${data.totals.onboardedRecently} in 30 days`,
                        tone: "healthy" as const
                      }
                    }
                  : {})
              },
              {
                label: "urls discovered",
                value: formatCount(data.totals.urlsDiscovered),
                icon: SitemapIcon,
                title:
                  "Summed across each site's LATEST run. Discovered from sitemaps — not requested: the sampler probes a fraction of these on purpose."
              },
              {
                label: "patterns",
                value: formatCount(data.totals.patterns),
                icon: LayersIcon,
                title:
                  "The templates those URLs collapse into. This is what the platform audits, instead of the URLs themselves."
              },
              {
                label: "findings needing triage",
                value: formatCount(data.totals.criticalFindings),
                icon: IssuesIcon,
                title:
                  "Findings whose severity class this platform treats as damage. A host refusing us is not counted — that is not a site defect.",
                ...(data.totals.criticalFindings > 0
                  ? {
                      emphasis: "warning" as const,
                      chip: {
                        text: `of ${formatCount(data.totals.findings)} total`,
                        tone: "warning" as const
                      }
                    }
                  : {})
              }
            ]}
          />
        </div>

        {/* The design's filter row: pills for what is real, inert for what is not. */}
        <div className="mt-5 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-surface-raised p-2">
          <FilterPills
            items={TIER_FILTERS.map((filter) => ({
              label: filter.label,
              href: href(params, {
                tier: filter.value === "all" ? "" : filter.value,
                page: ""
              }),
              current:
                filter.value === "all"
                  ? tier === undefined
                  : tier === filter.value
            }))}
          />
          <FilterPills
            items={[
              {
                label: includeInactive ? "Active + inactive" : "Active only",
                href: href(params, {
                  inactive: includeInactive ? "" : "true",
                  page: ""
                }),
                current: includeInactive
              }
            ]}
          />
          {/*
            The design offers a cadence filter and a table/grid view toggle.
            Both are drawn inert with their reasons rather than dropped: a
            reader comparing this to the design should see that the control was
            considered, and a grid of identical cards is a named anti-pattern in
            DESIGN.md section 9 rather than merely unbuilt.
          */}
          <span
            aria-disabled="true"
            className="cursor-not-allowed rounded-sm px-3 py-2 font-mono text-2xs tracking-wider text-tertiary uppercase"
            title="There is no scheduler: no cadence column exists, no job runs on a schedule, and nothing anywhere stores an interval."
          >
            Cadence: n/a
          </span>
          <span
            aria-disabled="true"
            className="cursor-not-allowed rounded-sm px-3 py-2 font-mono text-2xs tracking-wider text-tertiary uppercase"
            title="Card-grid view is not offered: a grid of identical cards as a list container is an explicit anti-pattern in DESIGN.md section 9. A list of things is a table."
          >
            Table view
          </span>
        </div>

        {data.projects.length === 0 ? (
          <EmptyPortfolio
            filtered={tier !== undefined || !includeInactive}
            params={params}
          />
        ) : (
          <div className="mt-3 rounded-md border border-border-subtle bg-surface-raised">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <caption className="sr-only">
                  Every monitored domain, its latest run and its findings.
                </caption>
                <thead>
                  <tr className="border-b border-border-strong">
                    {[
                      { label: "domain / project", align: "" },
                      { label: "findings", align: "" },
                      { label: "urls discovered", align: "text-right" },
                      { label: "patterns", align: "text-right" },
                      { label: "last run", align: "" },
                      { label: "actions", align: "text-right" }
                    ].map((column) => (
                      <th
                        className={`px-3 py-2 font-mono text-2xs font-medium whitespace-nowrap tracking-wider text-tertiary uppercase ${column.align}`}
                        key={column.label}
                        scope="col"
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((project) => (
                    <ProjectRow key={project.site.id} project={project} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              href={(next) => href(params, { page: String(next) })}
              noun="tracked projects"
              window={window}
            />
          </div>
        )}

        <StatusStrip
          actions={
            <Link
              className="font-mono text-2xs tracking-wider text-accent-text uppercase hover:underline"
              href="/issues"
            >
              Fleet findings
            </Link>
          }
          facts={[
            "No health score — a site's state is the findings it holds",
            "No scheduler — a run only starts when someone clicks Run now",
            "URLs are discovered from sitemaps and sampled, never all requested"
          ]}
        />
      </PageBody>
    </>
  );
}

function ProjectRow({ project }: { readonly project: ProjectSummary }) {
  const { site, latestRun, findings } = project;
  const runState = projectRunState(project);
  const tone = projectRunTone(runState);

  return (
    <tr
      className="border-b border-border-subtle last:border-b-0 transition-colors hover:bg-surface"
      style={rowAccentStyle(tone)}
    >
      <th className="px-3 py-3 text-left font-normal" scope="row">
        <div className="flex items-center gap-3">
          {/*
            The design's two-letter avatar tile. Derived from the name, so it is
            stable and needs no stored asset — and `aria-hidden`, because the
            name is right beside it.
          */}
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-base font-mono text-2xs text-secondary uppercase"
          >
            {initials(site.name)}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                className="text-sm text-primary hover:text-accent-text hover:underline"
                href={`/sites/${site.id}`}
              >
                {site.name}
              </Link>
              <span
                className="rounded-xs border border-border-subtle px-1.5 font-mono text-2xs tracking-wider text-tertiary uppercase"
                title="The queue namespace this site's work runs under."
              >
                {site.tier}
              </span>
              {!site.isActive && (
                <StatusBadge label="inactive" tone={siteActiveTone(false)} />
              )}
            </div>
            <p className="font-mono text-2xs text-tertiary">{site.host}</p>
          </div>
        </div>
      </th>

      {/*
        THE DESIGN'S HEALTH-SCORE COLUMN, carrying counted findings instead.
        A site with no findings and a site never measured are different facts,
        so they read differently rather than both showing an empty bar.
      */}
      <td className="px-3 py-3">
        {findings.total === 0 ? (
          <span className="font-mono text-2xs text-tertiary">
            {runState === "never_run" ? "not measured" : "none published"}
          </span>
        ) : (
          <SeverityBar
            critical={findings.critical}
            segments={findings.bySeverity}
            total={findings.total}
          />
        )}
      </td>

      <td
        className="px-3 py-3 text-right font-mono text-xs tabular-nums text-secondary"
        data-numeric
        title="Discovered from this site's sitemaps in its latest run. Not requested — the sampler probes a fraction of these."
      >
        {latestRun === undefined ? "—" : formatCount(latestRun.totalUrls)}
      </td>

      <td
        className="px-3 py-3 text-right font-mono text-xs tabular-nums text-secondary"
        data-numeric
      >
        {latestRun === undefined ? "—" : formatCount(latestRun.totalPatterns)}
      </td>

      <td className="px-3 py-3">
        {latestRun === undefined ? (
          /*
            NEVER RUN IS SAID, not shown as a dash. A dash in a date column
            reads as missing data about a run that happened; this site has no
            run at all, which is an ordinary state for a project onboarded
            minutes ago and needs saying (standards section 1.5).
          */
          <span className="font-mono text-2xs text-tertiary">never run</span>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <StatusBadge
                label={latestRun.status}
                tone={runStatusTone(latestRun.status)}
              />
              {runState === "no_urls" && (
                /*
                  A run that completed and found nothing is not a healthy small
                  site: an HTML error page parses as valid, URL-less XML. Said
                  beside the status, because `status` cannot express it — the
                  parse genuinely succeeded.
                */
                <StatusBadge label={RUN_STATE_LABEL.no_urls} tone="warning" />
              )}
            </div>
            <Link
              className="font-mono text-2xs text-tertiary hover:text-accent-text hover:underline"
              href={`/runs/${latestRun.id}`}
            >
              {latestRun.startedAt === null
                ? "not started"
                : formatDateTime(latestRun.startedAt)}
            </Link>
          </div>
        )}
      </td>

      {/*
        THE DESIGN'S QUICK ACTIONS: play, gear, kebab. The play button now
        posts to `POST /sites/:siteId/runs` (`RunNowAction`) — a real,
        one-off run, not the design's recurring cadence, which still has no
        scheduler behind it. The kebab is dropped: a menu of unbuilt items is
        worse than no menu.
      */}
      <td className="px-3 py-3">
        <div className="flex items-center justify-end gap-1">
          <RunNowAction siteId={site.id} />
          <RowAction
            href={`/analytics?site=${site.id}`}
            icon={AnalyticsIcon}
            label="Analytics"
          />
          <RowAction
            href={`/settings?site=${site.id}`}
            icon={SettingsIcon}
            label="Settings"
          />
        </div>
      </td>
    </tr>
  );
}

function RowAction({
  icon: Icon,
  label,
  href: target,
  disabledReason
}: {
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => React.ReactNode;
  readonly label: string;
  readonly href?: string;
  readonly disabledReason?: string;
}) {
  const shape =
    "flex h-7 w-7 items-center justify-center rounded-sm border border-border-subtle transition-colors";

  if (target === undefined) {
    return (
      <span
        aria-disabled="true"
        className={`${shape} cursor-not-allowed text-tertiary opacity-60`}
        title={disabledReason}
      >
        <Icon className="h-4 w-4" />
        {/*
          The reason reaches a screen reader, not only a hover. An icon-only
          control with a `title` and nothing else is unnamed to anyone not using
          a mouse — and the whole point of drawing this disabled rather than
          omitting it is that the reader learns WHY, so the why has to be
          readable by everyone.
        */}
        <span className="sr-only">
          {label} — not available. {disabledReason}
        </span>
      </span>
    );
  }

  return (
    <Link
      aria-label={label}
      className={`${shape} text-secondary hover:border-border-strong hover:text-primary`}
      href={target}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </Link>
  );
}

/**
 * The empty state, which has to distinguish two very different situations.
 *
 * An empty table under an active filter is not the same as an account with no
 * projects, and rendering one message for both is the presentational form of
 * the section 1.5 rule — the reader cannot tell whether the fleet is empty or
 * their filter hid it.
 */
function EmptyPortfolio({
  filtered,
  params
}: {
  readonly filtered: boolean;
  readonly params: ProjectParams;
}) {
  return (
    <div className="mt-3 rounded-md border border-border-subtle bg-surface-raised px-5 py-8">
      {filtered ? (
        <>
          <p className="text-sm text-secondary">
            No project matches this filter.
          </p>
          <p className="mt-2 text-sm text-secondary">
            <Link
              className="text-accent-text hover:underline"
              href={href(params, { tier: "", inactive: "true", page: "" })}
            >
              Show every tier, including inactive projects
            </Link>
            .
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-secondary">
            No projects yet. Add one below, or run{" "}
            <code className="font-mono text-xs text-tertiary">
              pnpm seed:demo
            </code>{" "}
            for two sites with realistic pattern and sample data.
          </p>
          <p className="mt-2 max-w-prose text-2xs leading-relaxed text-tertiary">
            The seeded data is stamped as a dry run at the database level, so
            manufactured evidence stays distinguishable from a measured audit.
          </p>
        </>
      )}
    </div>
  );
}

/** Two letters from a name, for the design's avatar tile. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "??";
  }

  if (words.length === 1) {
    return (words[0] ?? "").slice(0, 2);
  }

  return `${(words[0] ?? "").charAt(0)}${(words[1] ?? "").charAt(0)}`;
}
