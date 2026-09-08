/**
 * One tone-mapping per status domain in the product, all resolving to the
 * same four semantic tones so a badge, a row accent, and a stat-strip number
 * always agree with each other for the same underlying fact (DESIGN.md
 * section 3: "this mapping is product logic, not decoration").
 */

import type { CSSProperties } from "react";
import type {
  ConfidenceBandName,
  FileParseStatus,
  PatternStatus,
  RunStatus,
  SeverityClassName
} from "./api";
import type { ProjectRunState } from "./projects";
import type { Enforcement } from "./settings";
import type { ToolAvailability } from "./tools-catalog";

export type Tone = "healthy" | "warning" | "critical" | "unknown";

export const TONE_VAR: Record<Tone, string> = {
  healthy: "var(--status-healthy)",
  warning: "var(--status-warning)",
  critical: "var(--status-critical)",
  unknown: "var(--status-unknown)"
};

export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case "complete":
      return "healthy";
    case "degraded":
      return "warning";
    case "running":
    case "pending":
      return "unknown";
    case "failed":
    case "cancelled":
      return "critical";
  }
}

export function patternStatusTone(status: PatternStatus): Tone {
  switch (status) {
    case "measured":
      return "healthy";
    case "sampling":
    case "unsampled":
      return "unknown";
    /**
     * A HOST REFUSING US IS NOT A SITE DEFECT.
     *
     * This was `critical`, which is the specific inversion schema/enums.ts
     * warns about by name: "reporting that as a site defect would poison every
     * downstream estimate and impact score", and ADR-0008 gives blocked its
     * own channel precisely so a WAF cannot turn a healthy client into a P0.
     * `severityTone` already maps `blocked` to `unknown`; the two disagreed
     * about the same concept, and the red one was wrong.
     */
    case "blocked":
      return "unknown";
    // A tripped GET-escalation cap, not damage — see schema/enums.ts. Amber,
    // same as "needs attention", not the critical red.
    case "needs_review":
      return "warning";
  }
}

/**
 * A sitemap file's parse state.
 *
 * `failed` is CRITICAL and `skipped` is a WARNING, and the difference matters:
 * a file we could not read means the pattern populations for this run are short
 * by whatever it held, so the run's counts are wrong rather than merely
 * incomplete. `skipped` is a deliberate refusal (an oversize guard, say) — it
 * also undercounts, which is why it is not healthy, but somebody chose it.
 *
 * The in-flight states map to `unknown` rather than healthy for the same reason
 * the rest of this file does: no measurement yet is not a good result.
 */
export function fileParseStatusTone(status: FileParseStatus): Tone {
  switch (status) {
    case "parsed":
      return "healthy";
    case "pending":
    case "downloading":
    case "parsing":
      return "unknown";
    case "skipped":
      return "warning";
    case "failed":
      return "critical";
  }
}

/**
 * A file's tone, which needs its URL COUNT and not only its status.
 *
 * A FILE THAT PARSED CLEANLY AND YIELDED NOTHING IS NOT A SUCCESS. It is the
 * case the non-negotiable rules in CLAUDE.md and section 1.5 of the standards
 * name directly: zero URLs from an accepted file is indistinguishable from a
 * legitimately empty one unless something says so, and an HTML error page
 * parses as perfectly valid, URL-less XML — which is how M2 found this the
 * first time.
 *
 * `parse_status` alone cannot express it, because the parse genuinely
 * succeeded. So the tone is decided from both, and the screen says "no urls"
 * beside the status rather than showing a green badge over an empty file.
 */
export function sitemapFileTone(
  status: FileParseStatus,
  urlCount: number
): Tone {
  if (status === "parsed" && urlCount === 0) {
    return "warning";
  }

  return fileParseStatusTone(status);
}

export function confidenceBandTone(band: ConfidenceBandName): Tone {
  switch (band) {
    case "confident":
      return "healthy";
    case "approximate":
      return "warning";
    case "low":
      return "unknown";
  }
}

/**
 * `blocked` and `unknown` both weigh zero severity — see schema/enums.ts —
 * and neither is a defect, so both map to the "unknown" tone rather than a
 * warning color that would read as "something is wrong here."
 */
