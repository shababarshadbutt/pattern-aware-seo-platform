"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

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
 * The rail's items, per DESIGN.md section 6.
 *
 * The list follows the Stitch design's order — Overview, Projects, Analyses,
 * Issues, Tools, Analytics — with ONE label deliberately not the design's.
 * Stitch says "Crawls"; ADR-0027 kept that at the owner's direction while
 * recording the tension, and ADR-0039 resolves it: this platform samples
 * patterns rather than requesting every URL, and a rail is where a reader
 * learns the product's model. A screen built under this item must still not
 * acquire crawl-everything behaviour; see the sampling rules in CLAUDE.md.
 *
 * NOTE THE NEIGHBOUR. "Analyses" sits directly above "Analytics", and they are
 * different screens — a run's sampling passes, and per-site estimator health.
 * If a reader confuses them, the fix is a better name for one of them, not a
 * quiet return to crawler language.
 *
 * `match` is the route prefix that makes an item current. Overview owns the
 * site drill-down as well as the root, because a site and a pattern are both
 * reached from it and neither has a rail item of its own.
 *
 * EVERY PREFIX IN A `match` MUST BE A ROUTE THAT EXISTS. Overview's list
 * included `/sites`, and there is no `/sites` page — nothing linked there, so
 * the entry was a dormant 404 waiting for the first person to trim a URL by
 * hand or paste one. It is the same class of latent lie the `SOON` marker below
 * exists to fix, so it is spelled `/sites/` — the drill-down's real prefix,
 * which cannot be reached without a site id.
 *
 * An item with no `href` has no screen yet and renders disabled with a visible
 * marker rather than as a link to a 404 — a rail item that navigates nowhere
 * is a worse lie than one that says plainly it is not built.
 */
/** Exported so `nav-rail.test.tsx` can assert the labels and hrefs. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Overview",
    icon: DashboardIcon,
    href: "/",
    match: ["/", "/sites/"]
  },
  /*
   * A REAL LINK SINCE ADR-0037, having been disabled since ADR-0027. ADR-0028
   * ruled Projects a duplicate of Overview — right on the evidence then, wrong
   * once the owner supplied the screen, which is a fleet portfolio with its own
   * aggregates, filters and the app's onboarding action rather than a second
   * sites list. `/sites/` stays on Overview's `match` so a drill-down keeps
   * Overview highlighted; a project row links there too.
   */
  {
    label: "Projects",
    icon: FolderIcon,
    href: "/projects",
    match: ["/projects"]
  },
  { label: "Analyses", icon: CrawlIcon, href: "/runs", match: ["/runs"] },
  { label: "Issues", icon: IssuesIcon, href: "/issues", match: ["/issues"] },
  { label: "Tools", icon: ToolsIcon, href: "/tools", match: ["/tools"] },
  {
    href: "/analytics",
    icon: AnalyticsIcon,
    label: "Analytics",
    match: ["/analytics"]
  }
] as const;

export const FOOTER_ITEMS: readonly NavItem[] = [
  {
    label: "Settings",
    icon: SettingsIcon,
    href: "/settings",
    match: ["/settings"]
  },
  { label: "Documentation", icon: DocsIcon }
] as const;

export interface NavItem {
  readonly label: string;
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
  readonly href?: string | undefined;
  readonly match?: readonly string[] | undefined;
}

/**
 * Whether `pathname` sits under this item.
 *
 * `"/"` is compared exactly: as a prefix it matches every route in the app, so
 * treating it like the others would light up Overview on every screen.
 */
function isCurrent(pathname: string, match: readonly string[]): boolean {
  return match.some((prefix) =>
    prefix === "/" ? pathname === "/" : pathname.startsWith(prefix)
  );
}

function NavRow({
  item,
  pathname
}: {
  readonly item: NavItem;
  readonly pathname: string;
}) {
  const Icon = item.icon;

  if (item.href === undefined) {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-3 py-2 pr-3 pl-4 text-tertiary"
        title={`${item.label} is not built yet`}
      >
        <Icon />
        <span>{item.label}</span>
        {/*
          THE MARKER EXISTS BECAUSE THE ABSENCE READ AS A BUG.
          Five items that simply did nothing on click were indistinguishable
          from five broken links. Saying "soon" costs one span and converts a
          suspected defect into a stated fact.
        */}
        <span className="ml-auto rounded-xs border border-border-subtle px-1 font-mono text-2xs tracking-wider">
          SOON
        </span>
      </span>
    );
  }

  const current = isCurrent(pathname, item.match ?? [item.href]);

  return (
    <Link
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "flex items-center gap-3 border-l-2 border-accent bg-surface py-2 pl-4 font-medium text-accent-text"
          : "flex items-center gap-3 border-l-2 border-transparent py-2 pl-4 text-secondary transition-colors hover:bg-surface hover:text-primary"
      }
      href={item.href}
    >
      <Icon />
      <span>{item.label}</span>
    </Link>
  );
}

/**
 * The rail's rows.
 *
 * A Client Component, and only this part of the shell is one. The active item
 * is derived from the pathname, which was previously hardcoded to Overview —
 * defensible while every route lived under it, wrong the moment /issues and
 * /runs existed. Keeping it to the rows leaves the surrounding shell, and
 * every screen, a Server Component.
 */
export function NavRail() {
  const pathname = usePathname();

  return (
    <>
      <div className="flex flex-1 flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavRow key={item.label} item={item} pathname={pathname} />
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-1">
        {FOOTER_ITEMS.map((item) => (
          <NavRow key={item.label} item={item} pathname={pathname} />
        ))}
      </div>
    </>
  );
}
