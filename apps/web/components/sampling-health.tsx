import type { SamplingHealthSummary } from "../lib/api";
import { formatCount, formatDateTime } from "../lib/format";
import { DefinitionGrid } from "./definition-grid";

/**
 * Figures `sampling_health` has a column for but nothing in the platform
 * produces. Declared once so the fact lives in one place rather than as a
 * string repeated at each call site.
 */
export const UNMEASURED_HEALTH_FIELDS = ["circuitBreaks"] as const;

/**
 * What a figure reads when no code path can produce it.
 *
 * NOT "0". The column is `integer not null default 0`, so a measured zero and
 * an unwritten one are indistinguishable in the row — and printing 0 would
 * report a measurement nobody made, which is §1.9's shape: a label asserting a
 * guarantee the code does not make.
 */
export const NOT_MEASURED = "not measured";

/** Why `circuitBreaks` cannot be a number, said where a reader can hover it. */
export const CIRCUIT_BREAKS_UNMEASURED_REASON =
  "Nothing in the platform produces this number: the circuit breaker keeps its state in memory inside one worker process, no table records an opening, and the stage that writes this row runs as a separate job. Every writer stores 0, so rendering 0 here would report a measurement nobody made.";

/**
 * A run's sampling health, in full.
 *
 * THE POINT OF THIS COMPONENT IS THE SEVEN FIGURES NOBODY COULD SEE. The API
 * has always sent all nine, and `SamplingHealthSummary` has always typed them,
 * but the site overview rendered exactly two — low confidence and blocked — so
 * `patternsTotal`, `patternsExpanded`, `patternsNeedsReview`, `samplesDrawn`,
 * `httpRequests`, `getEscalations` and `circuitBreaks` were fetched on every
 * request and dropped on the floor.
 *
 * They are the run's cost and honesty record: how many requests a sampling pass
 * actually spent, how often it had to escalate a HEAD to a GET, and how often a
 * host's circuit breaker tripped. A platform whose entire premise is auditing a
 * 90M-URL site without making 90M requests has to be able to show the request
 * count it did make.
 *
 * Every figure is COUNTED — an observed tally from a finished run, not a
 * sampled estimate — so these render bare rather than through `<Estimate>`.
 *
 * WITH ONE EXCEPTION, and it is the interesting one: `circuitBreaks` is not
 * counted by anything. Three of these figures were literal zeros written by
 * `runFinalize` until ADR-0034 and are now derived from the rows; the fourth
 * has no source at all, so it says so in words rather than printing a zero it
 * did not measure.
 */
export function SamplingHealthGrid({
  health
}: {
  readonly health: SamplingHealthSummary;
}) {
  return (
    <DefinitionGrid
      items={[
        { label: "patterns", value: formatCount(health.patternsTotal) },
        { label: "samples drawn", value: formatCount(health.samplesDrawn) },
        {
          label: "http requests",
          value: formatCount(health.httpRequests),
          title:
            "Requests this run actually spent — the figure the sampling approach exists to keep small."
        },
        {
          label: "get escalations",
          value: formatCount(health.getEscalations),
          title:
            "HEAD checks that had to be re-requested as a capped GET, either to sniff a soft 404 or because the host rejected HEAD."
        },
        {
          label: "low confidence",
          value: formatCount(health.patternsLowConfidence),
          title:
            "Patterns whose interval came back too wide to act on — missing evidence, not bad news."
        },
        {
          label: "expanded",
          value: formatCount(health.patternsExpanded),
          title:
            "Patterns that needed a second, larger draw to reach an actionable interval."
        },
        {
          label: "needs review",
          value: formatCount(health.patternsNeedsReview),
          title:
            "Patterns that hit the GET-escalation cap and were flagged rather than probed further."
        },
        {
          label: "blocked",
          value: formatCount(health.patternsBlocked),
          title:
            "Patterns the host refused to let us verify. An absence of measurement, not a site defect."
        },
        {
          /*
           * The one figure here that is NOT a measurement — see
           * `CIRCUIT_BREAKS_UNMEASURED_REASON`. Rendered as prose so it does
           * not sit in tabular mono where a reader scans for numbers, and
           * guarded by `sampling-health.test.tsx` so it cannot quietly revert
           * to `formatCount`.
           */
          label: "circuit breaks",
          value: NOT_MEASURED,
          prose: true,
          title: CIRCUIT_BREAKS_UNMEASURED_REASON
        },
        {
          label: "window",
          value: `${formatDateTime(health.windowStart)} → ${formatDateTime(health.windowEnd)}`,
          prose: true
        }
      ]}
    />
  );
}
