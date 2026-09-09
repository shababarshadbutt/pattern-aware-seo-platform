/**
 * A value over recent runs, drawn as a line.
 *
 * Closes part of the sparkline debt the D3 list has carried since M0, and does
 * it the way `docs/DESIGN.md` requires: inline SVG on existing tokens, no
 * charting dependency, `role="img"` with a summarising label, and an `sr-only`
 * table so the series is readable without the shape.
 *
 * TWO DIVIDE-BY-ZERO TRAPS, both handled rather than discovered:
 * a single point has no horizontal span to spread across, and a FLAT series has
 * no vertical range — a naive `(value - min) / (max - min)` is `0/0` on every
 * point of a site whose URL count has not changed, which is the ordinary case
 * for a stable sitemap. Both draw a centred flat line, which is the truth.
 *
 * Counted values only: a line cannot carry an interval.
 */
export function Sparkline({
  points,
  label
}: {
  readonly points: readonly {
    readonly value: number;
    readonly title: string;
  }[];
  readonly label: string;
}) {
  if (points.length === 0) {
    return (
      <p className="text-sm text-secondary">
        No run history yet — a series needs more than one run.
      </p>
    );
  }

  const width = 100;
  const height = 32;
  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;

  const coordinates = points.map((point, index) => {
    // A single point sits centred rather than at x=0, where it would read as
    // the start of a line that was cut off.
    const x =
      points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    // A flat series sits on the midline: every value is equal, so there is no
    // shape to draw and pretending otherwise would invent a trend.
    const y =
      range === 0
        ? height / 2
        : height - ((point.value - min) / range) * height;

    return { x, y };
  });

  const path = coordinates
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");

  const last = coordinates.at(-1);

  return (
    <div>
      <svg
        aria-label={label}
        className="h-12 w-full"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {points.length > 1 && (
          <path
            d={path}
            fill="none"
            stroke="var(--accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {last !== undefined && (
          <circle cx={last.x} cy={last.y} fill="var(--accent-text)" r="2.5" />
        )}
      </svg>

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.title}>
              <th scope="row">{point.title}</th>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
