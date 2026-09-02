import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./config.js";

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
