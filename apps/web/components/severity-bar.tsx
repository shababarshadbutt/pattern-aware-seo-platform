import type { SeverityClassName } from "../lib/api";
import { severityTone, TONE_VAR } from "../lib/status";

/**
 * A table-cell-sized proportion bar over a site's findings by severity.
 *
 * WHY NOT `StackedBar`. That component renders a legend beneath the bar, which
 * is right for a panel and impossible in a table row. This is the same idea at
 * cell scale, with the numbers printed beside the bar instead of under it —
 * because the rule those two share is the one that matters: the proportions
 * are never the only channel (DESIGN.md section 7.2).
 *
 * WHAT IT IS NOT is the design's health-score bar. The Stitch portfolio puts a
 * progress bar and "94/100" in this column; this platform computes no such
 * score, and a bar drawn from an invented composite would be the most
 * confident-looking thing on the screen and the only figure on it with no
 * definition. This bar is a breakdown of counted findings — nine of them split
 * four ways — and its label says so (ADR-0037).
 *
 * ZERO DRAWS NOTHING: a severity class with no findings is dropped rather than
 * given a minimum width, so the bar never shows an outcome that did not occur.
 * A site with no findings at all renders no bar, not an empty track — see the
 * caller, which distinguishes "nothing found" from "never measured".
 */
export function SeverityBar({
  segments,
  total,
  critical
}: {
  readonly segments: readonly {
    readonly severityClass: SeverityClassName;
    readonly count: number;
  }[];
  readonly total: number;
  /**
   * Findings this platform treats as damage.
   *
   * Passed in rather than recomputed from `segments`. The API already decided
   * which classes count, excluding `blocked` and `unknown` because a host
   * refusing us is not a site defect — re-deriving it here would be a second
   * definition of "critical", free to drift from the one the KPI card totals.
   */
  readonly critical: number;
}) {
  const drawn = [...segments]
    .filter((segment) => segment.count > 0)
    .sort((a, b) => b.count - a.count);

  if (total === 0 || drawn.length === 0) {
    return null;
  }

  const summary = drawn
    .map(
      (segment) =>
        `${segment.count} ${segment.severityClass.replaceAll("_", " ")}`
    )
    .join(", ");

  return (
    <div className="flex items-center gap-3">
      <div
        aria-label={`${total} findings by severity: ${summary}`}
        className="flex h-2 w-24 shrink-0 overflow-hidden rounded-xs bg-surface-high"
        role="img"
      >
        {drawn.map((segment) => (
          <div
            key={segment.severityClass}
            style={{
              backgroundColor: TONE_VAR[severityTone(segment.severityClass)],
              width: `${(segment.count / total) * 100}%`
            }}
            title={`${segment.severityClass.replaceAll("_", " ")}: ${segment.count}`}
          />
        ))}
      </div>

      {/*
        THE BAR IS NEVER THE ONLY CHANNEL, but a full breakdown printed in a
        table cell wraps to three lines and makes every row tall — which is how
        the first version rendered. So the visible text is the two figures a
        reader scanning a fleet is actually comparing, the hover carries each
        class, and the `sr-only` line carries the whole breakdown so nothing is
        reachable by colour alone.
      */}
      <span className="font-mono text-2xs whitespace-nowrap text-tertiary">
        <span className="text-primary" data-numeric>
          {critical}
        </span>{" "}
        critical of <span data-numeric>{total}</span>
      </span>
      <span className="sr-only">Breakdown: {summary}.</span>
    </div>
  );
}
