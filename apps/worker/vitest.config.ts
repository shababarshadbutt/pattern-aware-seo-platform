import { defineConfig } from "vitest/config";

/**
 * Worker orchestration tests: `SitePipeline` against a real Redis and a real
 * Postgres.
 *
 * Live in `test/` rather than beside the source for the same reason
 * `apps/api`'s do: they import `@pattern-aware/database/testing`, and
 * `compile-guards.test.ts` enforces that subpath is never imported from
 * `apps/*​/src`.
 *
 * Long timeouts: each suite creates and migrates a real database AND drains
 * real BullMQ queues over a real Redis connection, and one test deliberately
 * waits out BullMQ's exponential backoff to prove exhausted-retries recovery.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
