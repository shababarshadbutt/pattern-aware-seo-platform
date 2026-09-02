import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { DEFAULT_PROBE_BUDGET, probeUrl } from "./probe.js";
import { BROWSER_PROFILE, CRAWLER_PROFILE } from "./request-profile.js";

/**
 * Mocked responses throughout, never live requests.
 *
 * The coding standards require it (section 1.10), and the reason is not just
 * hygiene: this code exists to point traffic at other people's production
 * servers, and a test suite that did so would be the exact behaviour the rate
 * limiter and circuit breaker are here to prevent.
 */

interface StubResponse {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

interface Sent {
  readonly method: string;
  readonly headers: Record<string, string>;
}

type Fetch = NonNullable<NonNullable<Parameters<typeof probeUrl>[1]>["fetch"]>;

function stubFetch(responses: readonly (StubResponse | Error)[]): {
  fetch: Fetch;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  let index = 0;

  const fetch = (async (_url: unknown, opts: unknown) => {
    const options = opts as {
      method?: string;
      headers?: Record<string, string>;
    };

    sent.push({
      method: options.method ?? "GET",
      headers: options.headers ?? {}
    });

    const next = responses[Math.min(index, responses.length - 1)];

    index += 1;

    if (next instanceof Error) {
      throw next;
    }

    const response = next ?? { statusCode: 200 };

    return {
      statusCode: response.statusCode,
      headers: response.headers ?? {},
      body: Readable.from([Buffer.from(response.body ?? "")])
    };
  }) as Fetch;

  return { fetch, sent };
}

const URL_UNDER_TEST = "https://client.test/part/12345";

describe("probeUrl", () => {
  describe("the cheap path", () => {
    /**
     * The whole design rests on this: most URLs are answered by one HEAD. A
     * hard 404 — the finding clients care most about — must never cost two
     * requests.
     */
    it("answers a 404 with a single HEAD", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 404 }]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      expect(result.httpStatus).toBe(404);
      expect(result.methodUsed).toBe("HEAD");
      expect(result.escalatedToGet).toBe(false);
      expect(result.requestCount).toBe(1);
      expect(sent.map((s) => s.method)).toEqual(["HEAD"]);
    });

    it("answers a 410 and a 500 with one request each", async () => {
      for (const status of [410, 500, 503]) {
        const { fetch } = stubFetch([{ statusCode: status }]);
        const result = await probeUrl(URL_UNDER_TEST, { fetch });

        expect(result.httpStatus).toBe(status);
        expect(result.requestCount).toBe(1);
      }
    });

    it("reads a redirect destination from the first response", async () => {
      const { fetch, sent } = stubFetch([
        { statusCode: 301, headers: { location: "https://client.test/new" } }
      ]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      expect(result.httpStatus).toBe(301);
      expect(result.location).toBe("https://client.test/new");
      // No follow-up request: the Location header is the answer.
      expect(sent).toHaveLength(1);
    });

    it("identifies as a crawler, not a browser", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 200 }]);

      await probeUrl(URL_UNDER_TEST, { fetch, skipSoft404Sniff: true });

