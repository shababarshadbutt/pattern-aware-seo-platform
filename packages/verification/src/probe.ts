import type { Readable } from "node:stream";

import { request } from "undici";
import {
  DEFAULT_PROFILE_LADDER,
  headersFor,
  isSameProfile,
  type RequestProfile
} from "./request-profile.js";
import { detectSoft404, type Soft404Verdict } from "./soft-404.js";

/**
 * TWO ATTEMPTS, MAXIMUM — enforced here rather than trusted to callers.
 *
 * Ported from legacy, which puts the ceiling in the checker on purpose: a
 * caller cannot widen it by passing a longer ladder, so the worst case per
 * check stays bounded no matter what the strategy layer above decides.
 */
const MAX_ATTEMPTS = 2;

export interface ProbeBudget {
  /** Bytes read to sniff a 2xx body for a soft-404. */
  readonly soft404BodyBytes: number;
  /** Bytes read when a HEAD was method-rejected and GET is the fallback. */
  readonly methodFallbackBodyBytes: number;
  /** Per-request timeout. */
  readonly timeoutMs: number;
}

export const DEFAULT_PROBE_BUDGET: ProbeBudget = Object.freeze({
  soft404BodyBytes: 64 * 1024,
  methodFallbackBodyBytes: 8 * 1024,
  timeoutMs: 15_000
});

export interface ProbeOptions {
  /**
   * Called immediately before EVERY outbound request, and awaited.
   *
   * This is how the per-host rate limit is charged per REQUEST rather than per
   * check — the distinction legacy measured at 49.17 req/s against a 25 req/s
   * ceiling, because there a 2xx cost a HEAD plus a ranged GET and a 3xx cost a
   * HEAD plus a follow-up HEAD.
   *
   * Here a 3xx costs one request (redirects are not followed), but a 2xx still
   * costs two, so metering the check would still under-count. Returns a release
   * function, called when the request completes.
   */
  readonly beforeRequest?: (url: string) => Promise<() => void>;
  /**
   * Profiles to try, in order. Truncated to {@link MAX_ATTEMPTS}.
   *
   * THE LADDER LIVES WITH THE CALLER. This module is a dumb executor: it tries
   * what it is given and stops at the first real measurement. Rung ordering
   * belongs to the per-host strategy layer, which knows which rung a host
   * answered on — putting it here as well would give two modules an opinion
   * about escalation, which is how they drift.
   *
   * Defaults to one rung. See DEFAULT_PROFILE_LADDER for why retrying per URL
   * is ruinous at fleet scale.
   */
  readonly profileLadder?: readonly RequestProfile[];
  /** Skip the soft-404 body sniff on a 2xx. Halves the cost of a healthy URL. */
  readonly skipSoft404Sniff?: boolean;
  readonly budget?: ProbeBudget;
  /** Injected for tests. Defaults to undici's `request`. */
  readonly fetch?: typeof request;
}

export type ProbeErrorReason =
  | "timeout"
  | "dns"
  | "tls"
  | "connection_refused"
  | "aborted"
  | "unknown";

export interface ProbeResult {
  readonly url: string;
  /** Null when no status was obtained at all. */
  readonly httpStatus: number | null;
  /** Which verb produced the verdict. */
  readonly methodUsed: "HEAD" | "GET" | undefined;
  /** True when this probe cost a GET on top of its HEAD. */
  readonly escalatedToGet: boolean;
  /** The HEAD status that triggered a GET re-probe, when one did. */
  readonly methodRejectedStatus: number | undefined;
  readonly soft404: Soft404Verdict | undefined;
  /** Redirect destination, from the first response's Location header. */
  readonly location: string | undefined;
  readonly errorReason: ProbeErrorReason | undefined;
  readonly responseMs: number;
  /** How many outbound requests this probe actually cost. */
  readonly requestCount: number;
  readonly profileUsed: string | undefined;
}

/**
 * Redirects are deliberately NOT followed.
 *
 * undici's `request` does not follow them by default, and that is what is
 * wanted: the destination is read from the first response's `Location` header,
 * so following would spend a request to learn something already in hand. It
 * would also hide the hop count, and a redirect CHAIN is weighted four times a
 * single hop (ADR-0014) precisely because the hops are the finding.
 */

