/**
 * Formatting for the Settings screen, kept out of the page so it is testable.
 *
 * All of it is presentation of COUNTED values — env limits and stored columns,
 * never a sampled estimate — so nothing here goes through `<Estimate>`.
 */

import type {
  PolicyLimit,
  PolicyUnit,
  SitePolicyColumn,
  SiteSummary
} from "./api";
import { formatBytes, formatCount } from "./format";

/** Milliseconds as something a person reads, not a raw figure. */
function formatMs(ms: number): string {
  if (ms < 1_000) {
    return `${formatCount(ms)}ms`;
  }

  if (ms < 60_000) {
    return `${Number((ms / 1_000).toFixed(1))}s`;
  }

  return `${Number((ms / 60_000).toFixed(1))}m`;
}

/**
 * A limit's value, in the unit it is expressed in.
 *
 * A fraction becomes a percentage because every fraction in this config is a
 * threshold someone reasons about as one — "halt at 95%", not "halt at 0.95".
 */
export function formatPolicyValue(value: number, unit: PolicyUnit): string {
  switch (unit) {
    case "rps":
      return `${formatCount(value)}/s`;
    case "fraction":
      return `${Number((value * 100).toFixed(1))}%`;
    case "ms":
      return formatMs(value);
    case "bytes":
      return formatBytes(value);
    case "count":
      return formatCount(value);
  }
}

export type Enforcement = "in_force" | "not_enforced";

export function enforcementOf(
  limit: Pick<PolicyLimit, "enforcedAt">
): Enforcement {
  return limit.enforcedAt === null ? "not_enforced" : "in_force";
}

export interface PolicyRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit: PolicyUnit;
  readonly enforcement: Enforcement;
  readonly enforcedAt: string;
}

/** Platform limits as rows, unenforced ones first — they are the finding. */
export function policyRowsFrom(
  policy: readonly PolicyLimit[]
): readonly PolicyRow[] {
  return [...policy]
    .map((limit) => ({
      key: limit.key,
      label: limit.label,
      value: formatPolicyValue(limit.value, limit.unit),
      unit: limit.unit,
      enforcement: enforcementOf(limit),
      enforcedAt: limit.enforcedAt ?? "—"
    }))
    .sort((a, b) => {
      if (a.enforcement !== b.enforcement) {
        return a.enforcement === "not_enforced" ? -1 : 1;
      }

      return a.key.localeCompare(b.key);
    });
}

export interface SitePolicyRow {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly tier: SiteSummary["tier"];
  readonly isActive: boolean;
  readonly dailyRequestCap: string;
  readonly minRequestInterval: string;
  readonly enforcement: Enforcement;
}

/**
 * A site's own cap, said in words when it has none of its own.
 *
 * THE §1.5 TRAP ON THIS SCREEN. A null `daily_request_cap` rendered as `—`
 * reads "no limit". It means "inherit the platform default" — and that default
 * is itself applied by nothing, so `—` would understate the situation twice
 * over. The inherited figure is named, and the row still says NOT ENFORCED.
 */
export function formatSiteCap(
  cap: number | null,
  platformDefault: number | undefined,
  unit: PolicyUnit
): string {
  if (cap !== null) {
    return formatPolicyValue(cap, unit);
  }

  return platformDefault === undefined
    ? "inherits platform default"
    : `inherits ${formatPolicyValue(platformDefault, unit)}`;
}

/**
 * Per-site policy rows.
 *
 * `enforcement` is taken from the site COLUMN descriptors the API sends, not
 * decided here — same reason as the platform table. When one of the two columns
 * becomes real, the API says so and this screen follows without being edited.
 */