      expect(sent[0]?.headers["user-agent"]).toBe(CRAWLER_PROFILE.userAgent);
      expect(sent[0]?.headers["user-agent"]).not.toContain("Chrome");
    });
  });

  describe("escalation 1: the verb was refused, not the URL", () => {
    /**
     * A 405 is the server rejecting HEAD, not a verdict on the page. Reporting
     * it as the URL's status would call a working page broken because of how we
     * asked — and 405 is not even in the severity table, so it would land as
     * `unknown` and be silently dropped from the impact score.
     */
    it.each([400, 405, 501])(
      "re-probes with GET after a %i and classifies on that",
      async (rejection) => {
        const { fetch, sent } = stubFetch([
          { statusCode: rejection },
          { statusCode: 200, body: "a healthy product page" }
        ]);
        const result = await probeUrl(URL_UNDER_TEST, { fetch });

        expect(result.httpStatus).toBe(200);
        expect(result.methodUsed).toBe("GET");
        expect(result.methodRejectedStatus).toBe(rejection);
        expect(result.escalatedToGet).toBe(true);
        expect(sent.map((s) => s.method)).toEqual(["HEAD", "GET"]);
      }
    );

    it("bounds the fallback body with a Range header", async () => {
      const { fetch, sent } = stubFetch([
        { statusCode: 405 },
        { statusCode: 200, body: "x".repeat(50_000) }
      ]);

      await probeUrl(URL_UNDER_TEST, { fetch });

      expect(sent[1]?.headers["range"]).toBe(
        `bytes=0-${DEFAULT_PROBE_BUDGET.methodFallbackBodyBytes - 1}`
      );
    });

    it("keeps a genuine failure from the re-probe", async () => {
      const { fetch } = stubFetch([{ statusCode: 405 }, { statusCode: 403 }]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      // HEAD refused for being HEAD, and GET refused too: the refusal is real.
      expect(result.httpStatus).toBe(403);
    });
  });

  describe("escalation 2: a 2xx whose body disagrees with it", () => {
    it("sniffs a 2xx body and finds a soft 404", async () => {
      const { fetch, sent } = stubFetch([
        { statusCode: 200 },
        { statusCode: 200, body: "<h1>Page not found</h1> sorry" }
      ]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      expect(result.httpStatus).toBe(200);
      expect(result.soft404?.isSoft404).toBe(true);
      expect(result.soft404?.matchedSignal).toBe("page not found");
      expect(result.escalatedToGet).toBe(true);
      expect(sent.map((s) => s.method)).toEqual(["HEAD", "GET"]);
    });

    /**
     * The cap that has been open since the original architecture review. The
     * body is fetched with a Range header AND truncated on read, so a server
     * that ignores the header still cannot make us buffer a whole page.
     */
    it("bounds the sniff body with a Range header", async () => {
      const { fetch, sent } = stubFetch([
        { statusCode: 200 },
        { statusCode: 200, body: "ok" }
      ]);

      await probeUrl(URL_UNDER_TEST, { fetch });

      expect(sent[1]?.headers["range"]).toBe(
        `bytes=0-${DEFAULT_PROBE_BUDGET.soft404BodyBytes - 1}`
      );
    });

    it("truncates a server that ignores the Range header", async () => {
      const budget = { ...DEFAULT_PROBE_BUDGET, soft404BodyBytes: 64 };
      const { fetch } = stubFetch([
        { statusCode: 200 },
        // A signal placed beyond the cap must NOT be found — proof the read
        // stopped rather than buffering the lot.
        { statusCode: 200, body: `${"x".repeat(5_000)} page not found` }
      ]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch, budget });

      expect(result.soft404?.matchedSignal).toBeUndefined();
    });

    it("can skip the sniff, halving the cost of a healthy URL", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 200 }]);
      const result = await probeUrl(URL_UNDER_TEST, {
        fetch,
        skipSoft404Sniff: true
      });

      expect(result.httpStatus).toBe(200);
      expect(result.escalatedToGet).toBe(false);
      expect(result.requestCount).toBe(1);
      expect(sent).toHaveLength(1);
    });
  });

  describe("charging the budget per request", () => {
    /**
     * The measured bug this design exists to avoid: legacy metered per CHECK
     * and hit 49.17 req/s against a 25 req/s ceiling, because a 2xx costs a
     * HEAD plus a sniff. The hook must fire once per REQUEST.
     */
    it("charges twice for a probe that escalated", async () => {
      const { fetch } = stubFetch([
        { statusCode: 200 },
        { statusCode: 200, body: "fine" }
      ]);

      let charges = 0;
      let releases = 0;

      const result = await probeUrl(URL_UNDER_TEST, {
        fetch,
        beforeRequest: async () => {
          charges += 1;

          return () => {
            releases += 1;
          };
        }
      });

      expect(charges).toBe(2);
      expect(releases).toBe(2);
      expect(result.requestCount).toBe(2);
    });

    it("charges once for a probe that did not", async () => {
      const { fetch } = stubFetch([{ statusCode: 404 }]);

      let charges = 0;

      await probeUrl(URL_UNDER_TEST, {
        fetch,
        beforeRequest: async () => {
          charges += 1;

          return () => {};
        }
      });

      expect(charges).toBe(1);
    });

    // A leaked slot is worse than a slow one: the limiter would believe it has
    // capacity it does not, and drift permanently.
    it("releases its slot even when the request throws", async () => {
      const { fetch } = stubFetch([new Error("ECONNREFUSED")]);

      let released = 0;

      await probeUrl(URL_UNDER_TEST, {
        fetch,
        beforeRequest: async () => () => {
          released += 1;
        }
      });

      expect(released).toBe(1);
    });
  });

  describe("transport failures", () => {
    it.each([
      ["timeout", "HeadersTimeoutError: timeout"],
      ["dns", "getaddrinfo ENOTFOUND client.test"],
      ["connection_refused", "connect ECONNREFUSED 1.2.3.4:443"],
      ["tls", "unable to verify the first certificate: TLS"]
    ])("classifies %s", async (expected, message) => {
      const { fetch } = stubFetch([new Error(message)]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      expect(result.httpStatus).toBeNull();
      expect(result.errorReason).toBe(expected);
    });

    /**
     * No status means no severity. Inventing one would turn a network blip into
     * a client-facing finding.
     */
    it("reports no status rather than guessing one", async () => {
      const { fetch } = stubFetch([new Error("something odd")]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      expect(result.httpStatus).toBeNull();
      expect(result.errorReason).toBe("unknown");
    });
  });

  describe("the profile ladder", () => {
    it("uses one rung by default", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 403 }]);
      const result = await probeUrl(URL_UNDER_TEST, { fetch });

      // A refusal is NOT retried with a browser profile per URL. At fleet scale
      // that costs ~2.6M requests to learn one fact 1.3M times.
      expect(sent).toHaveLength(1);
      expect(result.httpStatus).toBe(403);
    });

    it("tries the next rung only when the first is refused", async () => {
      const { fetch, sent } = stubFetch([
        { statusCode: 403 },
        { statusCode: 200 }
      ]);
      const result = await probeUrl(URL_UNDER_TEST, {
        fetch,
        skipSoft404Sniff: true,
        profileLadder: [CRAWLER_PROFILE, BROWSER_PROFILE]
      });

      expect(result.httpStatus).toBe(200);
      expect(result.profileUsed).toBe("browser");
      expect(sent[1]?.headers["sec-fetch-mode"]).toBe("navigate");
    });

    it("does not try the next rung for a real answer", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 404 }]);

      await probeUrl(URL_UNDER_TEST, {
        fetch,
        profileLadder: [CRAWLER_PROFILE, BROWSER_PROFILE]
      });

      // A 404 is an answer, not a refusal. Escalating would spend a request to
      // be told the same thing.
      expect(sent).toHaveLength(1);
    });

    /**
     * A rung byte-identical to an earlier one spends a request to get the same
     * answer — exactly the mistake legacy made by reusing its own UA as the
     * fallback.
     */
    it("collapses a duplicated rung", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 403 }]);

      await probeUrl(URL_UNDER_TEST, {
        fetch,
        profileLadder: [CRAWLER_PROFILE, { ...CRAWLER_PROFILE, name: "copy" }]
      });

      expect(sent).toHaveLength(1);
    });

    it("never exceeds two attempts, whatever the caller passes", async () => {
      const { fetch, sent } = stubFetch([{ statusCode: 403 }]);

      await probeUrl(URL_UNDER_TEST, {
        fetch,
        profileLadder: [
          CRAWLER_PROFILE,
          BROWSER_PROFILE,
          { name: "third", userAgent: "third-ua" },
          { name: "fourth", userAgent: "fourth-ua" }
        ]
      });

      expect(sent.length).toBeLessThanOrEqual(2);
    });
  });
});
