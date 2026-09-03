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
      style={{ color }}
      title={`n=${props.n} of N=${formatCount(props.populationCount)}, ${props.band} confidence`}
    >
      ~{formatCount(props.point)}
      <span className="ml-1 text-2xs">
        ({formatCount(props.low)}–{formatCount(props.high)})
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