export function sitePolicyRowsFrom(
  sites: readonly SiteSummary[],
  siteColumns: readonly SitePolicyColumn[],
  policy: readonly PolicyLimit[]
): readonly SitePolicyRow[] {
  const columnFor = (key: string): SitePolicyColumn | undefined =>
    siteColumns.find((column) => column.key === key);
  const platformCap = policy.find(
    (limit) => limit.key === "HTTP_PER_SITE_DAILY_REQUEST_CAP"
  );

  const capColumn = columnFor("dailyRequestCap");
  const intervalColumn = columnFor("minRequestIntervalMs");

  /*
   * One badge for the row, and it is pessimistic on purpose: while EITHER
   * column is unenforced the row's policy is not fully applied, and saying "in
   * force" would be the more misleading of the two available answers.
   */
  const enforcement: Enforcement =
    capColumn !== undefined &&
    intervalColumn !== undefined &&
    enforcementOf(capColumn) === "in_force" &&
    enforcementOf(intervalColumn) === "in_force"
      ? "in_force"
      : "not_enforced";

  return sites.map((site) => ({
    id: site.id,
    name: site.name,
    host: site.host,
    tier: site.tier,
    isActive: site.isActive,
    dailyRequestCap: formatSiteCap(
      site.dailyRequestCap,
      platformCap?.value,
      capColumn?.unit ?? "count"
    ),
    minRequestInterval:
      site.minRequestIntervalMs === null
        ? "tier default"
        : formatPolicyValue(
            site.minRequestIntervalMs,
            intervalColumn?.unit ?? "ms"
          ),
    enforcement
  }));
}

// --- Editing (the Project Core form) --------------------------------------

/** The subset of a site a form may change. Mirrors `siteUpdateBody`. */
export interface SitePatch {
  readonly name?: string;
  readonly baseUrl?: string;
  readonly tier?: SiteSummary["tier"];
  readonly isActive?: boolean;
  readonly dailyRequestCap?: number | null;
  readonly minRequestIntervalMs?: number | null;
}

/** Raw form values, as they arrive from a `FormData`. */
export interface SiteFormValues {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier: string;
  readonly isActive: boolean;
  /** Empty string means "inherit", which is `null` rather than zero. */
  readonly dailyRequestCap: string;
  readonly minRequestIntervalMs: string;
}

export class SiteFormError extends Error {
  public override readonly name = "SiteFormError";
}

/**
 * An optional integer field, where BLANK AND ZERO ARE DIFFERENT THINGS.
 *
 * A blank cap means "inherit the platform default" and must become `null`. The
 * trap is `Number("")`, which is `0` — a cap of zero would be a site allowed no
 * requests at all, so a coercion slip here turns "use the default" into "never
 * probe this site". Parsed explicitly rather than coerced.
 */
function optionalInteger(raw: string, label: string): number | null {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return null;
  }

  if (!/^\d+$/u.test(trimmed)) {
    throw new SiteFormError(`${label} must be a whole number, or left blank.`);
  }

  return Number(trimmed);
}

/**
 * The fields that actually changed, and nothing else.
 *
 * A partial rather than the whole row, so an untouched control cannot overwrite
 * a column somebody else edited between this page loading and the save. That is
 * also why the API's body schema has every field optional: the two halves of
 * this contract have to agree, or "send only what changed" degrades into
 * "silently send stale values for everything".
 */
export function siteFormPatch(
  current: SiteSummary,
  values: SiteFormValues
): SitePatch {
  const patch: Record<string, unknown> = {};
  const name = values.name.trim();
  const baseUrl = values.baseUrl.trim();

  if (name === "") {
    throw new SiteFormError("Name cannot be empty.");
  }

  if (baseUrl === "") {
    throw new SiteFormError("Base URL cannot be empty.");
  }

  if (name !== current.name) {
    patch.name = name;
  }

  if (baseUrl !== current.baseUrl) {
    patch.baseUrl = baseUrl;
  }

  if (values.tier !== current.tier) {
    patch.tier = values.tier;
  }

  if (values.isActive !== current.isActive) {
    patch.isActive = values.isActive;
  }

  const cap = optionalInteger(values.dailyRequestCap, "Daily request cap");

  if (cap !== current.dailyRequestCap) {
    patch.dailyRequestCap = cap;
  }

  const interval = optionalInteger(
    values.minRequestIntervalMs,
    "Minimum request interval"
  );

  if (interval !== current.minRequestIntervalMs) {
    patch.minRequestIntervalMs = interval;
  }

  return patch;
}

/** Whether a patch would change anything, so a no-op save can be refused. */
export function isEmptyPatch(patch: SitePatch): boolean {
  return Object.keys(patch).length === 0;
}
