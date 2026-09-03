import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount between tests.
 *
 * Testing Library registers this itself only when vitest runs with globals
 * enabled. This project runs with `globals: false` (explicit imports, no
 * ambient magic), so without this every render accumulates in the same jsdom
 * document and a query that should match one element matches all of them —
 * which surfaces as a confusing "found multiple elements" failure in whichever
 * test happens to run second, not in the one that leaked.
 */
afterEach(() => {
  cleanup();
});
