import type { ProjectSummary, SiteTier } from "./api";

/**
 * The portfolio screen's own logic, out of the page so it can be tested.
 *
 * Everything here is a decision a reader would be misled by if it were wrong,
 * and none of it is layout: what the pagination footer says, what a project
 * with no run means, and which tier filters exist. The page renders; this
 * decides.
 */

/** How many projects one page of the portfolio shows. */
export const PROJECTS_PAGE_SIZE = 25;

export const TIER_FILTERS: readonly {
  readonly value: SiteTier | "all";
  readonly label: string;
}[] = [
  { value: "all", label: "Tier: all" },
  { value: "priority", label: "Tier: priority" },
  { value: "standard", label: "Tier: standard" },
  { value: "bulk", label: "Tier: bulk" }
];

/** A tier from a query param, or undefined for "all" and for anything unknown. */
export function tierFilter(value: string | undefined): SiteTier | undefined {
  return value === "standard" || value === "priority" || value === "bulk"
    ? value
    : undefined;
}

/** A non-negative page index from a query param. */
export function pageParam(value: string | undefined): number {
  const parsed = Number(value ?? "1");

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

export interface PageWindow {
  readonly page: number;
  readonly offset: number;
  /** 1-indexed, inclusive. Zero and zero when nothing matched. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

/**
 * What the footer's "showing 1-25 of 18 projects" actually says.
 *
 * THE EMPTY CASE IS `0-0`, NOT `1-0`. The naive arithmetic gives "showing 1-0
 * of 0", which reads as a broken query rather than an empty fleet — and this
 * screen has a legitimate empty state, since a fresh install has no sites at
 * all until someone onboards one.
 *
 * `to` is clamped to the total rather than to the page size, so the last page
 * of 18 with a page size of 25 says "1-18 of 18" and not "1-25 of 18". The
 * Stitch footer reads "Showing 1-5 of 18 tracked projects" over five visible
 * rows, so it is the row count that matters, not the window asked for.
 */
export function pageWindow(
  page: number,
  pageSize: number,
  rows: number,
  total: number
): PageWindow {
  const offset = (page - 1) * pageSize;
  const from = rows === 0 ? 0 : offset + 1;
  const to = rows === 0 ? 0 : offset + rows;

  return {
    page,
    offset,
    from,
    to,
    total,
    hasPrevious: page > 1,
    hasNext: to < total
  };
}

/**
 * What a project row says about its last run.
 *
 * FOUR STATES, NOT TWO, and the first is the one a fleet table gets wrong.
 * A site onboarded ten minutes ago has never run; a site whose run finished
 * and found nothing has. Rendering both as zeros states the second while
 * meaning the first — the section 1.5 failure in presentational form, and the
 * same one that made a parsed-but-empty sitemap file render green in D3a.
 *
 * `no_urls` is the visual form of that rule: a run that completed and
 * discovered zero URLs is not a healthy run, because an HTML error page parses
 * as perfectly valid, URL-less XML.
 */
export type ProjectRunState =
  | "never_run"
  | "in_flight"
  | "no_urls"
  | "measured";

export function projectRunState(project: ProjectSummary): ProjectRunState {
  const run = project.latestRun;

  if (run === undefined) {
    return "never_run";
  }

  if (run.status === "pending" || run.status === "running") {
    return "in_flight";
  }

  return run.totalUrls === 0 ? "no_urls" : "measured";
}

/** What that state should say, in words, where a colour alone would not. */
export const RUN_STATE_LABEL: Record<ProjectRunState, string> = {
  never_run: "never run",
  in_flight: "in flight",
  no_urls: "no urls",
  measured: "measured"
};

/** Raised when the onboarding form's own input is unusable. */
export class NewProjectError extends Error {
  public override readonly name = "NewProjectError";
}

export interface NewProjectInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier: SiteTier;
}

const TIERS: readonly SiteTier[] = ["standard", "priority", "bulk"];

/**
 * Validate the onboarding form before it reaches the API.
 *
 * IN `lib/` RATHER THAN IN THE SERVER ACTION, for the reason `siteFormPatch`
 * is: a `"use server"` module cannot be unit-tested without standing up
 * `next/cache`, so validation living there is validation nothing checks. The
 * action reads the FormData and calls this.
 *
 * NOT REDUNDANT WITH THE API'S ZOD BODY. That check is the boundary and stays
 * the authority; this one exists so a missing name is answered immediately
 * rather than after a round trip, and in words written for this form rather
 * than for a machine caller.
 *
 * THE URL MUST BE ABSOLUTE, and the message says why rather than just
 * refusing: the repository derives the host from it, and "example.com" has no
 * scheme to derive one from — so a reader who typed a bare domain is told what
 * to add instead of being told it is invalid.
 */
export function newProjectInput(raw: {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier: string;
}): NewProjectInput {
  const name = raw.name.trim();
  const baseUrl = raw.baseUrl.trim();

  if (name === "") {
    throw new NewProjectError("Give the project a name.");
  }

  if (baseUrl === "") {
    throw new NewProjectError(
      "Give the project a base URL, including https://."
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new NewProjectError(
      `"${baseUrl}" is not an absolute URL. Include the scheme, e.g. https://${baseUrl}.`
    );
  }

  /*
   * The host is what the outbound rate limiter buckets on, so a URL that
   * parses but yields no host would produce a site nothing can throttle.
   * `new URL("mailto:x")` is the shape that gets here.
   */
  if (parsed.host === "") {
    throw new NewProjectError(
      `"${baseUrl}" has no host to monitor. Use an http or https URL.`
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new NewProjectError(
      `Only http and https are supported, not "${parsed.protocol.replace(":", "")}".`
    );
  }

  return {
    name,
    baseUrl,
    tier: TIERS.find((candidate) => candidate === raw.tier) ?? "standard"
  };
}
