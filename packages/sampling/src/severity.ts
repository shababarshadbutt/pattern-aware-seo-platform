/**
 * How bad each kind of outcome is, and how to tell which kind you have.
 *
 * The weights here are a BUSINESS decision, not an engineering one, and they
 * were treated as such: ratified by Shabab Arshad on 2026-09-02 with the
 * reasoning recorded in ADR-0014. `CLAUDE.md` forbids guessing them, so there
 * is deliberately no silent fallback anywhere in this module — a caller that
 * does not supply a table gets an error, not a plausible default that could
 * quietly become the shipped answer.
 */

/**
 * What a probe found, classified into things that differ in how much they hurt.
 *
 * `blocked` is in this list but is NOT a severity. A host refusing us is an
 * absence of measurement, not a defect in the site, and scoring it as damage
 * would let a WAF turn a healthy client into a P0. It is kept in the union so
 * that classification is total and a caller cannot forget the case.
 */
export type SeverityClass =
  | "gone"
  | "not_found"
  | "soft_not_found"
  | "server_error"
  | "redirect_chain"
  | "redirect_single"
  | "ok"
  | "blocked"
  | "unknown";

/** Multipliers in [0, 1]. See ADR-0014 for why each one sits where it does. */
export type SeverityTable = Readonly<Record<SeverityClass, number>>;

/** Thrown when scoring is attempted without a ratified severity table. */
export class MissingSeverityTableError extends Error {
  public override readonly name = "MissingSeverityTableError";

  public constructor() {
    super(
      "No severity table supplied. These weights are a business decision (ADR-0014) and this module deliberately has no default — see CLAUDE.md."
    );
  }
}

/**
 * The ratified weights, as decided on 2026-09-02.
 *
 * Exported so a deployment can load them from config rather than hard-code
 * them, and named for what it is — a specific ratified table, not a default.
 * Nothing in this module reaches for it implicitly.
 *
 *   410 / 404 (1.0)  A gone page is a definite loss of an indexed URL, and the
 *                    thing a client is paying to find out about.
 *   soft-404 (0.9)   Worse than a hard 404 for index quality, because Google
 *                    may keep the URL indexed pointing at a useless page — but
 *                    it is a detection inference rather than a status the
 *                    server asserted, so it sits just below.
 *   5xx (0.8)        Severe, but frequently transient, and a sampled 5xx may
 *                    say more about the moment than the URL.
 *   3xx chain (0.4)  Multiple hops leak link equity and waste crawl budget.
 *   3xx single (0.15) Working as intended most of the time; noted, not alarming.
 *   2xx (0)          Not a finding.
 *   blocked (0)      Not a finding either. An absence of measurement.
 *   unknown (0)      Refuses to invent a weight for something unclassified.
 */
export const RATIFIED_SEVERITY_TABLE: SeverityTable = Object.freeze({
  gone: 1,
  not_found: 1,
  soft_not_found: 0.9,
  server_error: 0.8,
  redirect_chain: 0.4,
  redirect_single: 0.15,
  ok: 0,
  blocked: 0,
  unknown: 0
});

/** One probe's result, in the terms classification needs. */
export interface ProbeOutcome {
  /** Null when no status was obtained at all — a timeout, DNS or TLS failure. */
  readonly httpStatus: number | null;
  /** True when a 2xx body was detected as a not-found page. */
  readonly isSoft404?: boolean;
  /** Redirect hops followed. Two or more is a chain. */
  readonly redirectHops?: number;
  /** Set when the host refused us: a WAF challenge, an open circuit, 429/403. */
  readonly isBlocked?: boolean;
}

/**
 * Decide which severity class an outcome belongs to.
 *
 * Order matters. `blocked` is tested FIRST, ahead of the status code, because a
 * 403 is both a status and a refusal — and treating it as a client-error
 * finding is the mistake that turns "this site blocks crawlers" into "this site
 * is broken", poisoning every downstream estimate and impact score. Legacy
 * migration `042` draws the same line for the same reason.
 */
export function classifyOutcome(outcome: ProbeOutcome): SeverityClass {
  if (outcome.isBlocked === true) {
    return "blocked";
  }

  const status = outcome.httpStatus;

  if (status === null) {
    // No status at all. Could be a broken URL or a network blip; without
    // evidence which, inventing a severity would be guessing.
    return "unknown";
  }

  // 429 and 403 are refusals whether or not the caller already knew that.
  if (status === 429 || status === 403) {
    return "blocked";
  }

  if (status === 410) {
    return "gone";
  }

  if (status === 404) {
    return "not_found";
  }

  if (status >= 500) {
    return "server_error";
  }

  if (status >= 300 && status < 400) {
    return (outcome.redirectHops ?? 1) > 1
      ? "redirect_chain"
      : "redirect_single";
  }

  if (status >= 200 && status < 300) {
    // A 200 that a soft-404 sniff caught. The status says fine, the body does
    // not, and the body is what a search engine indexes.
    return outcome.isSoft404 === true ? "soft_not_found" : "ok";
  }

  return "unknown";
}

/**
 * Look up a weight, refusing to improvise.
 *
 * @throws {MissingSeverityTableError} when no table was supplied.
 */
export function severityFor(
  severityClass: SeverityClass,
  table: SeverityTable | undefined
): number {
  if (table === undefined) {
    throw new MissingSeverityTableError();
  }

  const weight = table[severityClass];

  if (weight === undefined || !Number.isFinite(weight)) {
    throw new MissingSeverityTableError();
  }

  return weight;
}

/** True for classes that represent an absence of measurement, not a defect. */
export function isAbsenceOfEvidence(severityClass: SeverityClass): boolean {
  return severityClass === "blocked" || severityClass === "unknown";
}
