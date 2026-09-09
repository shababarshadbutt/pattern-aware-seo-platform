/**
 * Pure shaping for the analysis screens — the run detail and the per-site
 * Analytics screen — kept out of the pages so it is testable without rendering.
 *
 * Everything here works on COUNTED values — parsed populations and probe
 * tallies. Nothing sampled passes through: an estimate has to reach the reader
 * via `<Estimate>` with its interval, and none of these shapes can carry one.
 */

import type { ObservationTally, PatternDepthCount, RunPoint } from "./api";
import { formatCount } from "./format";

/** The last bucket is open-ended, so a deep site does not stretch the axis. */
export const DEPTH_BUCKET_CAP = 6;

export interface DepthBucket {
  /** `1`…`5`, then `6+`. */
  readonly label: string;
  readonly patterns: number;
  readonly urls: number;
}

/**
 * Depth counts as a fixed set of buckets, including the empty ones.
 *
 * EMPTY BUCKETS ARE KEPT. The query only returns depths that exist, so a run
 * with patterns at depths 1 and 4 would otherwise draw two adjacent bars and
 * imply they are neighbours. A distribution with holes in it has to show the
 * holes, or the shape it draws is not the shape of the data.
 *
 * Everything at or beyond {@link DEPTH_BUCKET_CAP} folds into a final `6+`,
 * matching the design's axis.
 */
export function depthBuckets(
  distribution: readonly PatternDepthCount[]
): readonly DepthBucket[] {
  const buckets: DepthBucket[] = [];

  for (let depth = 1; depth < DEPTH_BUCKET_CAP; depth += 1) {
    const match = distribution.find((row) => row.segmentCount === depth);

    buckets.push({
      label: String(depth),
      patterns: match?.count ?? 0,
      urls: match?.populationCount ?? 0
    });
  }

  const deep = distribution.filter(
    (row) => row.segmentCount >= DEPTH_BUCKET_CAP
  );

  buckets.push({
    label: `${DEPTH_BUCKET_CAP}+`,
    patterns: deep.reduce((total, row) => total + row.count, 0),
    urls: deep.reduce((total, row) => total + row.populationCount, 0)
  });

  return buckets;
}

/**
 * The mean path depth, weighted by how many URLs sit at each depth.
 *
 * Weighted rather than a plain mean over patterns: one pattern holding four
 * million URLs at depth 2 describes the site far more than forty patterns
 * holding one URL each at depth 6, and an unweighted average would say the
 * opposite.
 */
export function averageDepth(
  distribution: readonly PatternDepthCount[]
): number | undefined {
  const urls = distribution.reduce(
    (total, row) => total + row.populationCount,
    0
  );

  if (urls === 0) {
    return undefined;
  }

  const weighted = distribution.reduce(
    (total, row) => total + row.segmentCount * row.populationCount,
    0
  );

  return weighted / urls;
}

/**
 * Change against the previous run, as a signed percentage.
 *
 * `undefined` when there is no previous run OR when the previous run found
 * nothing: a first run has no trend, and dividing by zero would render an
 * infinite increase for a site that simply had no data before. Both cases mean
 * "no comparison", and the screen shows nothing rather than a number it cannot
 * justify.
 */
export function trendPercent(
  current: number,
  previous: number | undefined
): number | undefined {
  if (previous === undefined || previous === 0) {
    return undefined;
  }

  return ((current - previous) / previous) * 100;
}

export function formatTrend(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;

  return `${rounded >= 0 ? "↑" : "↓"}${Math.abs(rounded)}%`;
}

export interface PageWindow {
  readonly from: number;
  readonly to: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/**
 * Which rows a page covers, one-indexed for display.
 *
 * `from` is zero on an empty result rather than one, so a screen can render
 * "0 of 0" instead of the "1–0 of 0" that naive arithmetic produces.
 */
export function pageWindow(
  offset: number,
  pageSize: number,
  total: number
): PageWindow {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + pageSize, total);

  return {
    from,
    to,
    hasPrevious: offset > 0,
    hasNext: offset + pageSize < total
  };
}

