import type { AuditSnapshotSummary, ConfidenceBandName } from "../lib/api";
import { formatCount } from "../lib/format";
import { confidenceBandTone, TONE_VAR } from "../lib/status";

/**
 * The one sanctioned way to render a sampled number — ADR-0008.
 *
 * A discriminated union on `tier` rather than optional `low`/`high` props: the
 * ADR's requirement is that "an interval-less estimate is a type error," and
 * optional props would only fail that at runtime. `estimated` cannot be
 * constructed without `low`, `high`, and `band`; TypeScript enforces it here
 * the same way `constraints.test.ts` enforces it at the database.
 */
export type EstimateProps =
  | {
      readonly tier: "counted";
      readonly point: number;
      readonly n: number;
      readonly populationCount: number;
    }
  | {
      readonly tier: "estimated";
      readonly point: number;
      readonly low: number;
      readonly high: number;
      readonly n: number;
      readonly populationCount: number;
      readonly band: ConfidenceBandName;
    }
  | {
      readonly tier: "blocked";
      readonly populationCount: number;
      readonly reason?: string;
    };

export function Estimate(props: EstimateProps) {
  if (props.tier === "blocked") {
    // Its own visual channel, never a health number — a WAF block is not a
    // site defect, so this never renders as if it were one.
    return (
      <span
        className="font-mono text-xs uppercase tracking-wider"
        style={{ color: TONE_VAR.unknown }}
        title={
          props.reason ?? "Host refused verification; no measurement was made."
        }
      >
        no measurement
      </span>
    );
  }

  if (props.tier === "counted") {
    // n = N: a plain number, no "~", no interval — ADR-0008.
    return (
      <span className="font-mono text-sm tabular-nums" data-numeric>
        {formatCount(props.point)}
        <span className="ml-1 text-2xs text-tertiary">
          (of {formatCount(props.populationCount)})
        </span>
      </span>
    );
  }

  // Estimated: the "~" prefix AND the interval, always, colored by the
  // confidence band rather than treated as good/bad news — a wide interval is
  // an absence of evidence, not a defect (ADR-0008).
  const color = TONE_VAR[confidenceBandTone(props.band)];

  return (
    <span
      className="font-mono text-sm tabular-nums"
      data-numeric
      title={`n=${props.n} of N=${formatCount(props.populationCount)}, ${props.band} confidence`}
    >
      <span style={{ color }}>
        ~{formatCount(props.point)}
        <span className="ml-1 text-2xs">
          ({formatCount(props.low)}–{formatCount(props.high)})
        </span>
      </span>
      {/*
        The band SAID, not just coloured.
        
        ADR-0008 asks for "a plain-language confidence chip" always visible,
        and the band was reaching the reader through hue alone — invisible to
        anyone who cannot distinguish the tokens, and gone entirely in a
        screenshot or a print. "low" next to a number is also the honest
        reading: the width is a property of the evidence, not a warning about
        the site.
      */}
      <span className="ml-2 text-2xs uppercase tracking-wider text-tertiary">
        {props.band}
      </span>
    </span>
  );
}

/** Build `<Estimate>` props straight from a published finding. */
export function estimateFromSnapshot(
  snapshot: AuditSnapshotSummary
): EstimateProps {
  if (snapshot.evidenceTier === "blocked") {
    return { tier: "blocked", populationCount: snapshot.populationCount };
  }

  if (snapshot.evidenceTier === "counted") {
    return {
      tier: "counted",
      point: snapshot.pointEstimate,
      n: snapshot.sampleSize,
      populationCount: snapshot.populationCount
    };
  }

  return {
    tier: "estimated",
    point: snapshot.pointEstimate,
    low: snapshot.ciLow,
    high: snapshot.ciHigh,
    n: snapshot.sampleSize,
    populationCount: snapshot.populationCount,
    band: snapshot.confidenceBand
  };
}

/**
 * `<Estimate>` props for a finding's IMPACT, not its affected-URL count.
 *
 * Impact is `pointEstimate x severityWeight` — a weighted count of URLs, so it
 * is every bit as estimated as the count it derives from, and carries the same
 * uncertainty. It was rendering as a bare `toFixed(1)` figure with no `~` and
 * no interval, identical whether the tier was `counted` or `estimated`, which
 * is exactly what ADR-0008 exists to prevent. The band is reused rather than
 * recomputed: weighting by a constant cannot change how wide the interval is
 * relative to its point.
 */
export function impactFromSnapshot(
  snapshot: AuditSnapshotSummary
): EstimateProps {
  if (snapshot.evidenceTier === "blocked") {
    return { tier: "blocked", populationCount: snapshot.populationCount };
  }

  if (snapshot.evidenceTier === "counted") {
    return {
      tier: "counted",
      point: snapshot.impactScore,
      n: snapshot.sampleSize,
      populationCount: snapshot.populationCount
    };
  }

  return {
    tier: "estimated",
    point: snapshot.impactScore,
    low: snapshot.impactLow,
    high: snapshot.impactHigh,
    n: snapshot.sampleSize,
    populationCount: snapshot.populationCount,
    band: snapshot.confidenceBand
  };
}
