import Link from "next/link";

/**
 * The Stitch design's tab row: labels on a hairline, the active one carrying an
 * indigo underline.
 *
 * Tabs are LINKS, not client state. The panels they switch between are Server
 * Components reading different data, so a `?tab=` search param keeps the whole
 * screen server-rendered and makes a tab shareable and back-button-correct. A
 * client-side toggle would have forced the platform-limits table into the
 * browser for no gain.
 *
 * A tab with no screen behind it renders disabled with the same `SOON` marker
 * the navigation rail uses — the design's tab row includes Integrations, Team &
 * Roles and API & Webhooks, and this platform has no user, member, role, API-key
 * or webhook table at all. The rule is the rail's rule (DESIGN.md §6): a control
 * that navigates nowhere is a worse lie than one that says plainly it is not
 * built.
 */
export function Tabs({
  items
}: {
  readonly items: readonly {
    readonly label: string;
    /** Omitted when the tab has nothing behind it yet. */
    readonly href?: string;
    readonly current?: boolean;
  }[];
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="border-b border-border-subtle"
    >
      <ul className="-mb-px flex flex-wrap items-center gap-6">
        {items.map((item) => (
          <li key={item.label}>
            {item.href === undefined ? (
              <span
                aria-disabled="true"
                className="flex cursor-not-allowed items-center gap-2 border-b-2 border-transparent pb-3 text-sm text-tertiary"
                title={`${item.label} is not built yet`}
              >
                {item.label}
                <span className="rounded-xs border border-border-subtle px-1 font-mono text-2xs tracking-wider">
                  SOON
                </span>
              </span>
            ) : (
              <Link
                aria-current={item.current ? "page" : undefined}
                className={
                  item.current
                    ? "block border-b-2 border-accent pb-3 text-sm font-medium text-accent-text"
                    : "block border-b-2 border-transparent pb-3 text-sm text-secondary transition-colors hover:border-border-strong hover:text-primary"
                }
                href={item.href}
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
