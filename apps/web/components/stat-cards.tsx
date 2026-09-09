import type { ReactNode } from "react";

import { TONE_VAR, type Tone } from "../lib/status";

/**
 * The KPI row at the top of a screen — bordered cards, one per figure.
 *
 * Replaces the previous hairline "stat strip" (ADR-0027). The spec this
 * supersedes rejected KPI cards by name; the Stitch design uses them, so they
 * are what the product uses now.
 *
 * Values arrive pre-formatted as strings because every caller already holds a
 * formatted figure — and because a card must never be handed a raw sampled
 * number: an estimate belongs in `<Estimate>`, which carries its interval
 * (ADR-0008). These cards are for counted quantities.
 */
export function StatCards({
  stats
}: {
  readonly stats: readonly {
    readonly label: string;
    readonly value: string;
    /**
     * A short qualifier beside the value — a trend, or a call to attention.
     *
     * Optional and additive, so the five screens that predate it are
     * unchanged. It exists because the design pairs a figure with a chip that
     * says what to make of it, and a bare number cannot say "this needs
     * looking at" without one.
     */
    readonly chip?: { readonly text: string; readonly tone: Tone };
    /** Outlines the card, for the one figure a screen wants read first. */
    readonly emphasis?: Tone;
    /** Hover text — use it where a label could be read as a different metric. */
    readonly title?: string;
    /**
     * A glyph in the card's top-right, as the design places one.
     *
     * Decoration only — it is `aria-hidden` and never the sole carrier of
     * meaning, since the label already says what the figure is.
     */
    readonly icon?: (props: {
      readonly className?: string | undefined;
    }) => ReactNode;
  }[];
}) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-md border bg-surface-raised px-4 py-3"
          style={
            stat.emphasis === undefined
              ? { borderColor: "var(--border-subtle)" }
              : { borderColor: TONE_VAR[stat.emphasis] }
          }
          title={stat.title}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="font-mono text-2xs uppercase tracking-wider text-tertiary">
              {stat.label}
            </div>
            {stat.icon !== undefined && (
              <span aria-hidden="true" className="shrink-0 text-tertiary">
                <stat.icon className="h-4 w-4" />
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <span
              className="font-mono text-xl leading-none tabular-nums text-primary"
              data-numeric
            >
              {stat.value}
            </span>
            {stat.chip !== undefined && (
              /*
                Said as a word AND coloured, never coloured alone — the same
                rule the confidence band follows (DESIGN.md section 8).
              */
              <span
                className="font-mono text-2xs whitespace-nowrap"
                style={{ color: TONE_VAR[stat.chip.tone] }}
              >
                {stat.chip.text}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
