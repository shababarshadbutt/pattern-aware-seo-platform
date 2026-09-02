/**
 * Maximum digits a run collapses to.
 *
 * Ported from the legacy engine. Past this, a longer run stops producing new
 * shapes, which bounds the histogram on pathological numeric ids — otherwise a
 * site with 40-digit identifiers would generate a distinct stratum per length
 * and the strata would outnumber anything worth reporting.
 */
const MAX_DIGIT_RUN = 12;

const ZERO = 48;
const NINE = 57;
const UPPER_A = 65;
const UPPER_Z = 90;
const LOWER_A = 97;
const LOWER_Z = 122;

function isDigit(code: number): boolean {
  return code >= ZERO && code <= NINE;
}

function isLetter(code: number): boolean {
  return (
    (code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z)
  );
}

/**
 * Reduce a string to its shape: digit runs become `9` repeated their own
 * length, letter runs become a single `a`, and separators are kept verbatim.
 *
 * Ported verbatim in behaviour from the legacy engine's `valueShape`, which is
 * the basis of its shape-stratified verification. The choices are load-bearing
 * and worth restating:
 *
 *   - DIGIT RUN LENGTH IS PRESERVED, letter run length is not. That asymmetry
 *     is the point. Length is what separates `nsn-parts-12191` from
 *     `nsn-parts-6492` — different id generations, often different CMS
 *     templates, and frequently one migrated while the other did not. Letter
 *     runs carry no such signal, so collapsing them keeps the histogram small.
 *   - Separators survive, so `/a/a-a-99999/` and `/a/a_a_99999/` are different
 *     shapes. They usually come from different generators.
 *
 * The result is a stratum label: URLs sharing a shape usually come from one
 * template, so a sample of a shape tends to answer for the whole shape. That is
 * what turns 579,034 requests into roughly 1,150 — the measured figure from the
 * legacy engine's own migration notes.
 */
export function valueShape(value: string): string {
  let out = "";
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (isDigit(code)) {
      const start = index;

      do {
        index += 1;
      } while (index < value.length && isDigit(value.charCodeAt(index)));

      out += "9".repeat(Math.min(index - start, MAX_DIGIT_RUN));

      continue;
    }

    if (isLetter(code)) {
      do {
        index += 1;
      } while (index < value.length && isLetter(value.charCodeAt(index)));

      out += "a";

      continue;
    }

    out += value[index];
    index += 1;
  }

  return out;
}

/**
 * The shape of a path.
 *
 * Takes a path rather than a URL because that is what the ingestion pass has in
 * hand — and because the shape must be derivable identically at collection time
 * and at resolution time, or a stratum count and its sample would be about
 * different things.
 */
export function pathShape(path: string): string {
  const queryStart = path.indexOf("?");

  // The query string is excluded, matching how patterns are derived from path
  // segments alone. Including it would explode a single paginated shape into
  // one per page.
  return valueShape(queryStart === -1 ? path : path.slice(0, queryStart));
}

/**
 * Group values by shape, largest group first.
 *
 * Pure, so the stratification decision is testable without a sitemap, a
 * database, or a network.
 */
export function groupByShape(
  values: Iterable<string>
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();

  for (const value of values) {
    const shape = pathShape(value);

    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }

  return new Map(
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )
  );
}
