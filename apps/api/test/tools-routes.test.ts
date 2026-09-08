import type { Database } from "@pattern-aware/database";
import { measureProportion } from "@pattern-aware/sampling";
import { createLogger, loadPolicyConfig } from "@pattern-aware/shared";
import { PARAM_MIN_OBSERVED_URLS } from "@pattern-aware/sitemap/extraction";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { TOOL_MAX_URLS } from "../src/schemas.js";

/**
 * The tools, tested against a database that cannot be used.
 *
 * NO POSTGRES, and that is the assertion rather than a convenience. The claim
 * `routes/tools.ts` makes is that a computing POST is safe on a read-only API
 * because the registrar is handed no `Database` — non-mutating by construction.
 * A suite that passed a real connection would be consistent with that claim and
 * would also be consistent with the route quietly querying, so it would prove
 * nothing. A proxy that throws on every property access can only pass if
 * nothing touches it.
 */

/** Throws on any access, so a single stray `db.` reference is a 500. */
const POISONED_DB = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `A tool route touched the database (property "${String(property)}"). The tool registrar is handed no Database precisely so this cannot happen — see routes/tools.ts.`
      );
    }
  }
) as unknown as Database;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(
    {
      NODE_ENV: "test",
      DEFAULT_ORGANIZATION_SLUG: "demo",
      ...loadPolicyConfig({})
    },
    createLogger({ service: "tools-test", level: "silent", pretty: false }),
    POISONED_DB
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** `count` URLs under one section, so they share a path position. */
function urlsUnder(section: string, count: number, host = "shop.test"): string {
  return Array.from(
    { length: count },
    (_, index) => `https://${host}/${section}/item-${index}`
  ).join("\n");
}

describe("the tool routes hold no database handle", () => {
  it("serves the sample plan against a database that throws on any access", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=40000"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().plan.sampleTotal).toBe(400);
  });

  it("serves pattern extraction against the same poisoned database", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/pattern-extraction",
      payload: { text: urlsUnder("product", 40) }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome.matched).toBe(40);
  });
});

