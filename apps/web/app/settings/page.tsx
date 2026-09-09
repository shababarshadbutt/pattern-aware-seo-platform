import Link from "next/link";
import { ApiErrorPanel } from "../../components/api-error";
import { PageBody, TopBar } from "../../components/app-shell";
import { MetadataPanel } from "../../components/metadata-panel";
import { StatusBadge } from "../../components/status-badge";
import { Tabs } from "../../components/tabs";
import {
  ApiError,
  getSettings,
  getSite,
  listSites,
  type SettingsDetail,
  type SiteDetail,
  type SiteSummary
} from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { siteActiveTone } from "../../lib/status";
import { PlatformLimits } from "./platform-limits";
import { SiteForm } from "./site-form";

export const dynamic = "force-dynamic";

/**
 * Project Settings, per the Stitch design.
 *
 * REBUILT. The first version of this screen was a full-width table of
 * environment limits, invented because no document described a Settings screen
 * and I did not ask for the design. The real screen is scoped to ONE project:
 * a tab row, a "Target Configuration" form card, and a "Project Metadata"
 * sidebar beside it. See ADR-0031, which also records that this was matched to
 * a screenshot rather than to the design's generated config.
 *
 * The selected project and tab are SEARCH PARAMS, not client state, so
 * everything except the form itself stays a Server Component and a tab is
 * shareable and back-button-correct. The design assumes a current project;
 * this app has no such concept, so the first site stands in until one is named.
 */
type Tab = "core" | "platform";

function tabFrom(raw: string | undefined): Tab {
  return raw === "platform" ? "platform" : "core";
}

export default async function SettingsPage({
  searchParams
}: {
  readonly searchParams: Promise<{
    readonly site?: string;
    readonly tab?: string;
  }>;
}) {
  const params = await searchParams;
  const tab = tabFrom(params.tab);

  let settings: SettingsDetail;
  let sites: readonly SiteSummary[];

  try {
    [settings, { sites }] = await Promise.all([getSettings(), listSites()]);
  } catch (error) {
    return (
      <>
        <TopBar items={[{ label: "Settings" }]} />
        <PageBody>
          <h1 className="text-xl font-semibold tracking-tight">
            Project Settings
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

  const selected =
    sites.find((site) => site.id === params.site) ?? sites[0] ?? undefined;

  /*
   * The run behind "Last Analysis". Fetched only for the Project Core tab, and
   * allowed to fail: it labels one metadata row, so a failure there must not
   * take down a screen whose subject is the site's configuration.
   */
  let detail: SiteDetail | undefined;

  if (selected !== undefined && tab === "core") {
    detail = await getSite(selected.id).catch(() => undefined);
  }

  const platformCap = settings.policy.find(
    (limit) => limit.key === "HTTP_PER_SITE_DAILY_REQUEST_CAP"
  );

  const href = (next: Tab): string =>
    selected === undefined
      ? `/settings?tab=${next}`
      : `/settings?site=${selected.id}&tab=${next}`;

  return (
    <>
      <TopBar items={[{ label: "Settings" }]} />
      <PageBody>
        <h1 className="text-xl font-semibold tracking-tight">
          Project Settings
        </h1>
        <p className="mt-2 max-w-prose text-sm text-secondary">
          {selected === undefined
            ? "No sites yet — run pnpm seed:demo to create the demo organization."
            : `Configure sampling parameters and request policy for '${selected.host}'.`}
        </p>

        {/*
          The site selector the design does not have, because the design assumes
          a current project and this app has no such concept. Rendered as links
          rather than a <select> so it needs no client state.
        */}
        {sites.length > 1 && (
          <nav aria-label="Project" className="mt-5 flex flex-wrap gap-2">
            {sites.map((site) => (
              <Link
                aria-current={site.id === selected?.id ? "true" : undefined}
                className={
                  site.id === selected?.id
                    ? "rounded-sm border border-accent bg-surface px-3 py-1.5 text-xs font-medium text-accent-text"
                    : "rounded-sm border border-border-subtle px-3 py-1.5 text-xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
                }
                href={`/settings?site=${site.id}&tab=${tab}`}
                key={site.id}
              >
                {site.name}
              </Link>
            ))}
          </nav>
        )}

        <div className="mt-6">
          <Tabs
            items={[
              {
                label: "Project Core",
                href: href("core"),
                current: tab === "core"
              },
              {
                label: "Platform limits",
                href: href("platform"),
                current: tab === "platform"
              },
              // The design's remaining three tabs. There is no user, member,
              // role, api_key or webhook table anywhere, so they render
              // disabled rather than as links to an empty screen.
              { label: "Integrations" },
              { label: "Team & Roles" },
              { label: "API & Webhooks" }
            ]}
          />
        </div>

        {tab === "platform" ? (
          <div className="mt-8">
            <PlatformLimits settings={settings} sites={sites} />
          </div>
        ) : selected === undefined ? (
          <p className="mt-8 text-sm text-secondary">
            Onboard a site to configure it.
          </p>
        ) : (
          /*
            The design's two-column split: the form card, and a narrower
            metadata card beside it. Stacked below `lg`, since the form's
            paired fields already collapse at `sm`.
          */
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <SiteForm platformCap={platformCap} site={selected} />

            <MetadataPanel
              rows={[
                {
                  label: "Project ID",
                  value: selected.id,
                  mono: true,
                  title: selected.id
                },
                {
                  label: "Created",
                  value: formatDateTime(selected.createdAt),
                  mono: true
                },
                {
                  /*
                   * "Last Analysis", not the design's "Last Crawl" — the same
                   * decision the rail makes, for the same reason (ADR-0039): a
                   * run SAMPLES patterns rather than requesting every URL. The
                   * tooltip stays, because the label alone cannot say that.
                   */
                  label: "Last Analysis",
                  value:
                    detail?.latestRun?.startedAt === undefined ||
                    detail.latestRun.startedAt === null
                      ? "never"
                      : formatDateTime(detail.latestRun.startedAt),
                  mono: true,
                  title:
                    "The most recent sampling run. A run collapses URLs into patterns and probes a sample of each; it does not request every URL."
                },
                {
                  label: "Status",
                  value: (
                    <StatusBadge
                      label={selected.isActive ? "active" : "paused"}
                      tone={siteActiveTone(selected.isActive)}
                    />
                  )
                }
              ]}
              title="Project Metadata"
            />
          </div>
        )}
      </PageBody>
    </>
  );
}
