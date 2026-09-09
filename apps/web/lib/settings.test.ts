import { describe, expect, it } from "vitest";

import type { PolicyLimit, SitePolicyColumn, SiteSummary } from "./api";
import {
  enforcementOf,
  formatPolicyValue,
  formatSiteCap,
  isEmptyPatch,
  policyRowsFrom,
  SiteFormError,
  type SiteFormValues,
  siteFormPatch,
  sitePolicyRowsFrom
} from "./settings";

const limit = (over: Partial<PolicyLimit>): PolicyLimit => ({
  key: "K",
  label: "A limit",
  value: 1,
  unit: "count",
  enforcedAt: null,
  ...over
});

const site = (over: Partial<SiteSummary>): SiteSummary => ({
  id: "s1",
  organizationId: "o1",
  name: "Site",
  baseUrl: "https://example.test",
  host: "example.test",
  tier: "standard",
  isActive: true,
  dailyRequestCap: null,
  minRequestIntervalMs: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...over
});

describe("formatPolicyValue", () => {
  it("shows a fraction as the percentage people reason about", () => {
    // Every fraction in this config is a threshold read as "halt at 95%",
    // never as "halt at 0.95".
    expect(formatPolicyValue(0.95, "fraction")).toBe("95%");
    expect(formatPolicyValue(0.2, "fraction")).toBe("20%");
    expect(formatPolicyValue(0.025, "fraction")).toBe("2.5%");
  });

  it("scales milliseconds into a readable unit", () => {
    expect(formatPolicyValue(300, "ms")).toBe("300ms");
    expect(formatPolicyValue(1_500, "ms")).toBe("1.5s");
    expect(formatPolicyValue(300_000, "ms")).toBe("5m");
  });

  it("groups a large count and marks a rate as per-second", () => {
    expect(formatPolicyValue(250_000, "count")).toBe("250,000");
    expect(formatPolicyValue(25, "rps")).toBe("25/s");
  });
});

describe("enforcementOf", () => {
  it("treats a null path as not enforced, and any path as in force", () => {
    expect(enforcementOf({ enforcedAt: null })).toBe("not_enforced");
    expect(enforcementOf({ enforcedAt: "apps/worker/src/index.ts" })).toBe(
      "in_force"
    );
  });
});

describe("policyRowsFrom", () => {
  it("puts the unenforced limits first, because they are the finding", () => {
    const rows = policyRowsFrom([
      limit({ key: "B_ENFORCED", enforcedAt: "apps/worker/src/index.ts" }),
      limit({ key: "A_INERT", enforcedAt: null })
    ]);

    expect(rows.map((row) => row.key)).toEqual(["A_INERT", "B_ENFORCED"]);
    expect(rows[0]?.enforcement).toBe("not_enforced");
  });

  it("renders an unenforced limit's path as an em dash, not as empty", () => {
    const [row] = policyRowsFrom([limit({ enforcedAt: null })]);

    expect(row?.enforcedAt).toBe("—");
  });
});

describe("formatSiteCap", () => {
  it("names the inherited figure rather than showing a bare dash", () => {
    /**
     * THE §1.5 TRAP. A null cap rendered as `—` reads "no limit". It means
     * "inherit the platform default" — and that default is itself applied by
     * nothing, so a dash would understate the situation twice over.
     */
    expect(formatSiteCap(null, 250_000, "count")).toBe("inherits 250,000");
    expect(formatSiteCap(null, 250_000, "count")).not.toBe("—");
  });

  it("says so in words when even the platform default is unknown", () => {
    expect(formatSiteCap(null, undefined, "count")).toBe(
      "inherits platform default"
    );
  });

  it("shows a site's own cap when it has one", () => {
    expect(formatSiteCap(5_000, 250_000, "count")).toBe("5,000");
  });
});

