/**
 * Stop probing a host that is refusing us.
 *
 * The distinction this enforces is the one that runs through the whole product:
 * a host answering 429 or 403 is REFUSING, not reporting a broken page.
 * Continuing to probe it spends budget to learn the same fact repeatedly, and —
 * worse — recording those refusals as findings would report a healthy,
 * crawler-blocking client as the worst site on the fleet.
 *
 * So an open circuit marks the affected patterns BLOCKED rather than BROKEN.
 * Legacy migration `042` draws exactly this line, and ADR-0014 carries it into
 * the severity table, where `blocked` weighs zero.
 */

export interface CircuitBreakerOptions {
  /** Consecutive 429s before the circuit opens. */
  readonly openAfter429?: number;
  /**
   * Consecutive 403s before the circuit opens.
   *
   * Higher than the 429 threshold on purpose. A 429 is the server explicitly
   * saying "too fast", which is unambiguous and worth believing immediately. A
   * 403 is ambiguous — it can equally be one genuinely forbidden URL among
   * healthy ones — so it takes more of them in a row to conclude the host
   * rather than the URL is the problem.
   */
  readonly openAfter403?: number;
  /** How long the circuit stays open. */
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export type CircuitState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "open";
      readonly reason: "TOO_MANY_REQUESTS" | "FORBIDDEN";
      readonly opensUntil: number;
      readonly consecutiveRefusals: number;
    };

interface HostCircuit {
  consecutive429: number;
  consecutive403: number;
  openUntil: number;
  reason: "TOO_MANY_REQUESTS" | "FORBIDDEN" | undefined;
}

const DEFAULTS = {
  openAfter429: 5,
  openAfter403: 10,
  cooldownMs: 300_000
} as const;

export class HostCircuitBreaker {
  readonly #hosts = new Map<string, HostCircuit>();
  readonly #openAfter429: number;
  readonly #openAfter403: number;
  readonly #cooldownMs: number;
  readonly #now: () => number;

  public constructor(options: CircuitBreakerOptions = {}) {
    this.#openAfter429 = options.openAfter429 ?? DEFAULTS.openAfter429;
    this.#openAfter403 = options.openAfter403 ?? DEFAULTS.openAfter403;
    this.#cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
    this.#now = options.now ?? Date.now;
  }

  /** Ask before probing. An open circuit means do not send the request. */
  public stateFor(host: string): CircuitState {
    const circuit = this.#hosts.get(host);

    if (circuit === undefined || circuit.reason === undefined) {
      return { kind: "closed" };
    }

    if (this.#now() >= circuit.openUntil) {
      /**
       * Cooldown elapsed: close, and reset the counters.
       *
       * Resetting matters. Without it a host that refused five times an hour
       * ago would re-open on its first refusal after every cooldown, and a
       * host with an occasional genuine 403 would never stay closed.
       */
      circuit.reason = undefined;
      circuit.consecutive429 = 0;
      circuit.consecutive403 = 0;

      return { kind: "closed" };
    }

    return {
      kind: "open",
      reason: circuit.reason,
      opensUntil: circuit.openUntil,
      consecutiveRefusals:
        circuit.reason === "TOO_MANY_REQUESTS"
          ? circuit.consecutive429
          : circuit.consecutive403
    };
  }

  /**
   * Record what a probe came back with.
   *
   * CONSECUTIVE, not cumulative: any non-refusal resets both counters, because
   * a host that answers normally in between is not refusing us — it has one bad
   * URL, or had one bad moment. Counting cumulatively would eventually open the
   * circuit on every long-running site.
   */
  public record(host: string, status: number | null): void {
    const circuit = this.#circuitFor(host);

    if (status === 429) {
      circuit.consecutive429 += 1;
      circuit.consecutive403 = 0;

      if (circuit.consecutive429 >= this.#openAfter429) {
        circuit.reason = "TOO_MANY_REQUESTS";
        circuit.openUntil = this.#now() + this.#cooldownMs;
      }

      return;
    }

    if (status === 403) {
      circuit.consecutive403 += 1;
      circuit.consecutive429 = 0;

      if (circuit.consecutive403 >= this.#openAfter403) {
        circuit.reason = "FORBIDDEN";
        circuit.openUntil = this.#now() + this.#cooldownMs;
      }

      return;
    }

    circuit.consecutive429 = 0;
    circuit.consecutive403 = 0;
  }

  #circuitFor(host: string): HostCircuit {
    let circuit = this.#hosts.get(host);

    if (circuit === undefined) {
      circuit = {
        consecutive429: 0,
        consecutive403: 0,
        openUntil: 0,
        reason: undefined
      };
      this.#hosts.set(host, circuit);
    }

    return circuit;
  }
}
