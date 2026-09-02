import { describe, expect, it } from "vitest";

import { HostRateLimiter, rateLimitKey } from "./rate-limiter.js";

/**
 * A controllable clock. Real timers would make these tests slow and flaky, and
 * the property under test is the SPACING the limiter computes, not whether
 * setTimeout works.
 */
function fakeClock() {
  let now = 0;
  const slept: number[] = [];

  return {
    now: () => now,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe("rateLimitKey", () => {
  /**
   * Host and port, lowercased — the same key legacy uses, and for the reason it
   * gives: a probe can be sent to the `www` variant of a base URL, so keying on
   * the site's configured domain would charge the wrong budget.
   */
  it("keys on host and port", () => {
    expect(rateLimitKey("https://Client.TEST/a/b")).toBe("client.test");
    expect(rateLimitKey("https://client.test:8443/a")).toBe("client.test:8443");
  });

  it("treats www and apex as different origins", () => {
    // They usually are different servers, and the one receiving the traffic is
    // the one whose budget applies.
    expect(rateLimitKey("https://www.client.test/a")).not.toBe(
      rateLimitKey("https://client.test/a")
    );
  });

  it("buckets an unparseable URL rather than throwing", () => {
    // It is about to fail anyway; sharing one bucket bounds the damage.
    expect(rateLimitKey("not a url")).toBe("invalid");
  });
});

describe("HostRateLimiter", () => {
  it("releases the first request immediately", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 10,
      concurrency: 4,
      now: clock.now,
      sleep: clock.sleep
    });

    const release = await limiter.acquire("client.test");

    expect(clock.slept).toEqual([]);
    release();
  });

  /**
   * The spacing is exact rather than approximate because each caller claims the
   * next free instant with no await between reading and writing it — so two
   * concurrent callers can never claim the same slot.
   */
  it("spaces requests at the configured interval", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 4,
      concurrency: 10,
      now: clock.now,
      sleep: clock.sleep
    });

    for (let index = 0; index < 4; index += 1) {
      (await limiter.acquire("client.test"))();
    }

    // 4 req/s is a 250 ms interval; the first is free, the rest wait.
    expect(clock.slept).toEqual([250, 250, 250]);
  });

  it("gives every host its own budget", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 1,
      concurrency: 4,
      now: clock.now,
      sleep: clock.sleep
    });

    (await limiter.acquire("a.test"))();
    (await limiter.acquire("b.test"))();

    // Verifying two clients in parallel must not serialise them behind each
    // other — the unit being protected is one origin server.
    expect(clock.slept).toEqual([]);
  });

  /**
   * The other half of the design: concurrency bounds simultaneous SOCKETS,
   * which is what exhausts a target's connection pool, while rate bounds
   * requests over time, which is what trips WAF rules. They are limited
   * separately because they bound different failure modes.
   */
  it("bounds simultaneous requests independently of rate", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 1_000,
      concurrency: 2,
      now: clock.now,
      sleep: clock.sleep
    });

    const first = await limiter.acquire("client.test");
    const second = await limiter.acquire("client.test");

    expect(limiter.inFlight("client.test")).toBe(2);

    let thirdAcquired = false;
    const third = limiter.acquire("client.test").then((release) => {
      thirdAcquired = true;

      return release;
    });

    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    first();
    (await third)();
    second();

    expect(limiter.inFlight("client.test")).toBe(0);
  });

  it("hands waiting callers their slots in arrival order", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 1_000,
      concurrency: 1,
      now: clock.now,
      sleep: clock.sleep
    });

    const order: number[] = [];
    const held = await limiter.acquire("client.test");

    const queued = [1, 2, 3].map((id) =>
      limiter.acquire("client.test").then((release) => {
        order.push(id);
        release();
      })
    );

    held();
    await Promise.all(queued);

    expect(order).toEqual([1, 2, 3]);
  });

  /**
   * A leaked slot is worse than a slow one: the limiter would believe it has
   * capacity it does not, and drift permanently. Releasing twice is a plausible
   * mistake in a `finally`, so it must be harmless.
   */
  it("ignores a double release", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 1_000,
      concurrency: 2,
      now: clock.now,
      sleep: clock.sleep
    });

    const release = await limiter.acquire("client.test");

    release();
    release();

    expect(limiter.inFlight("client.test")).toBe(0);
  });

  it("does not make up for idle time", async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({
      requestsPerSecond: 2,
      concurrency: 4,
      now: clock.now,
      sleep: clock.sleep
    });

    (await limiter.acquire("client.test"))();
    clock.advance(10_000);
    (await limiter.acquire("client.test"))();

    // No burst credit accrued while idle. A limiter that banked unused capacity
    // would deliver a spike to a server that had just been left alone, which is
    // exactly what monitoring flags.
    expect(clock.slept).toEqual([]);
  });

  it("rejects a nonsensical configuration", () => {
    expect(
      () => new HostRateLimiter({ requestsPerSecond: 0, concurrency: 1 })
    ).toThrow(RangeError);
    expect(
      () => new HostRateLimiter({ requestsPerSecond: 1, concurrency: 0 })
    ).toThrow(RangeError);
  });
});
