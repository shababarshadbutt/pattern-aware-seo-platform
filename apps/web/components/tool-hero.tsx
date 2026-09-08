import type { ReactNode } from "react";

import { TONE_VAR, type Tone } from "../lib/status";

/**
 * The Stitch Tools screen's featured panel — the tool you are currently using,
 * pulled out above the catalogue.
 *
 * The design fills this slot with an "Instant Single URL Live Inspector": an
 * accent-filled icon tile, a name with a version badge, a description, a
 * right-aligned target chip, then a control row, then a row of four result
 * tiles. Every one of those parts is kept. What changes is what goes in them,
 * because the design's hero tool would need an outbound HTTP request and this
 * API makes none — see `lib/tools-catalog.ts`, where that tool appears as the
 * first card of the section explaining why.
 *
 * So the slot holds whichever of this platform's real calculators is loaded,
 * and the four tiles report what that calculator actually computed. They are
 * COUNTED figures only, like the KPI cards they echo: an estimate belongs in
 * `<Estimate>` with its interval (ADR-0008), never in a tile.
 */

export function ToolHero({
  icon: Icon,
  name,
  badge,
  description,
  metaLabel,
  metaValue,
  controls,
  tiles
}: {
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
  readonly name: string;
  /** The design's small version chip beside the title. */
  readonly badge: string;
  readonly description: string;
  /** The design's "Target Node:" pair, right-aligned on the header row. */
  readonly metaLabel: string;
  readonly metaValue: string;
  readonly controls: ReactNode;
  /**
   * Rendered only when there is something to report.
   *
   * Absent before the reader has submitted anything, rather than shown as four
   * dashes or four zeros: a tile row of placeholder values is the design's
   * "inspection ran" state borrowed for a screen where nothing has run, and
   * zero draws nothing (DESIGN.md section 9).
   */
  readonly tiles?: readonly HeroTile[] | undefined;
}) {
  return (
    <section className="mt-5 rounded-md border border-border-subtle bg-surface-raised">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          {/*
            The fill indigo carrying a glyph at its intended contrast — the same
            role the rail's logo tile uses, and the reason `--accent` and
            `--accent-text` are two tokens (DESIGN.md section 3).
          */}
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm bg-accent text-accent-foreground"
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-primary">
                {name}
              </h2>
              <span className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs tracking-wider text-accent-text">
                {badge}
              </span>
            </div>
            <p className="mt-1 max-w-prose text-sm text-secondary">
              {description}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
            {metaLabel}
          </span>
          <span className="rounded-xs border border-border-subtle bg-base px-2 py-1 font-mono text-2xs text-secondary">
            {metaValue}
          </span>
        </div>
      </div>

      <div className="px-5 py-5">{controls}</div>

      {tiles !== undefined && tiles.length > 0 && (
        <div className="grid gap-3 border-t border-border-subtle px-5 py-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          {tiles.map((tile) => (
            <HeroTileBox key={tile.label} tile={tile} />
          ))}
        </div>
      )}
    </section>
  );
}

export interface HeroTile {
  readonly label: string;
  readonly value: string;
  /**
   * Colours the value AND is already said by the value itself.
   *
   * The confidence tile is the case this exists for: the band is rendered as
   * the word "approximate", tinted — never as a colour alone (DESIGN.md
   * section 8).
   */
  readonly tone?: Tone;
  readonly title?: string;
  readonly icon?: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
}

function HeroTileBox({ tile }: { readonly tile: HeroTile }) {
  return (
    <div
      className="rounded-sm border border-border-subtle bg-base px-3 py-3"
      title={tile.title}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
          {tile.label}
        </span>
        {tile.icon !== undefined && (
          <span aria-hidden="true" className="shrink-0 text-tertiary">
            <tile.icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div
        className="mt-2 font-mono text-base tabular-nums"
        data-numeric
        style={{
          color:
            tile.tone === undefined
              ? "var(--text-primary)"
              : TONE_VAR[tile.tone]
        }}
      >
        {tile.value}
      </div>
    </div>
  );
}
