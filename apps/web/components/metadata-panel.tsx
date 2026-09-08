import type { ReactNode } from "react";

/**
 * The design's right-hand metadata card: label on the left, value on the right,
 * one hairline between rows.
 *
 * Distinct from `DefinitionGrid`, which lays figures out in columns for a wide
 * area. This is a narrow sidebar list, and the design uses it for the facts
 * about a project rather than for measurements — an id, a created date, a
 * status. Values are right-aligned so they form a column against the card edge.
 *
 * Every value here is a stored fact, not a sampled figure, so `<Estimate>` is
 * not involved. A row may carry a badge instead of text, which is how the
 * design renders Status.
 */
export function MetadataPanel({
  title,
  rows
}: {
  readonly title: string;
  readonly rows: readonly {
    readonly label: string;
    readonly value: ReactNode;
    /** Render the value in the mono face — for ids and timestamps. */
    readonly mono?: boolean;
    readonly title?: string;
  }[];
}) {
  return (
    // `self-start` so the card hugs its rows rather than stretching to the
    // height of whatever sits beside it in the grid — the design's metadata
    // card is short, and a tall empty box reads as content that failed to load.
    <section className="self-start rounded-md border border-border-subtle bg-surface-raised">
      <h3 className="border-b border-border-subtle px-5 py-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary">
        {title}
      </h3>
      <dl>
        {rows.map((row, index) => (
          <div
            key={row.label}
            className={`flex items-center justify-between gap-4 px-5 py-4${
              index === rows.length - 1 ? "" : " border-b border-border-subtle"
            }`}
          >
            <dt className="text-sm text-secondary">{row.label}</dt>
            <dd
              className={
                row.mono === true
                  ? "truncate text-right font-mono text-xs tabular-nums text-primary"
                  : "truncate text-right text-sm text-primary"
              }
              data-numeric={row.mono === true ? true : undefined}
              title={row.title}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
