/**
 * Outbound pacing, per target host.
 *
 * Every other concurrency limit in this codebase protects OUR infrastructure.
 * This one is different in kind: it points probes at a client's production web
 * server, the same origin serving their real customers. Ported from the legacy
 * engine's `hostRateLimiter.ts`, whose reasoning holds exactly.
 *
 * CONCURRENCY AND RATE ARE LIMITED SEPARATELY, because they bound different
 * failure modes. Concurrency bounds simultaneous sockets — what exhausts a
 * target's connection pool. Rate bounds requests over time — what shows up on
 * their monitoring as a spike and trips WAF rate rules. This project has been
 * WAF-blocked once already.
 *
 * PER HOST, and process-global. The unit being protected is one origin server,
 * so two sites on the same domain, or a sample running alongside a
 * verification, must share one budget — otherwise "25 requests per second"
 * quietly becomes fifty. Keying on host also means two different clients are
 * not needlessly serialised behind each other.
 *
 * KNOWN LIMIT, stated because it is easy to forget: this state is in-memory and
 * process-global, so the effective rate multiplies by the number of worker
 * containers. Correct for local development and a single worker; a Redis-backed
 * limiter is required before running more than one, and is scoped for the
 * multi-tenant hardening milestone.
 */

export interface RateLimiterOptions {
  /** Requests per second per host. */
  readonly requestsPerSecond: number;
  /** Simultaneous in-flight requests per host. */
  readonly concurrency: number;
  /** Injected for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injected for tests. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface HostState {
  /** The next instant a request may be released. */
  nextSlotAt: number;
  inFlight: number;
  /** Callers parked waiting for a concurrency slot, in arrival order. */
  readonly waiting: (() => void)[];
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Normalise a host into the key the budget is charged against.
 *
 * Host and port, lowercased. Not the domain and not the site: legacy keys it
 * this way because a probe can be sent to the `www` variant of a base URL, so
 * keying on the site's configured domain would charge the wrong budget.
 */
export function rateLimitKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    // Unparseable URLs still need a bucket rather than an exception; they are
    // about to fail anyway, and sharing one bucket bounds the damage.
    return "invalid";
  }
}

export class HostRateLimiter {
  readonly #hosts = new Map<string, HostState>();
  readonly #intervalMs: number;
  readonly #concurrency: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  public constructor(options: RateLimiterOptions) {
    if (options.requestsPerSecond <= 0 || options.concurrency <= 0) {
      throw new RangeError(
        "requestsPerSecond and concurrency must both be positive"
      );
    }

    this.#intervalMs = 1_000 / options.requestsPerSecond;
    this.#concurrency = options.concurrency;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Wait until ONE REQUEST to this host may be sent, then return a release
   * function.
   *
   * CHARGED PER REQUEST, NOT PER CHECK, and this is the single most important
   * thing about this class. One "check" is not one request: a 2xx costs a HEAD
   * plus a ranged soft-404 GET, a 3xx costs a HEAD plus a follow-up HEAD, and
   * only a hard 404 costs one. Legacy metered per check and MEASURED 49.17
   * req/s against a 25 req/s ceiling on a fast origin — very nearly double,
   * invisible at higher latency only because concurrency capped throughput
   * first.
   *
   * The unit the target server experiences is the request, so that is the unit
   * charged. Every outbound call in this package acquires here first.
   */
  public async acquire(host: string): Promise<() => void> {
    const state = this.#stateFor(host);

    await this.#awaitConcurrencySlot(state);

    /**
     * Scheduling is VIRTUAL, not a sleeping token bucket: the caller claims the
     * next free instant and then waits for it. The claim reads and writes
     * `nextSlotAt` with no `await` between, so two concurrent callers can never
     * claim the same slot — which makes the spacing exact rather than
     * approximate, and means N waiters each wake once instead of all
     * re-checking a shared bucket.
     */
    const now = this.#now();
    const slot = Math.max(now, state.nextSlotAt);

    state.nextSlotAt = slot + this.#intervalMs;

    const delay = slot - now;

    if (delay > 0) {
      await this.#sleep(delay);
    }

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      state.inFlight -= 1;

      const next = state.waiting.shift();

      if (next !== undefined) {
        next();
      }
    };
  }

  /** In-flight requests for a host. Test and diagnostics only. */
  public inFlight(host: string): number {
    return this.#hosts.get(host)?.inFlight ?? 0;
  }

  async #awaitConcurrencySlot(state: HostState): Promise<void> {
    if (state.inFlight < this.#concurrency) {
      state.inFlight += 1;

      return;
    }

    await new Promise<void>((resolve) => {
      state.waiting.push(() => {
        state.inFlight += 1;
        resolve();
      });
    });
  }

  #stateFor(host: string): HostState {
    let state = this.#hosts.get(host);

    if (state === undefined) {
      state = { nextSlotAt: 0, inFlight: 0, waiting: [] };
      this.#hosts.set(host, state);
    }

    return state;
  }
}
