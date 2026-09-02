import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { HostCircuitBreaker } from "./circuit-breaker.js";
import type { ProbeOptions } from "./probe.js";
import { HostRateLimiter } from "./rate-limiter.js";
import { verifyPattern } from "./verify-pattern.js";

type Fetch = NonNullable<ProbeOptions["fetch"]>;

const HEALTHY_BODY = `<html><body><h1>Bearing 6203-2RS</h1><p>${"In stock and shipping today from our warehouse. ".repeat(40)}</p></body></html>`;

/**
 * Answer every request with the same status, recording what was sent.
 *
 * The default body is deliberately over a kilobyte. A 200 under the short-body
 * floor is treated as a soft-404 by that signal alone — correctly, since a
 * near-empty product page is a not-found page that forgot to say so — and a
 * terse stub body silently made every healthy fixture a soft-404.
 */
function constantFetch(
  statusCode: number,
  body = HEALTHY_BODY
): { fetch: Fetch; methods: string[] } {
  const methods: string[] = [];

  const fetch = (async (_url: unknown, opts: unknown) => {
    const options = opts as { method?: string };

    methods.push(options.method ?? "GET");

    return {
      statusCode,
      headers: {},
      body: Readable.from([Buffer.from(body)])
    };
  }) as Fetch;

  return { fetch, methods };
}

function urls(count: number, host = "client.test"): string[] {
  return Array.from(
    { length: count },
    (_, index) => `https://${host}/part/${1_000 + index}`
  );
}

