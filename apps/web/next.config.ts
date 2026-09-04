import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * Load the repo-root `.env` into this process before anything reads it.
 *
 * Next only auto-loads `.env` files sitting beside the app (`apps/web/`), but
 * this monorepo keeps one machine-local `.env` at the root — which is what
 * `apps/api` reads too, via `tsx --env-file-if-exists=../../.env`. Without this
 * the web process starts with `WEB_API_URL` unset, `lib/api.ts` silently falls
 * back to `http://localhost:3001`, and on a machine where that port belongs to
 * another service every screen fails with that service's 404 rather than
 * anything naming the real problem.
 *
 * Done here rather than as a `node --env-file-if-exists` flag on the `dev`
 * script because `next dev` re-spawns its server through `NODE_OPTIONS`, which
 * rejects that flag. Next evaluates this config in the dev server process as
 * well as the CLI one, so the assignment lands where the routes actually read
 * it. Real environment variables win: `loadEnvFile` does not overwrite a key
 * that is already set, so CI and deployed environments are unaffected.
 */
const rootEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources compiled by tsc, not bundled, so
  // Next needs to be told they are first-party rather than node_modules.
  transpilePackages: ["@pattern-aware/shared"]
};

export default nextConfig;
