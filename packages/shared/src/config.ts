import { z } from "zod";

/**
 * Every environment variable this platform reads, validated exactly once.
 *
 * WHY THIS EXISTS AS ONE MODULE. A missing `REDIS_URL` discovered three jobs
 * into a worker run is a far more expensive bug than the same value rejected at
 * process start, and scattered `process.env.X` reads make it impossible to know
 * what a deployment actually needs without grepping the whole codebase. See
 * docs/CODING_STANDARDS.md 1.7.
 *
 * WHY THE OPERATIONAL LIMITS LIVE HERE TOO, rather than as constants next to
 * the code that uses them. Every number in the "budgets" sections below bounds
 * something that costs real money or points real traffic at somebody else's
 * production web server. Those need to be tunable per environment without a
 * code change, and auditable in one place — "what will this deployment do to a
 * client's origin?" should be answerable by reading one file.
 */

/** A URL that `new URL()` accepts. Kept as a helper so the failure message names the variable. */
const urlString = z.string().refine(
  (value) => {
    try {
      new URL(value);

      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid absolute URL" }
);

const configSchema = z.object({
  // --- App ---
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  // Only the internal team logs in today (see schema/tenancy.ts), so the API
  // has no session to derive an OrganizationScope from yet. This stands in
  // until real auth exists in M7 and row-level security attaches to
  // organization_id — every route that touches this must say so in a comment,
  // not bury the placeholder silently.
  DEFAULT_ORGANIZATION_SLUG: z.string().min(1).default("asapsemi-demo"),

  // --- Infrastructure ---
  DATABASE_URL: urlString,
  REDIS_URL: urlString,

  // --- AWS ---
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  S3_DEV_BUCKET: z.string().optional(),

  // --- Auth ---
  AUTH_SECRET: z.string().min(1).optional(),
  // A deployment stopgap, not the real auth M7/ADR-0026 deferred: HTTP Basic
  // Auth in front of both the API and the web app so a deployment reachable
  // from the public internet isn't a bare, unauthenticated `POST /sites`.
  // Optional so local dev is unaffected; `apps/api` refuses to start if only
  // one of the pair is set, since a half-configured credential is worse than
  // none (it looks protected and isn't).
  BASIC_AUTH_USER: z.string().min(1).optional(),
  BASIC_AUTH_PASSWORD: z.string().min(1).optional(),

  // --- ML service (Phase 4; unused until ml-service/ is active) ---
  ML_SERVICE_URL: urlString.optional(),

  // --- Worker resource budgets ---
  // The worker's own Postgres pool, budgeted apart from the API's. An ingest
  // pass streaming a large site must not be able to exhaust the connections
  // the API needs to answer a dashboard request — the "population scan starves
  // the API" failure the architecture plan names explicitly.
  WORKER_DB_POOL_SIZE: z.coerce.number().int().min(1).max(64).default(8),
  // Where downloaded sitemap files live between pipeline stages. Local disk in
  // development; an S3-backed store replaces it in M8 without the stages
  // changing, since they take the store as an interface.
  SITEMAP_STORE_ROOT: z.string().min(1).default(".sitemaps"),

  // --- Parse budgets: memory and concurrency ---
  // Piscina threads for the streaming SAX pass. Four is the legacy
  // POPULATION_MAX_WORKERS, chosen against heap arithmetic for a box also
  // running Postgres and Redis; raising it without redoing that arithmetic is
  // how a parse starts competing with the database it writes to.
  PARSE_MAX_THREADS: z.coerce.number().int().min(1).max(32).default(4),
  // Soft ceiling on in-memory min-heap sample state. On exceed, heaps flush to
  // pattern_population and merge on the next pass. Merging min-heaps-by-hash is
  // EXACT (the K smallest of a union is the correct K smallest overall), which
  // is what makes this cap safe to enforce mid-run.
  SAMPLE_HEAP_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .default(268_435_456),

  // --- Population thresholds: degrade, never silently truncate ---
  // Above the soft limit a run continues at a reduced sample rate and is
  // flagged DEGRADED. Above the hard limit it stops after counting — the
  // population is still reported honestly, because counting is streaming and
  // stays cheap at any size. A truncated sample presented as a complete one is
  // the failure mode these two numbers exist to prevent.
  POPULATION_SOFT_LIMIT_URLS: z.coerce
    .number()
    .int()
    .min(1)
    .default(20_000_000),
  POPULATION_HARD_LIMIT_URLS: z.coerce
    .number()
    .int()
    .min(1)
    .default(100_000_000),
  POPULATION_HARD_LIMIT_FILES: z.coerce.number().int().min(1).default(50_000),

  // --- Sampling bounds (see packages/sampling) ---
  SAMPLE_MIN_SIZE: z.coerce.number().int().min(1).default(30),
  SAMPLE_MAX_FIRST_ROUND: z.coerce.number().int().min(1).default(400),
  SAMPLE_MAX_EXPANDED: z.coerce.number().int().min(1).default(1_200),
  SAMPLE_MAX_EXPANSION_FACTOR: z.coerce.number().min(1).default(3),
  SAMPLE_MAX_POPULATION_FRACTION: z.coerce.number().min(0).max(1).default(0.25),
  SAMPLE_MIN_PER_STRATUM: z.coerce.number().int().min(1).default(5),
  // Relative interval width — (high - low) / point — above which an estimate is
  // "too uncertain to act on". Shared deliberately: it is both the adaptive
  // expansion trigger and the UI's LOW confidence band, and the two disagreeing
  // would mean the interface flags a pattern the engine considers settled.
  CONFIDENCE_LOW_BAND_WIDTH: z.coerce.number().min(0).default(0.5),
  CONFIDENCE_APPROXIMATE_BAND_WIDTH: z.coerce.number().min(0).default(0.2),
  // The same two cuts for an estimate of zero, where interval width is measured
  // against the population rather than against the estimate. Different numbers
  // because they bound a different quantity — see confidence-band.ts.
  CONFIDENCE_ZERO_HIT_LOW_BAND_WIDTH: z.coerce.number().min(0).default(0.1),
  CONFIDENCE_ZERO_HIT_APPROXIMATE_BAND_WIDTH: z.coerce
    .number()
    .min(0)
    .default(0.02),

  // --- Outbound HTTP budgets ---
  // These bound traffic at somebody else's origin. The per-host numbers are
  // measured, not guessed: this project has been WAF-blocked once already.
  HTTP_PER_HOST_REQUESTS_PER_SECOND: z.coerce.number().min(0.1).default(25),
  HTTP_PER_HOST_CONCURRENCY: z.coerce.number().int().min(1).default(8),
  HTTP_PLATFORM_DAILY_REQUEST_CAP: z.coerce
    .number()
    .int()
    .min(1)
    .default(5_000_000),
  HTTP_PER_SITE_DAILY_REQUEST_CAP: z.coerce
    .number()
    .int()
    .min(1)
    .default(250_000),
  HTTP_BUDGET_WARN_FRACTION: z.coerce.number().min(0).max(1).default(0.8),
  HTTP_BUDGET_HALT_FRACTION: z.coerce.number().min(0).max(1).default(0.95),
  // Share of one pattern's sample allowed to escalate HEAD -> GET before the
  // pattern is flagged for manual review. Without it, a genuinely broken
  // pattern defeats the entire point of the HEAD-first design.
  HTTP_MAX_GET_ESCALATION_FRACTION: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.2),
  // Circuit breaker. A host that answers 429 or 403 is refusing us, not
  // reporting a broken page — patterns behind an open circuit are marked
  // BLOCKED, never BROKEN.
  HTTP_CIRCUIT_BREAK_AFTER_429: z.coerce.number().int().min(1).default(5),
  HTTP_CIRCUIT_BREAK_AFTER_403: z.coerce.number().int().min(1).default(10),
  HTTP_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(1_000).default(300_000)
});

/** The validated, fully-defaulted configuration for this process. */
export type Config = Readonly<z.infer<typeof configSchema>>;

/** Thrown when the environment cannot produce a usable {@link Config}. */
export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}

