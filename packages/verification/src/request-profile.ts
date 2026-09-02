/**
 * How a request is made to look. Ported from the legacy engine's `config.ts`,
 * comments and all, because the comments ARE the evidence.
 *
 * There is no single correct recipe, and that is a measured finding rather than
 * a hedge. The legacy notes record three sites in one family giving three
 * different answers:
 *
 *   - a browser user-agent tripped AWS WAF Bot Control into a CAPTCHA where the
 *     honest crawler UA passed;
 *   - `weareelectromechanicals.com` measured the exact reverse;
 *   - `stackedindustrials.com` refuses a bare request from the egress IP before
 *     it reads a header at all.
 *
 * So neither profile can be "the" default across 650 sites. The honest one is
 * primary because it is the one that has been in production long enough to be
 * measured, and because identifying as what we are is the right default when
 * either might work.
 */

export interface RequestProfile {
  readonly name: string;
  readonly userAgent: string;
  /** Extra headers this profile sends. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Identify as a crawler, NOT as a browser.
 *
 * Ported verbatim, including the version, because a version nobody has tested
 * is not evidence. Impersonating Chrome is what broke sampling behind AWS WAF:
 * a browser UA arriving without browser TLS and header fingerprints trips the
 * Bot Control "non-browser signal" rule, and the load balancer then answers
 * every request — HEAD and GET alike — with 405 plus
 * `x-amzn-waf-action: captcha`. Verified 2026-07-29 against aerooemparts.com,
 * industrialworld360.com and acquireelectrical.com: Chrome UA gave 405 captcha,
 * this UA gave 200/301.
 */
export const CRAWLER_PROFILE: RequestProfile = Object.freeze({
  name: "crawler",
  userAgent: "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)"
});

/**
 * The escalation profile, used ONLY after the honest one is confirmed blocked.
 *
 * NOT interchangeable with {@link CRAWLER_PROFILE}, and the two must never be
 * collapsed: that constant is deliberately the honest crawler UA because a
 * browser UA tripped WAF Bot Control on the sites named above.
 * `stackedindustrials.com` measured the exact reverse — the honest UA gets
 * 403/405 there, and this string plus four `Sec-Fetch-*` headers returns clean
 * 200s.
 *
 * Both findings are real, on sites in the same family, which is why neither can
 * be the single default. The UA string is kept verbatim rather than bumped to a
 * newer Chrome version, for the same reason as above.
 */
export const BROWSER_PROFILE: RequestProfile = Object.freeze({
  name: "browser",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  headers: Object.freeze({
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1"
  })
});

/**
 * The default ladder: try the honest profile, and nothing else.
 *
 * DELIBERATELY ONE RUNG. Escalating to the browser profile per URL is what the
 * legacy engine did before it learned better, and the arithmetic is brutal: a
 * host that refuses everything makes a 1.3-million-URL population pay ~2.6
 * million requests to learn one fact 1.3 million times. At a 25 req/s per-host
 * budget that is days of wall clock for no information.
 *
 * The unit that decides how a request must look is the HOST, so the second rung
 * belongs behind a per-host strategy that negotiates once and remembers — which
 * is a separate milestone. Until it exists, a host that refuses the honest
 * profile is reported as BLOCKED, which is true and cheap, rather than retried
 * into the ground. See the note on {@link ProbeOptions.profileLadder}.
 */
export const DEFAULT_PROFILE_LADDER: readonly RequestProfile[] = Object.freeze([
  CRAWLER_PROFILE
]);

/**
 * Are two profiles the same request?
 *
 * A ladder whose second rung is byte-identical to its first spends a request to
 * get the same answer — exactly the mistake legacy made by reusing the honest
 * UA as its own fallback.
 */
export function isSameProfile(a: RequestProfile, b: RequestProfile): boolean {
  if (a.userAgent !== b.userAgent) {
    return false;
  }

  const aHeaders = a.headers ?? {};
  const bHeaders = b.headers ?? {};
  const keys = new Set([...Object.keys(aHeaders), ...Object.keys(bHeaders)]);

  for (const key of keys) {
    if (aHeaders[key] !== bHeaders[key]) {
      return false;
    }
  }

  return true;
}

/** Headers to send for a profile, including its user-agent. */
export function headersFor(profile: RequestProfile): Record<string, string> {
  return { "user-agent": profile.userAgent, ...(profile.headers ?? {}) };
}
