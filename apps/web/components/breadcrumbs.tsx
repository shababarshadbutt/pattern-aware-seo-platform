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
  }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-secondary">
      <ol className="flex flex-wrap items-center gap-1.5">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
            {index > 0 && <span className="text-tertiary">/</span>}
            {item.href ? (
              <Link href={item.href} className="hover:text-primary hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className="text-primary">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
