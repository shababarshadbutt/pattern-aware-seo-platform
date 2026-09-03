/**
 * One tone-mapping per status domain in the product, all resolving to the
 * same four semantic tones so a badge, a row accent, and a stat-strip number
 * always agree with each other for the same underlying fact (DESIGN.md
 * section 3: "this mapping is product logic, not decoration").
 */

import type { CSSProperties } from "react";

import type {
  ConfidenceBandName,
  PatternStatus,
  RunStatus,
  SeverityClassName
} from "./api";

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
