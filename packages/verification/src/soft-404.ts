/**
 * Detecting a page that returns 200 but is really a not-found page.
 *
 * This is the finding the product is uniquely good at: a hard 404 is something
 * a client can find with any crawler, whereas a soft 404 looks healthy to every
 * status-code check and quietly keeps a useless URL in the index. It is also
 * the reason a GET is ever escalated to — the status says fine and the body
 * does not, and the body is what a search engine reads.
 */

/**
 * Phrases that mark a page as a not-found landing page.
 *
 * Ported from the legacy engine's `softNotFound.ts`, which is the single source
 * of truth there and is consumed by both the sampler and the fix UI so the two
 * cannot drift.
 */
export const SOFT_404_TEXT_SIGNALS: readonly string[] = Object.freeze([
  "no entity selected",
  "page not found",
  "404",
  "not found",
  "no results",
  "no data found",
  "does not exist"
]);

/**
 * Signals that must match as a WHOLE WORD rather than as a substring.
 *
 * DELIBERATE DEVIATION from the legacy body matcher, which uses a plain
 * `includes` for every signal. That means any 200 page whose markup contains
 * the characters `404` anywhere is classified as a soft 404 — and on the sites
 * this product audits, part numbers and SKUs are full of digits. A healthy
 * product page for `SKU-40412`, or one listing a `404` in a table of
 * measurements, would be reported as a not-found page.
 *
 * That matters more here than it did there, because a soft 404 now carries
 * severity 0.9 (ADR-0014) and feeds the impact score directly, so a false
 * positive does not just mislabel a URL — it inflates a published number and
 * pushes a healthy pattern up the triage queue.
 *
 * Legacy already applies exactly this reasoning one layer over, in its URL
 * heuristic: "conservative on the bare 404 signal (standalone token only) so an
 * arbitrary part number containing digits is never flagged." This applies the
 * same rule to the body match.
 */
const WHOLE_WORD_SIGNALS: ReadonlySet<string> = new Set(["404"]);

export interface Soft404Options {
  /**
   * Below this many bytes, a 200 with no other signal is still suspicious.
   *
   * A near-empty body from a URL that is supposed to be a product page is a
   * not-found page that forgot to say so. Reported separately from a phrase
   * match so the two can be told apart.
   */
  readonly shortBodyBytes?: number;
}

export interface Soft404Verdict {
  readonly isSoft404: boolean;
  /** Which phrase matched, when one did. */
  readonly matchedSignal: string | undefined;
  /** True when the body was suspiciously small rather than explicitly saying so. */
  readonly isShortBody: boolean;
}

const DEFAULT_SHORT_BODY_BYTES = 1_000;

function matchesWholeWord(haystack: string, needle: string): boolean {
  // Escaped because a signal could contain regex metacharacters; none do today,
  // and relying on that would be a trap for whoever adds the next one.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

  return new RegExp(`(?<![0-9a-z])${escaped}(?![0-9a-z])`, "iu").test(haystack);
}

/**
 * Judge a fetched body prefix.
 *
 * `bodyPrefix` is the first few kilobytes, not the whole page — that cap is the
 * point (see body-prefix.ts). A not-found page announces itself early; if the
 * only mention of "page not found" is 200 KB down, the page has bigger problems
 * than this check.
 *
 * `wasTruncated` matters for the short-body signal specifically: a truncated
 * body is by definition not short, and treating a 64 KB prefix of a large page
 * as "suspiciously small" would flag every healthy page on the site.
 */
export function detectSoft404(
  bodyPrefix: string,
  input: { readonly bytesRead: number; readonly wasTruncated: boolean },
  options: Soft404Options = {}
): Soft404Verdict {
  const lowered = bodyPrefix.toLowerCase();

  let matchedSignal: string | undefined;

  for (const signal of SOFT_404_TEXT_SIGNALS) {
    const matched = WHOLE_WORD_SIGNALS.has(signal)
      ? matchesWholeWord(lowered, signal)
      : lowered.includes(signal);

    if (matched) {
      matchedSignal = signal;
      break;
    }
  }

  const isShortBody =
    !input.wasTruncated &&
    input.bytesRead < (options.shortBodyBytes ?? DEFAULT_SHORT_BODY_BYTES);

  return {
    isSoft404: matchedSignal !== undefined || isShortBody,
    matchedSignal,
    isShortBody
  };
}
