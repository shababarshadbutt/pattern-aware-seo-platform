/**
 * A single thin, persistent stat strip — a horizontal row of label/value
 * pairs separated by hairline dividers, no card chrome. DESIGN.md section 7
 * rejects the "row of 4 KPI cards" layout by name; this is the replacement.
 */
export function StatStrip({
  stats
}: {
  readonly stats: readonly {
    readonly label: string;
    readonly value: string;
  }[];
}) {
  return (
    <div className="flex divide-x divide-border-subtle border-y border-border-subtle">
      {stats.map((stat) => (
        <div key={stat.label} className="flex-1 px-4 py-3">
          <div
            className="font-mono text-2xl leading-none tabular-nums"
            data-numeric
          >
            {stat.value}
          </div>
          <div className="mt-1 font-mono text-2xs uppercase tracking-wider text-tertiary">
            {stat.label}
          </div>
        </div>
      ))}
    </div>
  );
}
