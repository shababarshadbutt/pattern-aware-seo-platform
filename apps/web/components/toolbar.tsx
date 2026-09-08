import Link from "next/link";
import type { ReactNode } from "react";

import { SearchIcon } from "./icons";

/**
 * The Stitch Tools screen's header actions and its filter row.
 *
 * HEADER ACTIONS sit opposite the title, per DESIGN.md section 7.2, and an
 * action with no endpoint renders inert with its reason in a `title` — the same
 * rule the rail follows for an item with no screen. The design shows "Batch
 * Execution" and "API Endpoints"; one of those describes a job dispatcher this
 * platform does not expose, so it is drawn and disabled rather than dropped,
 * because a header with one button no longer reads as the design's header.
 *
 * THE FILTER ROW IS LINKS AND A GET FORM, not client state — the same choice
 * `Tabs` makes and for the same reason: a filtered view stays a Server
 * Component, is shareable, and survives the back button. The pills carry the
 * current query and the loaded tool along with them, so filtering the catalogue
 * never silently discards what the reader typed into the hero above.
 */

export function HeaderAction({
  icon: Icon,
  label,
  href,
  disabledReason
}: {
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
  readonly label: string;
  /** Omitted when there is nothing behind it. */
  readonly href?: string;
  /** Required when `href` is omitted: what is missing, in words. */
  readonly disabledReason?: string;
}) {
  const shape =
    "flex items-center gap-2 rounded-sm border px-3 py-2 text-sm transition-colors";

  if (href === undefined) {
    return (
      <span
        aria-disabled="true"
        className={`${shape} cursor-not-allowed border-border-subtle text-tertiary`}
        title={disabledReason}
      >
        <Icon className="h-4 w-4" />
        {label}
        <span className="rounded-xs border border-border-subtle px-1 font-mono text-2xs tracking-wider">
          SOON
        </span>
      </span>
    );
  }

  return (
    <Link
      className={`${shape} border-border-subtle text-secondary hover:border-border-strong hover:text-primary`}
      href={href}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

/**
 * The design's segmented pill row: one filled with the accent, the rest quiet.
 *
 * The accent fill is exactly the role `--accent` exists for, and the label on
 * it is `--accent-foreground` — never `text-accent`, which is the misuse the
 * two-token split prevents.
 */
export function FilterPills({
  items,
  /**
   * What this row filters, for the accessible name.
   *
   * Defaulted to the Tools wording it was written for, so that screen is
   * unchanged. It is a parameter because a second screen reusing the component
   * would otherwise announce itself as filtering utilities — a label asserting
   * something the code does not do, in the one channel a sighted reader cannot
   * check against the visible pills.
   */
  label = "Filter utilities by category"
}: {
  readonly items: readonly {
    readonly label: string;
    readonly href: string;
    readonly current: boolean;
  }[];
  readonly label?: string;
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap items-center gap-1">
        {items.map((item) => (
          <li key={item.label}>
            <Link
              aria-current={item.current ? "true" : undefined}
              className={
                item.current
                  ? "block rounded-sm bg-accent px-3 py-2 font-mono text-2xs tracking-wider text-accent-foreground uppercase"
                  : "block rounded-sm px-3 py-2 font-mono text-2xs tracking-wider text-tertiary uppercase transition-colors hover:bg-surface hover:text-primary"
              }
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The design's leading search field, with the glyph inside the control. */
export function SearchField({
  name,
  defaultValue,
  placeholder,
  label,
  hidden
}: {
  readonly name: string;
  readonly defaultValue?: string;
  readonly placeholder: string;
  readonly label: string;
  /** Params the search must carry forward, as name/value pairs. */
  readonly hidden?: readonly (readonly [string, string])[];
}) {
  return (
    <>
      {(hidden ?? []).map(([key, value]) => (
        <input key={key} name={key} type="hidden" value={value} />
      ))}
      <div className="relative min-w-[220px] flex-1">
        <label className="sr-only" htmlFor={`search-${name}`}>
          {label}
        </label>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-tertiary"
        >
          <SearchIcon className="h-4 w-4" />
        </span>
        <input
          className="w-full rounded-sm border border-border-subtle bg-base py-2 pr-3 pl-9 text-sm text-primary transition-colors placeholder:text-tertiary hover:border-border-strong focus:border-accent-text"
          defaultValue={defaultValue}
          id={`search-${name}`}
          name={name}
          placeholder={placeholder}
          type="search"
        />
      </div>
    </>
  );
}

/** The design's bottom status strip: dot-separated facts, then quiet links. */
export function StatusStrip({
  facts,
  actions
}: {
  readonly facts: readonly string[];
  readonly actions?: ReactNode;
}) {
  return (
    <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
      <p className="font-mono text-2xs text-tertiary">{facts.join("  ·  ")}</p>
      {actions !== undefined && (
        <div className="flex items-center gap-4">{actions}</div>
      )}
    </footer>
  );
}
