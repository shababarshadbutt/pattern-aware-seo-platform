import Link from "next/link";
import type { ReactNode } from "react";

import { Breadcrumbs } from "./breadcrumbs";
import {
  AnalyticsIcon,
  CrawlIcon,
  DashboardIcon,
  DocsIcon,
  FolderIcon,
  IssuesIcon,
  SettingsIcon,
  ToolsIcon
} from "./icons";

/**
 * The persistent 240px navigation rail, per DESIGN.md section 6.
 *
 * The item list mirrors the Stitch design exactly — Overview, Projects,
 * Crawls, Issues, Tools, Analytics — at the project owner's explicit
 * direction, recorded in ADR-0027. Note for anyone extending this: "Crawls"
 * is the design's label, not a description of what this platform does. The
 * product samples patterns rather than crawling every URL, so a screen built
 * under that item still must not acquire crawl-everything behaviour; see the
 * ADR and the sampling rules in CLAUDE.md.
 *
 * Exactly one item has a screen today. The rest render disabled rather than
 * as links to a 404 — a rail item that navigates nowhere is a worse lie than
 * one that says plainly it is not built yet.
 */
const NAV_ITEMS = [
  { label: "Overview", icon: DashboardIcon, href: "/" },
  { label: "Projects", icon: FolderIcon },
  { label: "Crawls", icon: CrawlIcon },
  { label: "Issues", icon: IssuesIcon },
  { label: "Tools", icon: ToolsIcon },
  { label: "Analytics", icon: AnalyticsIcon }
] as const;

const FOOTER_ITEMS = [
  { label: "Settings", icon: SettingsIcon },
  { label: "Documentation", icon: DocsIcon }
] as const;

function NavRow({
  label,
  icon: Icon,
  href
}: {
  readonly label: string;
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
  readonly href?: string;
}) {
  if (!href) {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-3 py-2 pl-4 text-tertiary"
        title={`${label} is not built yet`}
      >
        <Icon />
        <span>{label}</span>
      </span>
    );
  }

  /*
   * Active state is fixed on Overview rather than derived from the pathname.
   * `usePathname` would make the whole rail a Client Component for a single
   * boolean, and every route that exists — the sites list and both drill-down
   * levels — sits under Overview, so a computed value would produce this same
   * answer on every page the app can currently render.
   */
  return (
    <Link
      className="flex items-center gap-3 border-l-2 border-accent bg-surface py-2 pl-4 font-medium text-accent-text"
      href={href}
    >
      <Icon />
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="Main"
        className="fixed top-0 left-0 z-50 flex h-full w-60 flex-col border-r border-border-subtle bg-rail py-6 text-base"
      >
        <div className="mb-8 flex items-center gap-3 px-4">
          {/* The one place the fill indigo carries text, at its intended contrast. */}
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-foreground">
            PA
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold tracking-tight text-primary">
              Pattern-Aware
            </p>
            <p className="font-mono text-2xs text-secondary">SEO Platform</p>
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavRow key={item.label} {...item} />
          ))}
        </div>

        <div className="mt-auto flex flex-col gap-1">
          {FOOTER_ITEMS.map((item) => (
            <NavRow key={item.label} {...item} />
          ))}
        </div>
      </nav>

      {/* Offset by the rail's width; the rail is fixed so it does not scroll. */}
      <div className="ml-60 flex min-h-screen w-[calc(100%-240px)] flex-col">
        {children}
      </div>
    </div>
  );
}

/**
 * The 48px bar at the top of every screen, holding that screen's breadcrumb
 * trail.
 *
 * Rendered per page rather than from the layout because the trail's labels
 * come from the page's own data — a site's name, a pattern's template — which
 * a layout cannot see. The Stitch design also puts a search field and a
 * notification bell here; both are omitted until they do something, since a
 * control that silently does nothing costs more trust than an empty bar.
 */
export function TopBar({
  items
}: {
  readonly items: React.ComponentProps<typeof Breadcrumbs>["items"];
}) {
  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center border-b border-border-subtle bg-base px-6">
      <Breadcrumbs items={items} />
    </header>
  );
}

/** The padded content region under the top bar. */
export function PageBody({ children }: { readonly children: ReactNode }) {
  return <main className="flex-1 px-6 py-6">{children}</main>;
}
