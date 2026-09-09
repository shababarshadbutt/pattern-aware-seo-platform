import { describe, expect, it } from "vitest";

import type { ProjectSummary, SitemapRunSummary } from "./api";
import {
  NewProjectError,
  newProjectInput,
  pageParam,
  pageWindow,
  projectRunState,
  tierFilter
} from "./projects";

function run(overrides: Partial<SitemapRunSummary>): SitemapRunSummary {
  return {
    id: "r1",
    siteId: "s1",
    status: "complete",
    statusReason: null,
    isDryRun: true,
    workerId: null,
    heartbeatAt: null,
    startedAt: "2026-09-07T00:00:00.000Z",
    completedAt: "2026-09-07T00:10:00.000Z",
    totalFiles: 3,
    parsedFiles: 3,
    totalUrls: 5000,
    totalPatterns: 9,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:10:00.000Z",
    ...overrides
  };
}

function project(latestRun?: SitemapRunSummary): ProjectSummary {
  return {
    site: {
      id: "s1",
      organizationId: "o1",
      name: "Site",
      baseUrl: "https://site.example",
      host: "site.example",
      tier: "standard",
      isActive: true,
      dailyRequestCap: null,
      minRequestIntervalMs: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      deletedAt: null
    },
    ...(latestRun === undefined ? {} : { latestRun }),
    findings: { total: 0, critical: 0, bySeverity: [] }
  };
}

describe("pageWindow", () => {
  it("says 0-0 for an empty fleet rather than 1-0", () => {
    /**
     * The naive arithmetic gives "showing 1-0 of 0", which reads as a broken
     * query. This screen has a legitimate empty state — a fresh install has no
     * sites until someone onboards one — so it must not look like a failure.
     */
    const window = pageWindow(1, 25, 0, 0);

    expect(window.from).toBe(0);
    expect(window.to).toBe(0);
    expect(window.hasNext).toBe(false);
    expect(window.hasPrevious).toBe(false);
  });

  it("clamps the end to the rows actually shown, not the page size", () => {
    // "1-18 of 18", never "1-25 of 18": it is the row count that matters, and
    // a window wider than the data would overstate what the reader can see.
    const window = pageWindow(1, 25, 18, 18);

    expect(window.from).toBe(1);
    expect(window.to).toBe(18);
    expect(window.hasNext).toBe(false);
  });

  it("offsets a later page and knows both directions exist", () => {
    const window = pageWindow(2, 5, 5, 18);

    expect(window.offset).toBe(5);
    expect(window.from).toBe(6);
    expect(window.to).toBe(10);
    expect(window.hasPrevious).toBe(true);
    expect(window.hasNext).toBe(true);
  });

  it("has no next page on the last one", () => {
    const window = pageWindow(4, 5, 3, 18);

    expect(window.from).toBe(16);
    expect(window.to).toBe(18);
    expect(window.hasNext).toBe(false);
  });
});

describe("pageParam", () => {
  it("falls back to page 1 for anything that is not a page", () => {
    expect(pageParam(undefined)).toBe(1);
    expect(pageParam("")).toBe(1);
    expect(pageParam("0")).toBe(1);
    expect(pageParam("-3")).toBe(1);
    expect(pageParam("2.5")).toBe(1);
    expect(pageParam("banana")).toBe(1);
    expect(pageParam("4")).toBe(4);
  });
});

describe("tierFilter", () => {
  it("treats an unknown tier as no filter rather than an empty result", () => {
    /*
     * A hand-edited `?tier=gold` must show the fleet, not an empty table: an
     * empty table is indistinguishable from "you have no projects", and the
     * reader has no way to tell which they are looking at.
     */
    expect(tierFilter("gold")).toBeUndefined();
    expect(tierFilter("all")).toBeUndefined();
    expect(tierFilter(undefined)).toBeUndefined();
    expect(tierFilter("priority")).toBe("priority");
    expect(tierFilter("bulk")).toBe("bulk");
  });
});

describe("projectRunState", () => {
  /**
   * THE DISTINCTION A FLEET TABLE GETS WRONG. A site onboarded ten minutes ago
   * and a site whose run found nothing both show zeros, and a row of zeros
   * states the second while meaning the first.
   */
  it("separates never-run from a run that found nothing", () => {
    expect(projectRunState(project())).toBe("never_run");
    expect(projectRunState(project(run({ totalUrls: 0 })))).toBe("no_urls");
  });

  it("does not call an in-flight run a measurement", () => {
    expect(projectRunState(project(run({ status: "running" })))).toBe(
      "in_flight"
    );
    expect(projectRunState(project(run({ status: "pending" })))).toBe(
      "in_flight"
    );
  });

  it("reports a completed run with URLs as measured", () => {
    expect(projectRunState(project(run({})))).toBe("measured");
  });

  /**
   * A DEGRADED OR FAILED RUN THAT DISCOVERED URLS IS STILL A MEASUREMENT of
   * however much it reached. The run's own status badge carries the failure —
   * `runStatusTone` maps `failed` to critical — so this state must not also
   * try to, or the row would report the same fact twice and the counts it
   * really does hold would be hidden behind it.
   */
  it("keeps run health and measurement separate", () => {
    expect(projectRunState(project(run({ status: "degraded" })))).toBe(
      "measured"
    );
    expect(
      projectRunState(project(run({ status: "failed", totalUrls: 12 })))
    ).toBe("measured");
    expect(
      projectRunState(project(run({ status: "failed", totalUrls: 0 })))
    ).toBe("no_urls");
  });
});

describe("newProjectInput", () => {
  it("accepts a project and defaults an unknown tier to standard", () => {
    expect(
      newProjectInput({
        name: "  Acme Storefront  ",
        baseUrl: "  https://www.acme.example/shop  ",
        tier: "priority"
      })
    ).toEqual({
      name: "Acme Storefront",
      baseUrl: "https://www.acme.example/shop",
      tier: "priority"
    });

    // A tampered or stale select value must not become a tier the queue
    // namespace has never heard of.
    expect(
      newProjectInput({
        name: "A",
        baseUrl: "https://a.example",
        tier: "gold"
      }).tier
    ).toBe("standard");
  });

  it("asks for the missing field rather than reporting the form invalid", () => {
    expect(() =>
      newProjectInput({ name: "  ", baseUrl: "https://a.example", tier: "" })
    ).toThrow(NewProjectError);
    expect(() =>
      newProjectInput({ name: "A", baseUrl: "  ", tier: "" })
    ).toThrow(/base URL/i);
  });

  /**
   * A BARE DOMAIN IS THE MOST LIKELY MISTAKE, and "invalid URL" does not tell
   * the reader what to do about it. The repository derives the host from this
   * value, and `example.com` has no scheme to derive one from, so the message
   * names the fix.
   */
  it("tells a reader who typed a bare domain what to add", () => {
    expect(() =>
      newProjectInput({ name: "A", baseUrl: "acme.example", tier: "" })
    ).toThrow(/https:\/\/acme\.example/);
  });

  /*
   * The host is what the outbound rate limiter buckets on, so a URL that
   * parses but yields no usable host would create a site nothing can throttle.
   */
  it("refuses a URL with no host to monitor", () => {
    expect(() =>
      newProjectInput({
        name: "A",
        baseUrl: "mailto:someone@a.example",
        tier: ""
      })
    ).toThrow(NewProjectError);
  });

  it("refuses a scheme this platform cannot request", () => {
    expect(() =>
      newProjectInput({ name: "A", baseUrl: "ftp://a.example", tier: "" })
    ).toThrow(/only http and https/i);
  });
});