/** Statuses that mean "this server does not accept HEAD", not "this URL is bad". */
const METHOD_REJECTION_STATUSES = new Set([400, 405, 501]);

function classifyError(error: unknown): ProbeErrorReason {
  const text = (
    error instanceof Error ? `${error.name} ${error.message}` : String(error)
  ).toLowerCase();

  if (text.includes("timeout") || text.includes("etimedout")) {
    return "timeout";
  }

  if (text.includes("enotfound") || text.includes("eai_again")) {
    return "dns";
  }

  if (text.includes("econnrefused")) {
    return "connection_refused";
  }

  if (text.includes("cert") || text.includes("tls") || text.includes("ssl")) {
    return "tls";
  }

  if (text.includes("abort")) {
    return "aborted";
  }

  return "unknown";
}

interface BodyPrefix {
  readonly text: string;
  readonly bytesRead: number;
  readonly wasTruncated: boolean;
}

/**
 * Read at most `maxBytes` of a body and stop.
 *
 * The cap is the point. Phase 0 found the action plan's claim that GET bodies
 * were unbounded to be wrong — legacy already caps them — and the reason is
 * arithmetic: sniffing whole pages across a fleet moves gigabytes to read a few
 * kilobytes of signal. The request also sends a `Range` header, so a
 * well-behaved server never transmits more than is read; this is the guard for
 * servers that ignore it.
 */
async function readBodyPrefix(
  body: Readable,
  maxBytes: number
): Promise<BodyPrefix> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let wasTruncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string | Uint8Array);
    const remaining = maxBytes - bytesRead;

    if (buffer.length >= remaining) {
      chunks.push(buffer.subarray(0, remaining));
      bytesRead += remaining;
      wasTruncated = true;
      break;
    }

    chunks.push(buffer);
    bytesRead += buffer.length;
  }

  // Destroyed rather than left to drain: without this the connection stays
  // busy streaming a body nobody is reading, which holds a concurrency slot
  // the rate limiter has already accounted for as free.
  body.destroy();

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytesRead,
    wasTruncated
  };
}

function firstHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value[0] === undefined ? undefined : String(value[0]);
  }

  return value === undefined || value === null ? undefined : String(value);
}

/**
 * Probe one URL: HEAD first, GET only when the HEAD result is suspicious.
 *
 * The escalation paths, and there are exactly two:
 *
 *   1. The HEAD was METHOD-REJECTED (400/405/501). That is the server refusing
 *      the verb, not a verdict on the URL, so it is re-probed with GET and
 *      classified on THAT. Reporting a 405 as the URL's status would call a
 *      working page broken because of how we asked.
 *   2. The HEAD returned 2xx and the body needs sniffing for a soft-404. The
 *      status says fine and the body may not, and the body is what gets
 *      indexed.
 *
 * Everything else — 404, 410, 5xx, 3xx — is answered by the HEAD alone, which
 * is what makes the design cheap. A hard 404 costs exactly one request.
 */
export async function probeUrl(
  url: string,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const budget = options.budget ?? DEFAULT_PROBE_BUDGET;
  const ladder = dedupeLadder(
    options.profileLadder ?? DEFAULT_PROFILE_LADDER
  ).slice(0, MAX_ATTEMPTS);

  let last: ProbeResult | undefined;

  for (const profile of ladder) {
    const result = await probeWithProfile(url, profile, budget, options);

    last = result;

    // Stop at the first REAL measurement. A refusal or a transport failure is
    // the only thing worth trying the next rung for; a 404 is an answer.
    if (!isRefusal(result)) {
      return result;
    }
  }

  return last ?? emptyResult(url);
}

function isRefusal(result: ProbeResult): boolean {
  if (result.errorReason !== undefined) {
    return true;
  }

  return result.httpStatus === 403 || result.httpStatus === 429;
}

function dedupeLadder(
  ladder: readonly RequestProfile[]
): readonly RequestProfile[] {
  const kept: RequestProfile[] = [];

  for (const profile of ladder) {
    // A rung byte-identical to an earlier one spends a request to get the same
    // answer — the exact mistake legacy made by reusing its own UA as fallback.
    if (!kept.some((existing) => isSameProfile(existing, profile))) {
      kept.push(profile);
    }
  }

  return kept;
}

