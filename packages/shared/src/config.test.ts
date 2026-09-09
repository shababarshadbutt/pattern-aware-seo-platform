import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, loadPolicyConfig } from "./config.js";

const MINIMAL_ENV = {
  DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379"
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("accepts a minimal environment and fills in every default", () => {
    const config = loadConfig(MINIMAL_ENV);

    expect(config.NODE_ENV).toBe("development");
    expect(config.API_PORT).toBe(3001);
    expect(config.PARSE_MAX_THREADS).toBe(4);
    expect(config.HTTP_PER_HOST_REQUESTS_PER_SECOND).toBe(25);
    expect(config.HTTP_MAX_GET_ESCALATION_FRACTION).toBe(0.2);
  });

  it("coerces numeric variables from the strings the environment actually supplies", () => {
    const config = loadConfig({ ...MINIMAL_ENV, API_PORT: "8080" });

    expect(config.API_PORT).toBe(8080);
  });

  // The whole point of validating at startup: a missing REDIS_URL must fail
  // here, not three jobs into a worker run.
  it("rejects a missing required variable", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: MINIMAL_ENV.DATABASE_URL })
    ).toThrow(ConfigError);
  });

  it("rejects a malformed URL rather than passing it to a driver", () => {
    expect(() =>
      loadConfig({ ...MINIMAL_ENV, REDIS_URL: "not-a-url" })
    ).toThrow(ConfigError);
  });

  // Reporting one problem at a time makes a broken deployment a guessing game.
  it("reports every invalid variable in a single error", () => {
    let message = "";

    try {
      loadConfig({ DATABASE_URL: "nope", REDIS_URL: "also-nope" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("REDIS_URL");
  });

  it("returns a frozen object so no caller can mutate shared configuration", () => {
    expect(Object.isFrozen(loadConfig(MINIMAL_ENV))).toBe(true);
  });
});

describe("loadPolicyConfig", () => {
  it("succeeds on an empty environment, because every policy key is defaulted", () => {
    /**
     * This is the property the API's Settings route depends on: a test — and a
     * process that only serves policy numbers — can build this half of the
     * config without holding a DATABASE_URL. `loadConfig({})` throws.
     */
    const policy = loadPolicyConfig({});

    expect(policy.HTTP_PER_HOST_REQUESTS_PER_SECOND).toBe(25);
    expect(policy.HTTP_PER_SITE_DAILY_REQUEST_CAP).toBe(250_000);
    expect(policy.SAMPLE_MAX_FIRST_ROUND).toBe(400);
    expect(policy.CONFIDENCE_LOW_BAND_WIDTH).toBe(0.5);
  });

  it("carries no secret, and not because anything filtered one out", () => {
    /**
     * THE POINT OF THE MASK. `.pick()` can only narrow, so a credential is not
     * absent here because a redaction step removed it — it was never
     * reachable. A redaction list is a thing to forget to update when a
     * variable is added, and forgetting it publishes a credential.
     *
     * Asserted by SHAPE rather than by naming today's secrets, so a secret
     * added to configSchema later cannot pass this by not being on a list.
     */
    const policy = loadPolicyConfig({
      DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      AUTH_SECRET: "super-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret"
    });

    const entries = Object.entries(policy);

    expect(entries).not.toHaveLength(0);

    for (const [key, value] of entries) {
      // THE STRUCTURAL PROPERTY: every limit is a NUMBER, and a credential
      // never is. This holds without knowing which variables are secret, so a
      // secret added to configSchema later cannot pass by not being on a list.
      expect(typeof value, key).toBe("number");
      // `_URL` singular is a connection string; `_URLS` is a count of URLs.
      expect(key).not.toMatch(/SECRET|PASSWORD|TOKEN|ACCESS_KEY|_URL$/u);
    }

    expect(JSON.stringify(policy)).not.toContain("super-secret");
    expect(JSON.stringify(policy)).not.toContain("aws-secret");
  });

  it("shares one definition with loadConfig rather than restating it", () => {
    // A mask cannot drift from what it masks. If someone changes a default in
    // configSchema and not here, that is not possible — there is no "here".
    const full = loadConfig({
      DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
      REDIS_URL: "redis://localhost:6379",
      HTTP_PER_HOST_REQUESTS_PER_SECOND: "7",
      SAMPLE_MIN_SIZE: "11"
    });
    const policy = loadPolicyConfig({
      HTTP_PER_HOST_REQUESTS_PER_SECOND: "7",
      SAMPLE_MIN_SIZE: "11"
    });

    expect(policy.HTTP_PER_HOST_REQUESTS_PER_SECOND).toBe(
      full.HTTP_PER_HOST_REQUESTS_PER_SECOND
    );
    expect(policy.SAMPLE_MIN_SIZE).toBe(full.SAMPLE_MIN_SIZE);
  });

  it("reports an invalid policy value rather than silently defaulting it", () => {
    expect(() => loadPolicyConfig({ HTTP_PER_HOST_CONCURRENCY: "0" })).toThrow(
      ConfigError
    );
  });
});
