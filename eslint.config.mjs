import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/node_modules/**",
      "**/coverage/**"
    ]
  },
  {
    // A DELIBERATELY NARROW ESLint pass.
    //
    // Biome is the linter and formatter for this repo (docs/CODING_STANDARDS.md
    // section 4, ADR-0006). It is fast and covers almost everything — but it
    // cannot express type-aware rules, and the two below are named explicitly
    // in the standards because this codebase is async end to end: a floating
    // promise in a worker means a job silently reports success while its work
    // is still running, and a promise passed where a sync callback is expected
    // means an error nobody ever sees.
    //
    // ESLint exists here for exactly these two rules. Do not grow this file
    // into a second linter — if a rule can be expressed in Biome, it belongs in
    // biome.json.
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  }
);
