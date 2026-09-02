import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Enumerated domains shared across the schema.
 *
 * Deliberately minimal. The action plan's Phase 2 note warns against adding
 * enum values that stay permanently empty — an unused value is indistinguishable
 * from a value nothing has produced *yet*, which makes "have we ever seen this?"
 * unanswerable. Every value below is written by code that exists or by code
 * landing in the milestone named in its comment.
 */

/**
 * Scheduling class for a site. Queue namespaces are `{tier}:{siteId}:{stage}`
 * (M5), so this is what keeps one site's job flood out of another's lane.
 */
export const siteTierEnum = pgEnum("site_tier", [
  "standard",
  "priority",
  "bulk"
]);

/**
 * Lifecycle of one ingestion-and-audit pass.
 *
 * `degraded` is a first-class outcome rather than a flavour of failure: a run
 * that hit the oversize soft limit still produced an honest population count and
 * a usable — if wider — set of estimates. Collapsing it into `failed` would
 * throw away a result that is genuinely useful, and collapsing it into
 * `complete` would let a reduced sample rate go unnoticed by whoever reads the
 * numbers. `status_reason` carries the machine-readable why.
 */
export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "complete",
  "degraded",
  "failed",
  "cancelled"
]);

/**
 * Per-file parse state. This is what makes a crashed run resumable at file
 * granularity rather than from the beginning — see the M2 resume design.
 */
export const fileParseStatusEnum = pgEnum("file_parse_status", [
  "pending",
  "downloading",
  "parsing",
  "parsed",
  "failed",
  "skipped"
]);

/**
 * What is known about a pattern's health.
 *
 * `blocked` and `needs_review` are separate on purpose, and neither means the
 * pattern is broken. `blocked` is a host refusing us — a 429, a 403, an open
 * circuit — and reporting that as a site defect would poison every downstream
 * estimate and impact score. `needs_review` is the GET-escalation cap tripping:
 * too much of the sample escalated, so sampling stopped rather than burning
 * budget. Both are absences of measurement, not bad measurements.
 */
export const patternStatusEnum = pgEnum("pattern_status", [
  "unsampled",
  "sampling",
  "measured",
  "blocked",
  "needs_review"
]);

/**
 * How a number was arrived at. The rendering contract in ADR-0008 keys off this.
 *
 * `counted` means n = N or a straight population count and is rendered as a
 * plain number. `estimated` means extrapolated from a sample and may never be
 * rendered without its interval. `blocked` means there is no measurement at all
 * and must never render as a health number.
 */
export const evidenceTierEnum = pgEnum("evidence_tier", [
  "counted",
  "estimated",
  "blocked"
]);

/**
 * Plain-language bucket for how wide an interval is, derived from
 * `(ci_high - ci_low) / point_estimate` against the CONFIDENCE_* thresholds in
 * packages/shared config.
 *
 * Stored rather than computed at read time so a historical snapshot keeps the
 * band it was published with, even if the thresholds are later retuned.
 */
export const confidenceBandEnum = pgEnum("confidence_band", [
  "confident",
  "approximate",
  "low"
]);

/**
 * How a sample was drawn. One value today, and that is the point: recording it
 * means a future change of method is visible in the data rather than silently
 * mixing two populations of results. See ADR-0002.
 */
export const sampleMethodEnum = pgEnum("sample_method", ["min_heap_by_hash"]);

/**
 * The verb a verdict came from. "HEAD refused and GET also refused" is a
 * materially stronger statement about a URL than "HEAD refused", so which one
 * produced the status is worth keeping.
 */
export const httpMethodEnum = pgEnum("http_method", ["HEAD", "GET"]);

/**
 * Where a finding came from.
 *
 * One value today, and the action plan is explicit about why there are not
 * more: extend this only with sources that will actually be populated soon,
 * because an enum value nothing ever writes is indistinguishable from one
 * nothing has written *yet*, and the difference matters when you are asking
 * whether a source is working.
 *
 * Deliberately absent: the legacy engine's `operator`, `no_change` and
 * `operator_pattern` are artifacts of its fix-and-republish workflow, which is
 * out of scope here (ADR-0007). `gsc` arrives with Search Console integration
 * in Phase 5. The column exists now so those additions are a migration of the
 * enum rather than a reinterpretation of every existing row.
 */
export const findingSourceEnum = pgEnum("finding_source", ["http_sample"]);

/**
 * How bad an outcome is, as a class rather than a raw status code.
 *
 * Stored alongside the weight that was applied, because `audit_snapshot` is an
 * immutable record of a published claim: the weights are a business decision
 * (ADR-0014) and will be revised, and a historical claim has to stay
 * reconstructible against the ones that actually produced it.
 *
 * `blocked` and `unknown` are in the list and both weigh zero. Neither is a
 * defect — one is a host refusing us, the other an outcome we could not
 * classify — and scoring either as damage would let a WAF turn a healthy client
 * into a P0.
 */
export const severityClassEnum = pgEnum("severity_class", [
  "gone",
  "not_found",
  "soft_not_found",
  "server_error",
  "redirect_chain",
  "redirect_single",
  "ok",
  "blocked",
  "unknown"
]);
