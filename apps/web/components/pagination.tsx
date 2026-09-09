import Link from "next/link";
import { formatCount } from "../lib/format";
import type { PageWindow } from "../lib/projects";

/**
 * The Stitch table footer: a row range on the left, prev/next on the right.
 *
 * LINKS, NOT BUTTONS, for the reason `Tabs` and the tool filters are links —
 * the page it moves to is a Server Component reading different rows, so a
 * `?page=` param keeps the whole screen server-rendered and makes page 3
 * shareable and back-button-correct.
 *
 * The design also shows numbered page chips (1 2 3 4). Those are omitted
 * deliberately rather than because they are hard: a numbered set has to decide
 * how many to show and when to elide, and with a fleet of two the honest
 * rendering is a single chip that does nothing. Prev/next carries the same
 * capability at every fleet size.
 *
 * WHAT IT COUNTS IS NAMED. The design's footer reads "Showing 1-5 of 18
 * tracked projects" — every project on the account, which is what this one
 * counts too, since `site` is one row per monitored domain. Where a footer
 * counts something narrower than the reader assumes, the noun has to say so:
 * the run explorer's says "sampled URLs" because presenting a sample as a
 * census is the one claim this product must never make (DESIGN.md 7.2).
 */
export function Pagination({
  window: page,
  noun,
  href
}: {
  readonly window: PageWindow;
  /** Plural noun for what is being counted, e.g. "tracked projects". */
  readonly noun: string;
  /** Builds the URL for a page number, preserving every other filter. */
  readonly href: (page: number) => string;
}) {
  const shape =
    "rounded-sm border border-border-subtle px-3 py-1.5 font-mono text-2xs tracking-wider uppercase transition-colors";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-3 py-3">
      <p className="font-mono text-2xs text-tertiary">
        Showing{" "}
        <span className="text-primary" data-numeric>
          {formatCount(page.from)}&ndash;{formatCount(page.to)}
        </span>{" "}
        of{" "}
        <span className="text-primary" data-numeric>
          {formatCount(page.total)}
        </span>{" "}
        {noun}
      </p>

      <div className="flex items-center gap-2">
        {page.hasPrevious ? (
          <Link
            className={`${shape} text-secondary hover:border-border-strong hover:text-primary`}
            href={href(page.page - 1)}
          >
            &larr; Prev
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={`${shape} cursor-not-allowed text-tertiary`}
          >
            &larr; Prev
          </span>
        )}
        <span className="rounded-sm bg-accent px-3 py-1.5 font-mono text-2xs text-accent-foreground">
          {page.page}
        </span>
        {page.hasNext ? (
          <Link
            className={`${shape} text-secondary hover:border-border-strong hover:text-primary`}
            href={href(page.page + 1)}
          >
            Next &rarr;
          </Link>
        ) : (
          <span
            aria-disabled="true"
            className={`${shape} cursor-not-allowed text-tertiary`}
          >
            Next &rarr;
          </span>
        )}
      </div>
    </div>
  );
}
