import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources compiled by tsc, not bundled, so
  // Next needs to be told they are first-party rather than node_modules.
  transpilePackages: ["@pattern-aware/shared"]
};

export default nextConfig;
