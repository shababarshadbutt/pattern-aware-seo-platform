/**
 * A labelled grid of COUNTED figures — the shape the pattern page's "latest
 * sample" block established.
 *
 * Extracted because three screens now need it (sample parameters, run sampling
 * health on the run detail, and the same health block on a site overview) and
 * the markup was already duplicated once inline. A change to how a figure is
 * labelled should not have to be made in three places to stay consistent.
 *
 * NOT for sampled numbers. Every value here renders bare, with no interval and
 * no `~`, so an estimate in one of these slots would violate ADR-0008 — that is
 * what `<Estimate>` is for. `lib/adr-0008-guard.test.ts` fails the build if a
 * screen reaches for an estimate's fields outside that component, which is the
 * enforcement rather than this comment.
 */
export function DefinitionGrid({
  items,
  columns = 4
}: {
  readonly items: readonly {
    readonly label: string;
    readonly value: string;
    /** Rendered in the UI sans instead of mono — for words, not figures. */
    readonly prose?: boolean;
    readonly title?: string;
  }[];
  readonly columns?: 3 | 4;
}) {
  return (
    <dl
      className={`grid grid-cols-2 gap-x-8 gap-y-3 text-sm ${
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"
      }`}
    >
      {items.map((item) => (
        <div key={item.label}>
          <dt className="font-mono text-2xs uppercase tracking-wider text-tertiary">
            {item.label}
          </dt>
          <dd
            className={
              item.prose
                ? "mt-1 text-xs text-primary"
                : "mt-1 font-mono text-xs tabular-nums text-primary"
            }
            data-numeric={item.prose ? undefined : true}
            title={item.title}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