/**
 * The footer line for the explorer.
 *
 * SAYS "SAMPLED", AND THAT IS THE POINT. The design this mirrors reads
 * "SHOWING 1-4 OF 145,892", which describes a window onto every URL. These rows
 * are probes — one per URL the sampler actually drew — and a footer phrased the
 * design's way would present a sample as a census, which is the one thing this
 * product must never imply. See `listRunObservations`.
 */
export function explorerFooter(window: PageWindow, total: number): string {
  if (total === 0) {
    return "No sampled URLs match this filter.";
  }

  return `Showing ${formatCount(window.from)}–${formatCount(window.to)} of ${formatCount(total)} sampled URLs`;
}

// --- Widget shaping -------------------------------------------------------

export interface OutcomeSlice {
  readonly label: string;
  readonly value: number;
  readonly isSoft404: boolean;
  readonly httpStatus: number | null;
}

/**
 * Probe outcomes as labelled slices, worst-first.
 *
 * A SOFT 404 IS ITS OWN SLICE, never merged into its status code. The API sends
 * `(httpStatus, isSoft404)` pairs precisely so this distinction survives: a 200
 * that says "not found" is the failure the GET escalation exists to catch, and
 * a ring that showed it as a healthy 200 would report a broken site as fine.
 *
 * A null status is "no response" — a timeout or a refused connection — and is
 * labelled as such rather than being dropped or counted as a server error.
 */
export function outcomeSlices(
  outcomes: readonly ObservationTally[]
): readonly OutcomeSlice[] {
  return [...outcomes]
    .map((outcome) => ({
      label:
        outcome.httpStatus === null
          ? "no response"
          : outcome.isSoft404
            ? `${outcome.httpStatus} soft 404`
            : String(outcome.httpStatus),
      value: outcome.count,
      isSoft404: outcome.isSoft404,
      httpStatus: outcome.httpStatus
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * What share of a run's URLs were actually requested.
 *
 * THE PRODUCT'S ARGUMENT AS A NUMBER: a site of 22,898 URLs audited with 373
 * requests is 1.6% coverage, and that figure being small is the point rather
 * than a shortfall. Returned as a fraction of one so a meter can draw it, with
 * the caller deciding how to phrase it.
 *
 * Undefined when the population is zero — a run that discovered nothing has no
 * coverage to express, and 0% would read as a failure to probe rather than as
 * nothing to probe.
 */
export function coverageFraction(
  requests: number,
  population: number
): number | undefined {
  if (population <= 0) {
    return undefined;
  }

  return requests / population;
}

/**
 * A coverage fraction as a percentage string.
 *
 * Keeps more precision the smaller it gets: "0.0%" for a large site audited
 * with a few hundred requests would erase exactly the achievement the figure
 * exists to show.
 */
export function formatCoverage(fraction: number): string {
  const percent = fraction * 100;

  if (percent >= 10) {
    return `${Math.round(percent)}%`;
  }

  if (percent >= 1) {
    return `${percent.toFixed(1)}%`;
  }

  return `${percent.toFixed(2)}%`;
}

/** One slice of a run-outcome breakdown. */
export interface RunStatusSlice {
  readonly label: RunPoint["status"];
  readonly value: number;
}

/**
 * How a site's recent runs ended, largest group first.
 *
 * A status with no runs is ABSENT from the output rather than present with a
 * zero. That is the ZERO DRAWS NOTHING rule moved one layer up: a chart handed
 * a zero has to remember to drop it, and a legend built from the same list
 * would still announce "0 failed" — a category the reader is invited to worry
 * about that does not exist. Not shaping it here means every consumer gets it
 * right by default rather than each remembering separately.
 *
 * Ordering is deterministic: by count, then by label, so two statuses with the
 * same count do not swap places between renders and make a stable page look
 * like it is changing.
 */
export function runStatusSlices(
  runs: readonly RunPoint[]
): readonly RunStatusSlice[] {
  const counts = new Map<RunPoint["status"], number>();

  for (const run of runs) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
