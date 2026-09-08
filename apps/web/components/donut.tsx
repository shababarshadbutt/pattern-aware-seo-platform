import { TONE_VAR, type Tone } from "../lib/status";

export interface DonutSegment {
  readonly label: string;
  readonly value: number;
  readonly tone: Tone;
  /** Longer text for the accessible table and the hover title. */
  readonly title?: string;
}

/**
 * A proportion ring with a counted legend.
 *
 * Drawn with one `<circle>` per segment using `stroke-dasharray` and an offset
 * — no path arithmetic and no library, which is what `docs/DESIGN.md` asks for.
 *
 * ZERO DRAWS NOTHING. A segment with no probes is skipped rather than given a
 * minimum arc: a sliver where there is no data reports an outcome that did not
 * occur, which is the presentational form of the silent-failure rule.
 *
 * The ring is never the only channel. `role="img"` carries a summarising label,
 * the legend states every count in words and figures, and an `sr-only` table
 * repeats them — an arc is a channel some readers do not have.
 *
 * COUNTED VALUES ONLY. An arc cannot carry an interval, so a sampled figure
 * belongs in `<Estimate>` rather than here.
 */
export function Donut({
  segments,
  label,
  centreValue,
  centreLabel
}: {
  readonly segments: readonly DonutSegment[];
  readonly label: string;
  /** The headline figure beside the ring, already formatted. */
  readonly centreValue: string;
  readonly centreLabel: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const drawn = segments.filter((segment) => segment.value > 0);

  if (total === 0) {
    return (
      <p className="text-sm text-secondary">No probes recorded for this run.</p>
    );
  }

  // r = 42 inside a 100 box, so the circumference is the whole dash budget.
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg
        aria-label={label}
        className="h-28 w-28 shrink-0 -rotate-90"
        role="img"
        viewBox="0 0 100 100"
      >
        {drawn.map((segment) => {
          const dash = (segment.value / total) * circumference;
          const offset = -consumed;

          consumed += dash;

          return (
            <circle
              cx="50"
              cy="50"
              fill="none"
              key={segment.label}
              r={radius}
              stroke={TONE_VAR[segment.tone]}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={offset}
              strokeWidth="12"
            >
              <title>
                {segment.title ?? `${segment.label}: ${segment.value}`}
              </title>
            </circle>
          );
        })}
      </svg>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div>
          <div
            className="font-mono text-xl leading-none tabular-nums text-primary"
            data-numeric
          >
            {centreValue}
          </div>
          <div className="mt-1 font-mono text-2xs uppercase tracking-wider text-tertiary">
            {centreLabel}
          </div>
        </div>

        <ul className="flex flex-col gap-1.5">
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
                <span className="truncate font-mono text-2xs text-secondary">
                  {segment.label}
                </span>
              </span>
              <span
                className="shrink-0 font-mono text-2xs tabular-nums text-primary"
                data-numeric
              >
                {segment.value}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">Probes</th>
          </tr>
        </thead>
        <tbody>
          {drawn.map((segment) => (
            <tr key={segment.label}>
              <th scope="row">{segment.title ?? segment.label}</th>
              <td>{segment.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