/**
 * Parse and validate an environment into a {@link Config}.
 *
 * Pure and explicitly parameterised so tests can exercise validation without
 * mutating `process.env` — which is process-global state that leaks between
 * concurrent test files.
 *
 * @throws {ConfigError} listing every invalid variable at once, rather than
 * failing on the first and making the reader re-run to find the next.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }

  return Object.freeze(result.data);
}

let cached: Config | undefined;

/**
 * The process-wide configuration, parsed on first call and reused thereafter.
 *
 * Call this once during startup so an invalid environment fails immediately and
 * loudly, then pass the result down rather than calling it from business logic.
 */
export function getConfig(): Config {
  cached ??= loadConfig();

  return cached;
}

/** Reset the memoised config. Test-only; production code has no reason to call it. */
export function resetConfigForTesting(): void {
  cached = undefined;
}

/**
 * The operational limits, as a mask over {@link configSchema}.
 *
 * WHY A `.pick()` AND NOT A SECOND SCHEMA. The API serves these to a Settings
 * screen, which needs the numbers without the credentials sitting beside them
 * in the same object. Hand-writing a parallel schema would restate every
 * `.default()` and every bound above, and the two would drift — the §1.13
 * shape exactly: two independently-correct definitions of one fact. A mask
 * cannot drift, because there is still only one definition.
 *
 * SECRETS ARE EXCLUDED BY CONSTRUCTION, not by filtering. `.pick()` can only
 * narrow, so `DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET` and the AWS keys are
 * not absent because something removed them — they were never reachable. That
 * matters more than a redaction step would: a redaction list is a thing to
 * forget to update when a variable is added, and forgetting it publishes a
 * credential.
 *
 * Every key here has a `.default()`, which is what lets `loadPolicyConfig({})`
 * succeed against an empty environment — so a test can construct the policy
 * half of a config without holding a database URL.
 */