describe("verifyPattern", () => {
  it("probes every URL and reports what it found", async () => {
    const { fetch } = constantFetch(404);
    const result = await verifyPattern(
      { urls: urls(10), plannedSampleSize: 10 },
      { fetch }
    );

    expect(result.verdict).toEqual({ kind: "measured" });
    expect(result.probed).toBe(10);
    expect(result.results.every((r) => r.severityClass === "not_found")).toBe(
      true
    );
  });

  /**
   * The arithmetic the platform request budget depends on. Ten healthy URLs
   * cost twenty requests, not ten, because each 2xx pays for a soft-404 sniff.
   * Treating a check as a request is what let legacy hit 49.17 req/s against a
   * 25 req/s ceiling.
   */
  it("reports requests sent, not probes made", async () => {
    const { fetch, methods } = constantFetch(200);
    // A plan generous enough that the escalation cap does not bind, so this
    // measures the HEAD-plus-sniff arithmetic rather than the cap.
    const result = await verifyPattern(
      { urls: urls(10), plannedSampleSize: 400 },
      { fetch }
    );

    expect(result.probed).toBe(10);
    expect(result.requestCount).toBe(20);
    expect(methods.filter((m) => m === "GET")).toHaveLength(10);
  });

  it("charges the rate limiter once per request", async () => {
    const { fetch } = constantFetch(200);
    let acquisitions = 0;

    const result = await verifyPattern(
      { urls: urls(5), plannedSampleSize: 400 },
      {
        fetch,
        beforeRequest: async () => {
          acquisitions += 1;

          return () => {};
        }
      }
    );

    // Five 2xx probes, each a HEAD plus a sniff.
    expect(acquisitions).toBe(10);
    expect(result.requestCount).toBe(10);
  });

  it("paces through the real limiter without leaking slots", async () => {
    const { fetch } = constantFetch(404);
    const limiter = new HostRateLimiter({
      requestsPerSecond: 1_000,
      concurrency: 2,
      now: () => 0,
      sleep: async () => {}
    });

    await verifyPattern(
      { urls: urls(8), plannedSampleSize: 400 },
      { fetch, rateLimiter: limiter }
    );

    // Every acquisition released, or the limiter would believe it has capacity
    // it does not and drift permanently.
    expect(limiter.inFlight("client.test")).toBe(0);
  });

  describe("the escalation cap, actually preventing requests", () => {
    /**
     * M4 shipped this as pure policy. Here it stops being advice: once the
     * budget is spent, the sniff is not sent, which is the only thing that
     * bounds the cost of a pattern where everything looks suspicious.
     *
     * 20% of a 30-URL plan is 6 escalations. Every URL here is a 2xx, so every
     * one wants a sniff — and only the first six get one.
     */
    it("suppresses escalations once the budget is spent", async () => {
      const { fetch, methods } = constantFetch(200);
      const result = await verifyPattern(
        { urls: urls(30), plannedSampleSize: 30 },
        { fetch }
      );

      expect(result.escalated).toBe(6);
      expect(methods.filter((m) => m === "GET")).toHaveLength(6);
      // 30 HEADs plus 6 sniffs, not 60.
      expect(result.requestCount).toBe(36);
    });

    it("flags the pattern for review rather than failing it", async () => {
      const { fetch } = constantFetch(200);
      const result = await verifyPattern(
        { urls: urls(30), plannedSampleSize: 30 },
        { fetch }
      );

      expect(result.verdict).toEqual({
        kind: "needs_review",
        reason: "GET_ESCALATION_CAP"
      });
    });

    /**
     * A suppressed sniff still yields a usable status from the HEAD. What is
     * lost is soft-404 detection on that URL — the honest trade for not
     * doubling the request cost.
     */
    it("still measures the URLs whose sniff was suppressed", async () => {
      const { fetch } = constantFetch(200);
      const result = await verifyPattern(
        { urls: urls(30), plannedSampleSize: 30 },
        { fetch }
      );

      const suppressed = result.results.filter((r) => r.escalationSuppressed);

      expect(suppressed.length).toBeGreaterThan(0);
      for (const entry of suppressed) {
        expect(entry.probe.httpStatus).toBe(200);
        expect(entry.probe.soft404).toBeUndefined();
      }
    });

    it("never trips on a pattern that does not escalate", async () => {
      const { fetch } = constantFetch(404);
      const result = await verifyPattern(
        { urls: urls(30), plannedSampleSize: 30 },
        { fetch }
      );

      expect(result.escalated).toBe(0);
      expect(result.verdict).toEqual({ kind: "measured" });
      expect(result.requestCount).toBe(30);
    });

    /**
     * The budget is against the PLAN, not the chunk. Verifying a 400-probe
     * sample in pieces must not re-grant 80 escalations per piece.
     */
    it("does not re-grant the budget per chunk", async () => {
      const { fetch } = constantFetch(200);
      const result = await verifyPattern(
        { urls: urls(10), plannedSampleSize: 30 },
        { fetch }
      );

      // Still bounded by the plan's six, and this chunk is under it.
      expect(result.escalated).toBeLessThanOrEqual(6);
    });
  });

  describe("a refusing host", () => {
    /**
     * Continuing after the circuit opens would spend the rest of the sample
     * learning the same fact repeatedly — legacy measured a fully-blocked
     * 1.3M-URL population paying ~2.6M requests to discover one thing.
     */
    it("stops the run rather than probing the rest of the sample", async () => {
      const { fetch, methods } = constantFetch(429);
      const breaker = new HostCircuitBreaker({
        openAfter429: 3,
        now: () => 0
      });

      const result = await verifyPattern(
        { urls: urls(50), plannedSampleSize: 50 },
        { fetch, circuitBreaker: breaker }
      );

      expect(result.verdict).toEqual({
        kind: "blocked",
        reason: "TOO_MANY_REQUESTS"
      });
      // Stopped at the probe that opened the circuit, not 50 probes later.
      expect(methods).toHaveLength(3);
      expect(result.probed).toBe(3);
    });

    /**
     * BLOCKED, never BROKEN. A 429 is the host refusing us, and classifying it
     * as a client error would report a healthy, crawler-blocking site as the
     * worst on the fleet. Legacy migration 042 drew this line first.
     */
    it("classifies refusals as blocked, not as findings", async () => {
      const { fetch } = constantFetch(429);
      const result = await verifyPattern(
        { urls: urls(5), plannedSampleSize: 5 },
        { fetch, circuitBreaker: new HostCircuitBreaker({ now: () => 0 }) }
      );

      expect(result.results.every((r) => r.severityClass === "blocked")).toBe(
        true
      );
    });

    it("takes more consecutive 403s than 429s to give up", async () => {
      const { fetch, methods } = constantFetch(403);
      const breaker = new HostCircuitBreaker({
        openAfter429: 3,
        openAfter403: 8,
        now: () => 0
      });

      await verifyPattern(
        { urls: urls(50), plannedSampleSize: 50 },
        { fetch, circuitBreaker: breaker }
      );

      // A 403 is ambiguous — it can be one genuinely forbidden URL among
      // healthy ones — so it takes more of them to conclude the host is the
      // problem rather than the URL.
      expect(methods).toHaveLength(8);
    });

    it("does not open on refusals broken up by real answers", async () => {
      let call = 0;
      const fetch = (async (_url: unknown, _opts: unknown) => {
        call += 1;

        return {
          // Every third response refuses; the rest are answers.
          statusCode: call % 3 === 0 ? 429 : 404,
          headers: {},
          body: Readable.from([Buffer.from("")])
        };
      }) as unknown as Fetch;

      const result = await verifyPattern(
        { urls: urls(20), plannedSampleSize: 20 },
        {
          fetch,
          circuitBreaker: new HostCircuitBreaker({
            openAfter429: 3,
            now: () => 0
          })
        }
      );

      // Consecutive, not cumulative: a host answering normally in between is
      // not refusing us.
      expect(result.verdict).toEqual({ kind: "measured" });
      expect(result.probed).toBe(20);
    });
  });

  describe("soft 404s", () => {
    it("classifies a 200 whose body says not found", async () => {
      const { fetch } = constantFetch(
        200,
        `<h1>Page not found</h1><p>${"Sorry, we could not locate it. ".repeat(40)}</p>`
      );
      const result = await verifyPattern(
        { urls: urls(3), plannedSampleSize: 400 },
        { fetch }
      );

      expect(
        result.results.every((r) => r.severityClass === "soft_not_found")
      ).toBe(true);
    });

    /**
     * The deviation from legacy's body matcher. It uses a plain substring test
     * for every signal including "404", so a healthy product page for SKU-40412
     * would be reported as a not-found page — and soft-404 carries severity
     * 0.9, so a false positive inflates a published number.
     */
    it("does not flag a part number that happens to contain 404", async () => {
      const { fetch } = constantFetch(
        200,
        `<h1>Bearing SKU-40412</h1><p>${"In stock, ships today from our warehouse. ".repeat(40)}</p>`
      );
      const result = await verifyPattern(
        { urls: urls(3), plannedSampleSize: 400 },
        { fetch }
      );

      expect(result.results.every((r) => r.severityClass === "ok")).toBe(true);
    });

    it("still flags a standalone 404 in the markup", async () => {
      const { fetch } = constantFetch(
        200,
        `<h1>404</h1><p>${"We could not find that item, sorry about that. ".repeat(40)}</p>`
      );
      const result = await verifyPattern(
        { urls: urls(2), plannedSampleSize: 400 },
        { fetch }
      );

      expect(
        result.results.every((r) => r.severityClass === "soft_not_found")
      ).toBe(true);
    });
  });

  it("reports the escalation rate for sampling_health", async () => {
    const { fetch } = constantFetch(200);
    const result = await verifyPattern(
      { urls: urls(30), plannedSampleSize: 30 },
      { fetch }
    );

    // Six escalations across thirty probes.
    expect(result.escalationRate).toBeCloseTo(0.2, 6);
  });

  it("handles an empty sample without sending anything", async () => {
    const { fetch, methods } = constantFetch(200);
    const result = await verifyPattern(
      { urls: [], plannedSampleSize: 0 },
      { fetch }
    );

    expect(methods).toHaveLength(0);
    expect(result.probed).toBe(0);
    expect(result.verdict).toEqual({ kind: "measured" });
  });
});
