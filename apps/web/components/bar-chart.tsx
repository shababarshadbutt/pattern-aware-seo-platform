/**
 * A small column chart, drawn by hand.
 *
 * THE FIRST CHART IN THIS APP, and there is no charting library — deliberately.
 * `apps/web` depends on `next`, `react` and `react-dom` and nothing else, and a
 * chart library would arrive with its own colour and type defaults that the
 * token reset in `globals.css` exists to keep out. Twenty lines of SVG using
 * the tokens we already have costs less than overriding a dependency's opinions
 * on every screen.
 *
 * THE CHART IS NOT THE ONLY WAY TO READ THE DATA. It carries `role="img"` with
 * a summarising label, and the same numbers follow in an `sr-only` table — the
 * same reasoning as ADR-0008's confidence band being said as a word rather than
 * reaching the reader through hue alone. A bar height is a channel some readers
 * do not have.
 *
 * Values are COUNTED. Nothing sampled belongs here: a bar cannot carry an
 * interval, so plotting an estimate would strip exactly the uncertainty
 * `<Estimate>` exists to preserve.
 */
export function BarChart({
  bars,
  label,
  caption,
  reference
}: {
  readonly bars: readonly {
    /** Axis label, kept short — this is a tick, not a sentence. */
    readonly label: string;
    readonly value: number;
    /** Optional longer text for the accessible table and the tooltip. */
    readonly title?: string;
  }[];
  /** What the chart as a whole says, for a reader who cannot see it. */
  readonly label: string;
  readonly caption?: string;
  /**
   * A fixed denominator to draw against, when the series has a MEANINGFUL one.
   *
   * Omit it for a distribution — a depth histogram has no natural maximum other
   * than its own largest bucket, so scaling to the series is the honest choice
   * there.
   *
   * Pass it whenever a bar is "N OF something", because scaling such a series
   * to its own maximum lies when the series is flat: seven windows each showing
   * 3 of 8 patterns at low confidence all render at 100%, and the reader sees
   * seven full-height bars and concludes every pattern is low-confidence. That
   * is the D3e degenerate-series rule — a flat series has no vertical range —
   * appearing on a chart that had no way to express it.
   */
  readonly reference?: number;
}) {
  const seriesMax = bars.reduce(
    (highest, bar) => Math.max(highest, bar.value),
    0
  );

  /*
   * Never below the largest bar: a reference smaller than a value it is meant
   * to contain would clip the bar rather than report the disagreement, and a
   * silently clipped bar is worse than a badly-scaled one.
   */
  const max =
    reference === undefined ? seriesMax : Math.max(reference, seriesMax);

  if (bars.length === 0) {
    return <p className="text-sm text-secondary">No data for this run.</p>;
  }

  return (
    <div>
      <div aria-label={label} className="flex h-40 items-end gap-2" role="img">
        {bars.map((bar) => {
          /*
           * A floor of 2% for a NON-ZERO bucket, so "one out of nine million"
           * is never invisible — but zero draws nothing at all.
           *
           * The floor originally applied to every bar, which gave empty
           * buckets a visible hairline and told the reader there were patterns
           * at depths that had none. A bar of height zero and a bar of height
           * "almost zero" mean different things, and only one of them is
           * nothing; drawing them the same way is the presentational form of
           * the §1.5 failure this codebase keeps finding.
           */
          const height =
            bar.value === 0 || max === 0
              ? 0
              : Math.max(2, Math.round((bar.value / max) * 100));

          return (
            <div
              /*
               * `h-full` is load-bearing, not decoration. The row sets
               * `items-end`, so these columns are NOT stretched by the flex
               * container — without an explicit height they collapse to their
               * content, and the bar's percentage height then resolves against
               * nothing and renders zero-high. The chart drew an empty axis.
               */
              className="flex h-full flex-1 flex-col items-center justify-end gap-2"
              key={bar.label}
              title={bar.title ?? `${bar.label}: ${bar.value}`}
            >
              <div
                className="w-full rounded-xs bg-accent transition-[height]"
                style={{ height: `${height}%` }}
              />
              <span className="font-mono text-2xs text-tertiary" data-numeric>
                {bar.label}
              </span>
            </div>
          );
        })}
      </div>

      {caption !== undefined && (
        <p className="mt-3 text-2xs text-tertiary">{caption}</p>
      )}

      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {bars.map((bar) => (
            <tr key={bar.label}>
              <th scope="row">{bar.title ?? bar.label}</th>
              <td>{bar.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
