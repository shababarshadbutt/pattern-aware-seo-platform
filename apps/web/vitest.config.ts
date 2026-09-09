import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Component and pure-logic tests for the dashboard.
 *
 * jsdom rather than a browser runner: everything tested here is either a pure
 * function or a Server Component's output shape, so a real browser buys
 * nothing the DOM implementation does not already give. The end-to-end path
 * through a real browser is Playwright's job, later.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["{app,components,lib}/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    globals: false
  }
});