export function severityTone(severity: SeverityClassName): Tone {
  switch (severity) {
    case "ok":
      return "healthy";
    case "redirect_single":
      return "warning";
    case "redirect_chain":
    case "soft_not_found":
      return "warning";
    case "not_found":
    case "gone":
    case "server_error":
      return "critical";
    case "blocked":
    case "unknown":
      return "unknown";
  }
}

export function siteActiveTone(isActive: boolean): Tone {
  return isActive ? "healthy" : "unknown";
}

/** A 2-3px inset box-shadow left-edge accent, per DESIGN.md section 5. */
export function rowAccentStyle(tone: Tone): CSSProperties {
  return { boxShadow: `inset 3px 0 0 0 ${TONE_VAR[tone]}` };
}

/**
 * Whether a utility on the Tools screen can be run.
 *
 * `unavailable` is `unknown`, NOT `critical`. A tool this platform cannot
 * offer — a live URL fetch, a robots.txt test — is not a defect and not a
 * failure; it is a capability that was deliberately never built, and colouring
 * seven cards red would report a broken product to anyone who reads the grid
 * before the text. That is the same inversion `patternStatusTone` carries a
 * warning about above, where a host refusing us was being called critical.
 *
 * `advisory` is a warning: the computation is real and the reader may act on
 * it, but nothing in the pipeline does — so the card must catch the eye of
 * someone about to assume otherwise.
 */
export function toolAvailabilityTone(availability: ToolAvailability): Tone {
  switch (availability) {
    case "operational":
      return "healthy";
    case "advisory":
      return "warning";
    case "unavailable":
      return "unknown";
  }
}

/**
 * What a portfolio row's last run is worth.
 *
 * `never_run` is `unknown`, not a warning: a project onboarded ten minutes ago
 * is not in trouble, it has no measurement yet — which is exactly what this
 * tone means everywhere else in this file.
 *
 * `no_urls` IS a warning, and it is the one that earns this function. A run
 * that completed and discovered zero URLs looks identical to a healthy small
 * site, and an HTML error page parses as perfectly valid, URL-less XML — the
 * case CLAUDE.md's non-negotiable rules and standards section 1.5 name
 * directly, and the one `sitemapFileTone` already exists to catch a row at a
 * time. A fleet table showing it green would hide it across every site at once.
 */
export function projectRunTone(state: ProjectRunState): Tone {
  switch (state) {
    case "never_run":
    case "in_flight":
      return "unknown";
    case "no_urls":
      return "warning";
    case "measured":
      return "healthy";
  }
}

/**
 * Whether a configured limit is actually applied.
 *
 * A limit nothing enforces is a WARNING, not a critical: the platform is not
 * broken, it is running on defaults while a control someone set does nothing.
 * And not `unknown` either — that tone means "no measurement", which is the
 * wrong reading here, because whether a limit is enforced is a fact this
 * codebase knows exactly.
 *
 * In `lib/status.ts` rather than in the page for the reason the rest of this
 * file exists: the mapping is product logic, so a screen must not pick the
 * colour by eye (DESIGN.md section 3).
 */
export function enforcementTone(enforcement: Enforcement): Tone {
  switch (enforcement) {
    case "in_force":
      return "healthy";
    case "not_enforced":
      return "warning";
  }
}

/**
 * An HTTP outcome's tone.
 *
 * A SOFT 404 IS NOT A HEALTHY 200, and that is the whole reason this takes a
 * second argument. A page returning 200 while saying "not found" is broken in
 * the way that matters to a search engine, and a chart that folded it in with
 * real successes would report a site as fine while a fifth of its sample was
 * a soft 404 — the exact case `packages/verification` escalates a HEAD to a
 * capped GET to detect.
 *
 * A NULL STATUS IS NOT A 5XX. No response at all — a timeout, a refused
 * connection — means the server never answered, so there is nothing to
 * classify; `unknown` is the honest tone, and calling it a server error would
 * report a site defect where there may be none.
 */
export function httpStatusTone(status: number | null, isSoft404 = false): Tone {
  if (status === null) {
    return "unknown";
  }

  if (isSoft404) {
    return "critical";
  }

  if (status >= 500 || status >= 400) {
    return "critical";
  }

  if (status >= 300) {
    return "warning";
  }

  return "healthy";
}