const POLICY_KEYS = [
  "POPULATION_SOFT_LIMIT_URLS",
  "POPULATION_HARD_LIMIT_URLS",
  "POPULATION_HARD_LIMIT_FILES",
  "SAMPLE_MIN_SIZE",
  "SAMPLE_MAX_FIRST_ROUND",
  "SAMPLE_MAX_EXPANDED",
  "SAMPLE_MAX_EXPANSION_FACTOR",
  "SAMPLE_MAX_POPULATION_FRACTION",
  "SAMPLE_MIN_PER_STRATUM",
  "CONFIDENCE_LOW_BAND_WIDTH",
  "CONFIDENCE_APPROXIMATE_BAND_WIDTH",
  "CONFIDENCE_ZERO_HIT_LOW_BAND_WIDTH",
  "CONFIDENCE_ZERO_HIT_APPROXIMATE_BAND_WIDTH",
  "HTTP_PER_HOST_REQUESTS_PER_SECOND",
  "HTTP_PER_HOST_CONCURRENCY",
  "HTTP_PLATFORM_DAILY_REQUEST_CAP",
  "HTTP_PER_SITE_DAILY_REQUEST_CAP",
  "HTTP_BUDGET_WARN_FRACTION",
  "HTTP_BUDGET_HALT_FRACTION",
  "HTTP_MAX_GET_ESCALATION_FRACTION",
  "HTTP_CIRCUIT_BREAK_AFTER_429",
  "HTTP_CIRCUIT_BREAK_AFTER_403",
  "HTTP_CIRCUIT_COOLDOWN_MS"
] as const;

export const policyConfigSchema = configSchema.pick(
  Object.fromEntries(POLICY_KEYS.map((key) => [key, true as const])) as {
    readonly [K in (typeof POLICY_KEYS)[number]]: true;
  }
);

/**
 * The operational limits alone — a structural subset of {@link Config}.
 *
 * Because it is a subset, a caller holding the real validated `Config` already
 * satisfies it and nothing at the process edge changes.
 */
export type PolicyConfig = Readonly<z.infer<typeof policyConfigSchema>>;

/**
 * Parse an environment into a {@link PolicyConfig}.
 *
 * Reports every invalid variable at once, like {@link loadConfig}. Succeeds on
 * an empty environment, since every key it covers is defaulted.
 */
export function loadPolicyConfig(
  env: NodeJS.ProcessEnv = process.env
): PolicyConfig {
  const result = policyConfigSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new ConfigError(`Invalid policy configuration:\n${details}`);
  }

  return Object.freeze(result.data);
}
