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
  }[];
}) {
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-md border border-border-subtle bg-surface-raised px-4 py-3"
        >
          <div className="font-mono text-2xs uppercase tracking-wider text-tertiary">
            {stat.label}
          </div>
          <div
            className="mt-2 font-mono text-xl leading-none tabular-nums text-primary"
            data-numeric
          >
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
