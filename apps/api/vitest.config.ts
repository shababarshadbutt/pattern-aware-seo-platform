import { defineConfig } from "vitest/config";

/**
 * API integration tests.
 *
 * They live in `test/` rather than beside the source deliberately: they import
 * `@pattern-aware/database/testing`, and the condition attached to that
 * subpath (CODING_STANDARDS section 1.4, enforced by `compile-guards.test.ts`)
 * is that it is never imported from `apps/*​/src`. Keeping them out of `src`
 * satisfies that literally rather than by argument.
 *
 * Long timeouts because each suite creates and migrates a real database —
 * a mocked query layer would not exercise the scoping these tests exist to
 * prove.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
});
