import Link from "next/link";

/**
 * Text breadcrumb trail for the drill-down stack (DESIGN.md section 6:
 * "Enterprise -> Site -> Pattern -> Sample is a breadcrumb-tracked navigation
 * stack"). The full command palette and left rail are out of scope for this
 * first vertical slice; this is the minimum that keeps drill-down navigable
 * without them.
 */
export function Breadcrumbs({
  items
}: {
  readonly items: readonly {
    readonly label: string;
    readonly href?: string;
    /**
     * Render this crumb in the mono face.
     *
     * DESIGN.md section 2 puts "every numeric value, URL, pattern string,
     * status code" in JetBrains Mono. A pattern template is a pattern string
     * wherever it appears, and it was rendering in the UI sans here while the
     * same string on the same page got `font-mono` in the heading — the two
     * read as different values.
     */
    readonly mono?: boolean;
  }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-secondary">
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((item, index) => (
          // Keyed on href, falling back to the label for the final unlinked
          // crumb: an index key makes React reuse the wrong node when a trail
          // gains or loses a level.
          <li key={item.href ?? item.label} className="flex items-center gap-2">
            {index > 0 && (
              <span aria-hidden="true" className="text-tertiary">
                ›
              </span>
            )}
            {item.href ? (
              <Link
                href={item.href}
                className={`hover:text-primary hover:underline${item.mono ? " font-mono text-xs" : ""}`}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={`text-primary${item.mono ? " font-mono text-xs" : ""}`}
              >
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
