/**
 * Turning a `<loc>` into the path segments pattern extraction works on.
 *
 * Pure and synchronous, so every decision here is testable without a database,
 * a network, or a sitemap file — which matters because these rules decide what
 * a "pattern" is, and therefore what every downstream number is about.
 */

/** A `<loc>` that resolved to a URL on the site being audited. */
export interface ParsedLoc {
  readonly kind: "matched";
  /** Path plus query, e.g. `/product/123?variant=2`. Never empty. */
  readonly path: string;
  /** Non-empty path segments, e.g. `["product", "123"]`. */
  readonly segments: readonly string[];
  /** The `<loc>` exactly as written, host included. */
  readonly sourceUrl: string;
}

/**
 * A `<loc>` pointing at a different host.
 *
 * Kept as a distinct outcome rather than dropped, because a sitemap full of
 * off-domain URLs is itself a finding — usually a botched migration where the
 * old host was never rewritten — and silently discarding them would report the
 * site as having far fewer URLs than it lists.
 */
export interface ForeignLoc {
  readonly kind: "foreign";
  readonly sourceUrl: string;
  readonly detectedHost: string;
}

/** A `<loc>` that is not a usable URL at all. */
export interface UnparseableLoc {
  readonly kind: "unparseable";
  readonly sourceUrl: string;
}

export type LocParseResult = ParsedLoc | ForeignLoc | UnparseableLoc;

/**
 * Compare hosts ignoring a leading `www.`.
 *
 * A sitemap and its site routinely disagree about the label — `example.com`
 * listing `www.example.com` URLs, or the reverse — and treating that as
 * off-domain would flag an entire healthy sitemap as foreign.
 */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./u, "");
}

export function isSameHost(a: string, b: string): boolean {
  return normalizeHost(a) === normalizeHost(b);
}

/**
 * Parse one `<loc>` relative to the site's base URL.
 *
 * Relative `<loc>` values are invalid per the sitemap protocol but appear in
 * the wild often enough to be worth resolving rather than discarding.
 */
export function parseLoc(
  loc: string,
  baseUrl: string,
  expectedHost: string
): LocParseResult {
  const raw = loc.trim();

  if (raw === "") {
    return { kind: "unparseable", sourceUrl: loc };
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    try {
      url = new URL(raw, baseUrl);
    } catch {
      return { kind: "unparseable", sourceUrl: raw };
    }
  }

  if (!isSameHost(url.hostname, expectedHost)) {
    return {
      kind: "foreign",
      sourceUrl: raw,
      detectedHost: normalizeHost(url.hostname)
    };
  }

  const path = `${url.pathname}${url.search}`;

  return {
    kind: "matched",
    path: path === "" ? "/" : path,
    // The query string is deliberately excluded from segments: patterns are
    // about path shape, and folding `?page=2` into the template would explode
    // a single paginated pattern into thousands.
    segments: url.pathname.split("/").filter((segment) => segment !== ""),
    sourceUrl: raw
  };
}