function emptyResult(url: string): ProbeResult {
  return {
    url,
    httpStatus: null,
    methodUsed: undefined,
    escalatedToGet: false,
    methodRejectedStatus: undefined,
    soft404: undefined,
    location: undefined,
    errorReason: "unknown",
    responseMs: 0,
    requestCount: 0,
    profileUsed: undefined
  };
}

async function probeWithProfile(
  url: string,
  profile: RequestProfile,
  budget: ProbeBudget,
  options: ProbeOptions
): Promise<ProbeResult> {
  const send = options.fetch ?? request;
  const headers = headersFor(profile);
  const started = Date.now();

  let requestCount = 0;

  const charge = async (): Promise<() => void> => {
    requestCount += 1;

    return (await options.beforeRequest?.(url)) ?? (() => {});
  };

  try {
    const headRelease = await charge();
    // Typed from the sender rather than left to inference: an untyped `let`
    // assigned inside a try is implicitly `any`, which would silently erase the
    // status and header types this whole function branches on.
    let head: Awaited<ReturnType<typeof send>>;

    try {
      head = await send(url, {
        method: "HEAD",
        headers,
        headersTimeout: budget.timeoutMs,
        bodyTimeout: budget.timeoutMs
      });
      head.body.destroy();
    } finally {
      headRelease();
    }

    const status = head.statusCode;
    const location = firstHeader(head.headers["location"]);

    // --- Escalation 1: the verb was refused, not the URL -------------------
    if (METHOD_REJECTION_STATUSES.has(status)) {
      const getRelease = await charge();

      try {
        const fallback = await send(url, {
          method: "GET",
          headers: {
            ...headers,
            range: `bytes=0-${budget.methodFallbackBodyBytes - 1}`
          },
          headersTimeout: budget.timeoutMs,
          bodyTimeout: budget.timeoutMs
        });

        await readBodyPrefix(fallback.body, budget.methodFallbackBodyBytes);

        return {
          url,
          httpStatus: fallback.statusCode,
          methodUsed: "GET",
          escalatedToGet: true,
          methodRejectedStatus: status,
          soft404: undefined,
          location: firstHeader(fallback.headers["location"]),
          errorReason: undefined,
          responseMs: Date.now() - started,
          requestCount,
          profileUsed: profile.name
        };
      } finally {
        getRelease();
      }
    }

    // --- Escalation 2: a 2xx whose body may disagree with it ---------------
    const is2xx = status >= 200 && status < 300;

    if (is2xx && options.skipSoft404Sniff !== true) {
      const sniffRelease = await charge();

      try {
        const sniff = await send(url, {
          method: "GET",
          headers: {
            ...headers,
            range: `bytes=0-${budget.soft404BodyBytes - 1}`
          },
          headersTimeout: budget.timeoutMs,
          bodyTimeout: budget.timeoutMs
        });

        const prefix = await readBodyPrefix(
          sniff.body,
          budget.soft404BodyBytes
        );

        return {
          url,
          httpStatus: status,
          methodUsed: "HEAD",
          escalatedToGet: true,
          methodRejectedStatus: undefined,
          soft404: detectSoft404(prefix.text, prefix),
          location,
          errorReason: undefined,
          responseMs: Date.now() - started,
          requestCount,
          profileUsed: profile.name
        };
      } finally {
        sniffRelease();
      }
    }

    // --- The cheap path: one request, and an answer -------------------------
    return {
      url,
      httpStatus: status,
      methodUsed: "HEAD",
      escalatedToGet: false,
      methodRejectedStatus: undefined,
      soft404: undefined,
      location,
      errorReason: undefined,
      responseMs: Date.now() - started,
      requestCount,
      profileUsed: profile.name
    };
  } catch (error) {
    return {
      url,
      httpStatus: null,
      methodUsed: undefined,
      escalatedToGet: false,
      methodRejectedStatus: undefined,
      soft404: undefined,
      location: undefined,
      errorReason: classifyError(error),
      responseMs: Date.now() - started,
      requestCount,
      profileUsed: profile.name
    };
  }
}