describe("GET /tools/sample-plan", () => {
  it("plans a first round from the configured budget", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=90000000"
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    // 400 of ninety million is the product's whole claim, in one figure.
    expect(body.plan.sampleTotal).toBe(400);
    expect(body.plan.populationTotal).toBe(90_000_000);
    expect(body.budget.maxFirstRound).toBe(400);

    // No hits supplied, so there is nothing measured to report yet.
    expect(body.measurement).toBeUndefined();
    expect(body.thresholdSource).toBe("package-default");
  });

  it("reports a zero-hit sample as a bounded absence, never as certainty", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=3000&sampled=30&hits=0"
    });

    const { measurement } = response.json();

    expect(measurement.pointEstimate).toBe(0);
    expect(measurement.ciHigh).toBeGreaterThan(0);
    expect(measurement.confidenceBand).toBe("low");
  });

  it("calls the same zero hits confident when the sample is large enough", async () => {
    // Same finding, different band — the zero-hit threshold pair (ADR-0013).
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=40000&sampled=400&hits=0"
    });

    expect(response.json().measurement.confidenceBand).toBe("confident");
  });

  it("answers exactly what the pipeline's own composition answers", async () => {
    /**
     * THE POINT OF THE WHOLE SLICE. This tool exists to show what the platform
     * would conclude, so an answer of its own — however reasonable — would make
     * it a lookalike rather than a demonstration.
     *
     * `routes/tools.ts` delegates to `measureProportion`, the same function
     * `runEstimate` writes `audit_snapshot` rows with, so the equivalence is
     * structural first and asserted here second.
     *
     * Confirmed load-bearing by replacing the route's `measureProportion` call
     * with an inline `wilsonInterval` plus a hand-rolled point estimate. THE
     * LAYER NEUTRALISED IS THE ROUTE'S DELEGATION — its own arithmetic — and
     * every case below fails.
     */
    for (const [population, sampled, hits] of [
      [3_000, 30, 0],
      [90_000_000, 400, 60],
      [40, 40, 6]
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/tools/sample-plan?population=${population}&sampled=${sampled}&hits=${hits}`
      });

      expect(response.json().measurement).toEqual(
        measureProportion([{ label: "all", population, sampled, hits }])
      );
    }
  });

  it("renders a census as counted rather than estimated", async () => {
    const { measurement } = (
      await app.inject({
        method: "GET",
        url: "/tools/sample-plan?population=40&sampled=40&hits=6"
      })
    ).json();

    expect(measurement.evidenceTier).toBe("counted");
    expect(measurement.ciLow).toBe(measurement.ciHigh);
  });

  it("refuses a zero population rather than claiming certainty about nothing", async () => {
    /**
     * At N = 0 the interval has zero width, so the band comes back `confident`
     * — a claim of certainty about a population that does not exist, which is
     * the legacy `[0, 0]` defect resurfacing by another route. The bound is at
     * the schema edge so it can never be reached.
     */
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=0"
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("confident");
  });

  it("rejects malformed input with a 400 rather than a 500", async () => {
    for (const query of ["population=abc", "population=-1", ""]) {
      const response = await app.inject({
        method: "GET",
        url: `/tools/sample-plan?${query}`
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it("rejects more hits than probes instead of throwing InvalidProportionError", async () => {
    /*
     * `estimateStratified` throws on this input, and `errors.ts` maps
     * `ApiProblem` and zod failures only — so without the schema refine the
     * caller would get a 500 with a stack trace.
     */
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=1000&sampled=3&hits=5"
    });

    expect(response.statusCode).toBe(400);
  });

  it("catches hits above a CLAMPED sample size, which the schema cannot see", async () => {
    // `sampled` is clamped to the population after the refine has run, so 40
    // becomes 10 and the refine's comparison is no longer the operative one.
    const response = await app.inject({
      method: "GET",
      url: "/tools/sample-plan?population=10&sampled=40&hits=20"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PROPORTION");
  });
});

describe("POST /tools/pattern-extraction", () => {
  it("states that a list below the floor cannot parameterise, and by how much", async () => {
    /**
     * THE HONESTY TRAP THIS TOOL IS MOST LIKELY TO SPRING. Twelve URLs produce
     * twelve templates and no `{param}` anywhere, which reads as a broken tool
     * unless the response says otherwise. It is the extraction rules working:
     * the legacy floor of 3 merged 2,946 static pages into one meaningless
     * template, and 30 is the fix.
     */
    const response = await app.inject({
      method: "POST",
      url: "/tools/pattern-extraction",
      payload: { text: urlsUnder("product", 12) }
    });

    const { parameterisation } = response.json();

    expect(parameterisation.belowFloor).toBe(true);
    expect(parameterisation.observedUrls).toBe(12);
    expect(parameterisation.urlsShortOfFloor).toBe(
      PARAM_MIN_OBSERVED_URLS - 12
    );
    expect(parameterisation.templatesParameterised).toBe(0);
  });

  it("parameterises once a path position clears the floor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/pattern-extraction",
      payload: { text: urlsUnder("product", 40) }
    });

    const body = response.json();

    expect(body.parameterisation.belowFloor).toBe(false);
    expect(body.parameterisation.templatesParameterised).toBeGreaterThan(0);
    expect(body.patterns[0].template).toContain("{param}");
    expect(body.patterns[0].populationCount).toBe(40);
  });

  it("reports above-floor-but-still-unparameterised as its own state", async () => {
    /**
     * The floor is checked PER TRIE NODE, not on the total, so forty URLs
     * spread across eight sections leaves each node at five and nothing
     * collapses. `belowFloor` is false and yet nothing parameterised — a third
     * state, and the reason the response carries a weak signal as well as the
     * strong one.
     */
    const text = Array.from({ length: 8 }, (_, index) =>
      urlsUnder(`section-${index}`, 5)
    ).join("\n");

    const { parameterisation } = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: { text }
      })
    ).json();

    expect(parameterisation.observedUrls).toBe(40);
    expect(parameterisation.belowFloor).toBe(false);
    expect(parameterisation.templatesParameterised).toBe(0);
  });

  it("derives the host by majority, not from the first line", async () => {
    /**
     * A stray CDN URL at the top of a paste must not make every other line
     * foreign. Taking the first absolute URL would report a catastrophic
     * migration the tool had invented itself.
     */
    const text = [
      "https://cdn.other-host.test/assets/logo.png",
      urlsUnder("product", 40)
    ].join("\n");

    const body = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: { text }
      })
    ).json();

    expect(body.host).toBe("shop.test");
    expect(body.hostSource).toBe("derived");
    expect(body.outcome.matched).toBe(40);
    expect(body.outcome.foreign).toBe(1);
    expect(body.foreignSamples).toContain(
      "https://cdn.other-host.test/assets/logo.png"
    );
  });

  it("treats off-domain URLs as a finding rather than an error", async () => {
    // A sitemap full of off-domain URLs is usually a botched migration. It is
    // reported, with examples, not silently dropped into a smaller count.
    const body = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: {
          text: urlsUnder("product", 10, "elsewhere.test"),
          host: "shop.test"
        }
      })
    ).json();

    expect(body.outcome.matched).toBe(0);
    expect(body.outcome.foreign).toBe(10);
    expect(body.hostSource).toBe("supplied");
    expect(body.hostBreakdown[0]).toEqual({
      host: "elsewhere.test",
      count: 10
    });
  });

  it("pins what parseLoc actually does with junk, rather than what it looks like it does", async () => {
    /**
     * `new URL("not a url", base)` SUCCEEDS, resolving to `/not%20a%20url`, so
     * a bare word is MATCHED and not unparseable. Only a string that fails both
     * the absolute and the relative parse is unparseable. Asserted because the
     * plausible guess is wrong, and a screen built on the guess would mislabel
     * whatever it counted.
     */
    const body = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: {
          text: "not a url\nhttp://\nhttps://shop.test/a",
          host: "shop.test"
        }
      })
    ).json();

    expect(body.outcome.matched).toBe(2);
    expect(body.outcome.unparseable).toBe(1);
    expect(body.unparseableSamples).toEqual(["http://"]);
  });

  it("counts blank lines out rather than analysing them", async () => {
    const body = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: {
          text: "\n\nhttps://shop.test/a\n\n  \nhttps://shop.test/b\n"
        }
      })
    ).json();

    expect(body.input.analysed).toBe(2);
    expect(body.input.blank).toBeGreaterThan(0);
  });

  it("refuses more URLs than it will analyse instead of truncating", async () => {
    /*
     * Truncating would change every figure in the response — populations, the
     * draw, and whether anything parameterises at all — so a partial answer
     * would be wrong about the input rather than incomplete about it.
     */
    const response = await app.inject({
      method: "POST",
      url: "/tools/pattern-extraction",
      payload: { text: urlsUnder("product", TOOL_MAX_URLS + 1) }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("TOO_MANY_URLS");
  });

  it("rejects an unknown field rather than silently ignoring it", async () => {
    // `.strict()`, for the reason `siteUpdateBody` is strict: a field the
    // caller believed it set and that did nothing is how a form appears to work.
    const response = await app.inject({
      method: "POST",
      url: "/tools/pattern-extraction",
      payload: { text: "https://shop.test/a", expectedHost: "shop.test" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("says so when nothing in the paste carried a host", async () => {
    const body = (
      await app.inject({
        method: "POST",
        url: "/tools/pattern-extraction",
        payload: { text: "/product/1\n/product/2\n/about" }
      })
    ).json();

    // Bare paths cannot be off-domain, so nothing is foreign and the screen can
    // say why rather than showing an unexplained zero.
    expect(body.hostSource).toBe("none");
    expect(body.outcome.matched).toBe(3);
    expect(body.outcome.foreign).toBe(0);
  });
});
