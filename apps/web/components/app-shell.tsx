import type { ReactNode } from "react";

import { Breadcrumbs } from "./breadcrumbs";
import { NavRail } from "./nav-rail";

/**
 * The persistent 240px navigation rail and the content column beside it, per
 * DESIGN.md section 6.
 *
 * A Server Component: only the rail's rows need the pathname to resolve the
 * active item, so only those are a Client Component (see `nav-rail.tsx`). The
 * item list, its labels, and the reason "Analyses" is spelled that way rather
 * than the design's "Crawls" live there too.
 */
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
            {/*
              Reads process.env directly rather than through packages/shared's
              schema, matching how this app already reads WEB_API_URL and
              BASIC_AUTH_* — apps/web isn't a consumer of that zod config.
              Numbers/versions are always mono per docs/DESIGN.md.
            */}
            <p className="font-mono text-2xs text-tertiary">
              v{process.env.APP_VERSION ?? "0.0.0-dev"}
            </p>
          </div>
        </div>

        <NavRail />
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
