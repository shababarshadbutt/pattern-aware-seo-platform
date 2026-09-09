import { TONE_VAR, type Tone } from "../lib/status";

export interface StackedSegment {
  readonly label: string;
  readonly value: number;
  readonly tone: Tone;
  /** A second figure for the legend — the URLs a status covers, say. */
  readonly secondary?: string;
}

/**
 * One proportion bar split into tone-coloured segments, with a legend.
 *
 * Replaces a list of badges. A reader looking at a run wants to know how its
 * patterns DIVIDE, and a stack answers that at a glance where a column of
 * counts makes them do the arithmetic.
 *
 * ZERO DRAWS NOTHING — a status with no patterns is dropped rather than given a
 * minimum width, so the bar never shows an outcome that did not occur.
 *
 * The proportions are never the only channel: every segment's label and count
 * appear in the legend beneath, and an `sr-only` table repeats them.
 */
export function StackedBar({
  segments,
  label
}: {
  readonly segments: readonly StackedSegment[];
  readonly label: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const drawn = segments.filter((segment) => segment.value > 0);

  if (total === 0) {
    return <p className="text-sm text-secondary">Nothing to break down yet.</p>;
  }

  return (
    <div>
      <div
        aria-label={label}
        className="flex h-3 w-full overflow-hidden rounded-xs bg-surface-high"
        role="img"
      >
        {drawn.map((segment) => (
          <div
            key={segment.label}
            style={{
              backgroundColor: TONE_VAR[segment.tone],
              width: `${(segment.value / total) * 100}%`
            }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {drawn.map((segment) => (
          <li
            className="flex items-center justify-between gap-3"
            key={segment.label}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-xs"
                style={{ backgroundColor: TONE_VAR[segment.tone] }}
              />
              <span className="truncate font-mono text-2xs uppercase tracking-wider text-secondary">
                {segment.label.replace(/_/g, " ")}
              </span>
            </span>
            <span
              className="shrink-0 font-mono text-2xs tabular-nums text-primary"
              data-numeric
            >
              {segment.value}
              {segment.secondary !== undefined && (
                <span className="ml-2 text-tertiary">{segment.secondary}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Patterns</th>
          </tr>
        </thead>
        <tbody>
          {drawn.map((segment) => (
            <tr key={segment.label}>
              <th scope="row">{segment.label}</th>
              <td>{segment.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
