/**
 * The platform's domain error hierarchy.
 *
 * WHY A HIERARCHY rather than `throw new Error(...)` everywhere. Callers need
 * to distinguish an expected failure mode (a host refused us; a sitemap is
 * oversized) from a bug, because the two get handled completely differently:
 * the first is data about the target site and belongs in a report, the second
 * should fail a job loudly. A bare `Error` collapses that distinction and turns
 * "this client blocks crawlers" into "the worker crashed". See
 * docs/CODING_STANDARDS.md 1.5.
 */
export abstract class PlatformError extends Error {
  /**
   * True when this represents something true about the world (a refusal, an
   * oversized sitemap) rather than a defect in this code. Expected failures are
   * recorded and reported; unexpected ones fail the job.
   */
  public abstract readonly isExpected: boolean;

  public constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration, wiring, or invariant failures. Always a defect. */
export class InvariantError extends PlatformError {
  public readonly isExpected = false;
}

/** A failure inside the statistical core. Always a defect — see packages/sampling. */
export class SamplingError extends PlatformError {
  public readonly isExpected = false;
}

/** A sitemap could not be parsed, fetched, or made sense of. */
export class SitemapParseError extends PlatformError {
  public readonly isExpected = true;
}

/** A population scan could not complete. */
export class PopulationScanError extends PlatformError {
  public readonly isExpected = true;
}

/**
 * A target host refused us — 429, 403, WAF challenge, or an open circuit.
 *
 * Deliberately its own type: a refusal must never be recorded as a site health
 * problem. Patterns behind one are BLOCKED, not BROKEN.
 */
export class HostRefusedError extends PlatformError {
  public readonly isExpected = true;

  public constructor(
    message: string,
    public readonly host: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
  }
}

/** A run exceeded a configured population or budget threshold. */
export class BudgetExceededError extends PlatformError {
  public readonly isExpected = true;
}