describe("sitePolicyRowsFrom", () => {
  const columns = (enforcedAt: string | null): readonly SitePolicyColumn[] => [
    { key: "dailyRequestCap", label: "Cap", unit: "count", enforcedAt },
    { key: "minRequestIntervalMs", label: "Interval", unit: "ms", enforcedAt }
  ];

  it("takes enforcement from the API rather than deciding it", () => {
    /**
     * The property that keeps this screen honest without being edited: when a
     * column becomes real, the API's manifest says so and these rows follow.
     * A hardcoded `false` here would keep claiming otherwise.
     */
    const inert = sitePolicyRowsFrom([site({})], columns(null), []);
    const real = sitePolicyRowsFrom(
      [site({})],
      columns("packages/verification/src/rate-limiter.ts"),
      []
    );

    expect(inert[0]?.enforcement).toBe("not_enforced");
    expect(real[0]?.enforcement).toBe("in_force");
  });

  it("is pessimistic when only one of the two columns is applied", () => {
    // While either is inert the row's policy is not fully applied, and "in
    // force" would be the more misleading of the two available answers.
    const mixed: readonly SitePolicyColumn[] = [
      {
        key: "dailyRequestCap",
        label: "Cap",
        unit: "count",
        enforcedAt: "somewhere.ts"
      },
      {
        key: "minRequestIntervalMs",
        label: "Interval",
        unit: "ms",
        enforcedAt: null
      }
    ];

    expect(sitePolicyRowsFrom([site({})], mixed, [])[0]?.enforcement).toBe(
      "not_enforced"
    );
  });

  it("resolves the inherited cap from the platform limit it inherits from", () => {
    const rows = sitePolicyRowsFrom(
      [site({ dailyRequestCap: null })],
      columns(null),
      [
        limit({
          key: "HTTP_PER_SITE_DAILY_REQUEST_CAP",
          value: 250_000,
          unit: "count"
        })
      ]
    );

    expect(rows[0]?.dailyRequestCap).toBe("inherits 250,000");
  });

  it("distinguishes a tier default interval from a configured one", () => {
    const [inherited] = sitePolicyRowsFrom(
      [site({ minRequestIntervalMs: null })],
      columns(null),
      []
    );
    const [explicit] = sitePolicyRowsFrom(
      [site({ minRequestIntervalMs: 1_500 })],
      columns(null),
      []
    );

    expect(inherited?.minRequestInterval).toBe("tier default");
    expect(explicit?.minRequestInterval).toBe("1.5s");
  });
});

describe("siteFormPatch", () => {
  const values = (over: Partial<SiteFormValues> = {}): SiteFormValues => ({
    name: "Site",
    baseUrl: "https://example.test",
    tier: "standard",
    isActive: true,
    dailyRequestCap: "",
    minRequestIntervalMs: "",
    ...over
  });

  it("sends nothing when nothing changed", () => {
    /**
     * The property the whole partial-body contract rests on: an untouched form
     * must not be able to overwrite a column somebody else edited between the
     * page load and the save.
     */
    const patch = siteFormPatch(site({}), values());

    expect(patch).toEqual({});
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it("sends only the fields that changed", () => {
    const patch = siteFormPatch(
      site({}),
      values({ name: "Renamed", tier: "bulk" })
    );

    expect(patch).toEqual({ name: "Renamed", tier: "bulk" });
    expect(Object.keys(patch)).not.toContain("baseUrl");
  });

  it("turns a blank cap into null, never into zero", () => {
    /**
     * `Number("")` is 0, and a cap of zero is a site allowed NO requests at
     * all, where blank means "inherit the platform default". One coercion slip
     * apart, and the wrong one silently stops a site being probed.
     */
    const patch = siteFormPatch(
      site({ dailyRequestCap: 5_000 }),
      values({ dailyRequestCap: "  " })
    );

    expect(patch).toEqual({ dailyRequestCap: null });
    expect(patch.dailyRequestCap).not.toBe(0);
  });

  it("does not resend a cap that was already inherited", () => {
    const patch = siteFormPatch(
      site({ dailyRequestCap: null }),
      values({ dailyRequestCap: "" })
    );

    expect(patch).toEqual({});
  });

  it("reads a set cap as a number", () => {
    const patch = siteFormPatch(
      site({ dailyRequestCap: null }),
      values({ dailyRequestCap: "5000" })
    );

    expect(patch).toEqual({ dailyRequestCap: 5000 });
  });

  it("accepts a zero interval, which is meaningful", () => {
    // Unlike a cap, zero milliseconds between requests is a real setting —
    // "no additional delay" — so it must survive as 0 rather than becoming null.
    const patch = siteFormPatch(
      site({ minRequestIntervalMs: 500 }),
      values({ minRequestIntervalMs: "0" })
    );

    expect(patch).toEqual({ minRequestIntervalMs: 0 });
  });

  it("rejects a non-numeric cap rather than coercing it to NaN", () => {
    expect(() =>
      siteFormPatch(site({}), values({ dailyRequestCap: "lots" }))
    ).toThrow(SiteFormError);
  });

  it("rejects an empty name or base URL", () => {
    expect(() => siteFormPatch(site({}), values({ name: "   " }))).toThrow(
      SiteFormError
    );
    expect(() => siteFormPatch(site({}), values({ baseUrl: "" }))).toThrow(
      SiteFormError
    );
  });

  it("trims before comparing, so whitespace alone is not a change", () => {
    const patch = siteFormPatch(site({}), values({ name: "  Site  " }));

    expect(patch).toEqual({});
  });

  it("detects an unchecked active box as a change to false", () => {
    // An unchecked checkbox submits nothing, so the action reads absence as
    // false. This is the assertion that the false actually travels.
    const patch = siteFormPatch(
      site({ isActive: true }),
      values({ isActive: false })
    );

    expect(patch).toEqual({ isActive: false });
  });
});
