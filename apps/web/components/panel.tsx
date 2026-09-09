import type { ReactNode } from "react";

/**
 * A bordered surface holding a titled group of controls or rows.
 *
 * The Stitch design's Project Settings screen is two of these side by side —
 * "Target Configuration" and "Project Metadata" — and nothing in this app had a
 * card container before, because every screen until now was a table. Radius
 * `md` (8px) is the design's card radius; the fill is one step above the page so
 * an input filled with `bg-base` reads as recessed inside it.
 *
 * Not to be confused with `StatCards`, which frames a single counted figure.
 * This is a container for content.
 */
export function Panel({
  title,
  children,
  footer
}: {
  /** Rendered in the design's small-caps label treatment when given. */
  readonly title?: string;
  readonly children: ReactNode;
  /** Right-aligned actions row, divided from the body. */
  readonly footer?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border-subtle bg-surface-raised">
      {title !== undefined && (
        <h3 className="border-b border-border-subtle px-5 py-4 text-base font-semibold tracking-tight text-primary">
          {title}
        </h3>
      )}
      <div className="px-5 py-5">{children}</div>
      {footer !== undefined && (
        <div className="flex items-center justify-end gap-3 border-t border-border-subtle px-5 py-4">
          {footer}
        </div>
      )}
    </section>
  );
}
