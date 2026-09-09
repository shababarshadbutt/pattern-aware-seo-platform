/**
 * A labelled proportion bar — the design's connectivity rows.
 *
 * CSS width rather than SVG, because that is all a single proportion needs, and
 * because the value is always shown as a number beside it: the bar is a second
 * channel for a figure the reader can already read, never the only one.
 *
 * The value is COUNTED. A sampled figure belongs in `<Estimate>` with its
 * interval — a bar has no way to draw one, so filling it from an estimate would
 * present uncertainty as precision.
 */
export function Meter({
  label,
  value,
  max,
  formatted,
  tone = "accent"
}: {
  readonly label: string;
  readonly value: number;
  /** The denominator the bar is drawn against — usually the largest row. */
  readonly max: number;
  /** The number as the reader should see it, already grouped. */
  readonly formatted: string;
  readonly tone?: "accent" | "muted";
}) {
  /*
   * ZERO DRAWS NOTHING. The 2% floor exists so "one in nine million" stays
   * visible, but applied to a zero it invents a bar for a value that is not
   * there — reporting requests that were never sent, or files that do not
   * exist. `BarChart`, `StackedBar` and `Donut` all guard this; `Meter` was the
   * surviving exception to the D3d rule, found when the Analytics screen put a
   * legitimately-zero figure through it.
   */
  const share =
    max <= 0 || value <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span
          className="truncate font-mono text-xs text-secondary"
          title={label}
        >
          {label}
        </span>
        <span
          className="shrink-0 font-mono text-xs tabular-nums text-primary"
          data-numeric
        >
          {formatted}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-xs bg-surface-high">
        <div
          className={
            tone === "accent"
              ? "h-full rounded-xs bg-accent"
              : "h-full rounded-xs bg-border-strong"
          }
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}
