Pattern-Aware SEO Platform — Agent Guide

This file is read automatically by Claude Code (and should be treated as load-bearing by any other coding agent working in this repo). It tells you what this project is, what's already been decided, and what rules to follow so the codebase stays consistent instead of accumulating whatever style each session or contributor happens to reach for.

Read before making non-trivial changes
docs/architecture-review-and-action-plan.md — the why: the product direction, the phased build order (Phase 0 through 5), and a list of open decisions that haven't been made yet. Don't build ahead of the current phase without checking this. As of M1, this doc has amendment sections for both Phase 0 (M0) and Phase 1/3 (M1) verification results — read to the end, not just the original text.
docs/CODING_STANDARDS.md — the how: full TypeScript/Node.js and PostgreSQL conventions. This file only summarizes the parts an agent is most likely to violate by default. As of M1 this includes two recorded exceptions (composite primary keys on partitioned tables; the Biome + narrow type-aware ESLint pass) — check there before assuming the general rule applies unmodified.
docs/DESIGN.md — the UI spec: visual identity, tokens, component rules. Binding for anything touching apps/web.
docs/decisions.md — ADR log. Check here before re-litigating something already decided during implementation (tooling choices, version pins, schema exceptions, etc.) — as of M1 this includes at least ADR-0008 and ADR-0010.

If a task touches something listed under "Open decisions" in the action plan (e.g. whether PopulationProfile duplicates existing tables, or the internal-vs-external auth question), stop and surface the decision instead of guessing.

Document precedence when two docs conflict

These docs were written at different times for different purposes, so a conflict between them is expected occasionally, not a sign something's broken. Resolve it in this order:

docs/decisions.md (ADRs) — the most recent, most specific, ground-truth record of what was actually implemented and why.
docs/DESIGN.md — wins over the architecture/tech-stack doc for anything about UI presentation, motion, or the frontend design-tooling recommendation. It's the more specific, later document for that surface. (Confirmed case: the architecture doc said skip Magic UI for the dashboard; DESIGN.md §8 names three specific motion moments where it's used. DESIGN.md wins — that's not a contradiction to "fix," it's the general recommendation being overridden by a more specific one for this product.)
docs/architecture-review-and-action-plan.md — the overall product/data-model/infra direction.
docs/CODING_STANDARDS.md — general code conventions; expect this one to accumulate documented exceptions as real tooling and schema decisions get made (e.g., a narrow type-aware lint rule sourced from a second tool alongside the primary linter/formatter, or a composite primary key on partitioned tables) rather than being rewritten each time.

When a conflict surfaces, add an ADR recording which side won and why — don't just silently pick one.

What this is

A pattern-aware, sampling-based SEO intelligence platform. It does not crawl every URL on a site. It collapses a sitemap's URLs into a much smaller set of patterns, samples each pattern statistically (with proper confidence intervals, not guesses), and verifies health with targeted HTTP checks — the entire point is auditing a 90M-URL site without making 90M requests. Any change that reintroduces "just crawl everything" thinking is working against the product's actual differentiator.

The core entity model (landed in M1) is organization → site → sitemap_run → sitemap_file → pattern → pattern_population / pattern_sample → sample_observation, plus audit_snapshot and sampling_health. site exists independently of any one audit run — this is the deliberate fix for the legacy tool's design, where the root entity was a one-off session with no memory of a site being audited again later. Trends, regressions, a fleet view across sites, and history to train a model on all depend on site being a durable entity, not an artifact of a single run. Don't reintroduce a run-rooted model even locally in new code.

Repo layout
apps/
  web/       Next.js frontend (dashboard)
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  database/   Schema shared by api + worker. Tenant-scoped queries are enforced at compile time via an
              opaque `Database` type with no ambient query methods and a single package entry point —
              see `compile-guards.test.ts` and ADR references in `docs/decisions.md`. Don't add a second
              way to obtain a raw client that bypasses this.
  sampling/   Bounded min-heap sampling, Wilson score intervals, finite-population correction
  sitemap/    Streaming SAX parser + pattern extraction
  shared/     Shared types, utils, constants (zod-validated startup config, logger, domain error hierarchy)
  ml-client/  Client for the ml-service prediction endpoint
ml-service/   Separate Python service (model training + /predict) — see rule below
infrastructure/  Terraform/CDK for AWS
docs/         Architecture plan, coding standards, design spec, ADR log
Commands
bash
docker compose up -d        # Postgres 16 + Redis (ports overridable via POSTGRES_PORT/REDIS_PORT —
                             # see .env if a native Postgres/Redis install on the host already holds
                             # the default port)
pnpm install
pnpm dev                    # runs web + api + worker together (from repo root)
pnpm --filter <app> dev     # run just one app, e.g. pnpm --filter worker dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test

Run pnpm dev from the repo root, not from inside an app folder — a package's own dev script only exists once that package has real source files.

Non-negotiable project rules

These come out of a specific architecture review and its critique (see the action plan doc for the full reasoning) — they are not arbitrary preferences, and deviating from them reintroduces problems that were already identified and fixed once.

No ORDER BY random() for sampling, ever, on tables that can grow large. Use the bounded min-heap-by-hash approach in packages/sampling.
Confidence math must use the Wilson score interval with finite-population correction, not a naive normal approximation. This lives in packages/sampling — don't recompute it ad hoc elsewhere. (Check docs/architecture-review-and-action-plan.md's Phase 0 amendment and docs/decisions.md for the corrected FPC details verified during M0 — the original doc's threshold language here was found to need correction.) The degenerate-interval defect (a [0,0] interval falsely implying certainty from a partial sample) is now a database-level CHECK constraint, not just an application check, with an n = N exemption for a fully-counted population — see M1 notes below.
HTTP verification is HEAD-first, GET only on suspicious results, and GET body fetches must be size-capped (soft-404 detection needs the first few KB, not the whole page). Cap how much of a pattern's sample is allowed to escalate to GET before flagging it for manual review instead of continuing. (Same note as above — the body-cap specifics were corrected during M0 verification; defer to docs/decisions.md.)
Never materialize a full URL population in memory or in a single query result. Everything works off streaming passes and pattern/file-level aggregates, not per-URL row sets at the 10M+ scale.
Multi-tenant isolation is a first-class concern, not an afterthought. Large per-URL/per-pattern tables are partitioned by site_id from schema creation (as of M1, six tables), not retrofitted later. Unscoped, cross-tenant queries against packages/database are a compile error, not a runtime risk, by construction (opaque Database type + single entry point) — see compile-guards.test.ts. BullMQ queues and Redis keys are namespaced per site/tier so one site's job volume can't starve another's — this piece (queue/Redis namespacing, connection-pool budgeting) is still pending as of M1, not yet built.
Query layer split: use Drizzle or Kysely (not Prisma) for anything in packages/sampling or packages/sitemap — this workload needs hash filtering, window functions, and CTEs close to raw SQL. Prisma is fine for simple CRUD (dashboard/admin, user/site management) if used there, but never for the sampling hot path. Drizzle Kit is the schema migration source of truth, but it cannot generate PARTITION BY DDL — partitioned-table migrations are hand-completed with three verification guards (banner comment, a relkind = 'p' test against a real database, a test asserting a PARTITIONED_TABLES constant matches what the database reports). Never run drizzle-kit push against this schema — see docs/CODING_STANDARDS.md §2.4.
ML work lives in ml-service/ (Python), never inlined into the Node platform. The Node/TypeScript core stays as-is; ml-service/ reads features from the same Postgres database and serves predictions over a small internal endpoint or writes them back on a schedule.
Don't reach for: NestJS, Lambda for the main workers, MongoDB, SQS in front of BullMQ, or EKS — all considered and rejected for this workload in the architecture doc. Revisit only if a concrete gap shows up in practice, not speculatively.
Don't add a new PopulationProfile-style entity (or similar) without first checking whether pattern_shape_rules, structureClusters, or shapeStrata already cover it — this is still an open decision. M1's pattern_population/pattern_sample schema addresses the population/sample storage question but has not been confirmed as resolving the shape/stratum distinction specifically — don't assume it's settled without checking the architecture doc's open-decisions section.
Coding standards (see docs/CODING_STANDARDS.md for full detail)

The essentials an agent must not violate by default:

TypeScript strict mode everywhere; no any — use unknown and narrow it.
Named exports only; no default exports.
ESM only ("type": "module") — no require() in new code.
All async code uses async/await; no unhandled/floating promises (enforced via a type-aware lint rule — see docs/decisions.md for which tool covers this).
Structured logging (pino) — no stray console.log in application code, only in one-off scripts.
Every table, column, and index name is snake_case; every foreign key is <singular_table>_id; every table has created_at/updated_at. Partitioned tables use a composite primary key (site_id, id), not plain id — Postgres requires the partition key in any unique index or PK on a partitioned table (see ADR-0010).
All SQL is parameterized — no string-concatenated queries, ever.
Every exported function that isn't trivial gets a short TSDoc comment explaining why, not a restatement of the signature.
Environment variables are validated once at startup via a schema (zod), fail-fast, reporting all missing/invalid vars together rather than one at a time — never read scattered process.env.X calls through business logic.
Statistical invariants that must never silently hold a wrong value (e.g. the degenerate-interval case above) get a database CHECK constraint, not just an application-level assertion — "unwritable" beats "alerted on."
Workflow expectations
Check which Phase (0–5) a task belongs to in the action plan before starting; Phase 1 (sampling/population engine) work shouldn't get blocked on Phase 5 (SEO audit UI) polish, and vice versa.
When a change touches a decision the action plan marks open, say so explicitly rather than picking an answer silently.
Update docs/architecture-review-and-action-plan.md when a real architectural decision gets made or changed — it's meant to stay current, not freeze as a one-time snapshot. Prefer amending with dated findings over silently rewriting original text, so there's a record of what changed and why (this is what M0 and M1 both did).
Record tooling/version/schema decisions as ADRs in docs/decisions.md rather than only in a commit message or PR description — commit history isn't a substitute for a decision log someone can skim later.
Never commit .env, credentials, or AWS/SFTP keys. .env.example documents what's needed; real values stay local or in Secrets Manager.
New logic in packages/sampling (confidence intervals, sampling algorithms, statistical decisions) needs tests — this is the part of the system a wrong-but-plausible-looking answer would be most costly, and it's also the part hardest to eyeball-review. The same standard applies to anything asserting tenant isolation (e.g. compile-guards.test.ts) — these are correctness-critical, not incidental.
Before merging a schema migration, confirm it doesn't fight a native/local install shadowing a Docker service on the same default port (this bit M1 with Postgres on Windows) — use the POSTGRES_PORT/REDIS_PORT overrides rather than assuming the default port is actually reaching the container.
Git conventions
Conventional Commits: feat:, fix:, chore:, docs:, refactor:, test:, perf:.
Branch names: feat/<short-description>, fix/<short-description>, or phase-<n>/<short-description> (or phase-<n>/m<milestone>-<short-description>) for work tied directly to an action-plan phase.
Don't push directly to main once more than one person is working in this repo — open a PR, even a small one.
Keep an unrelated large-diff change (a lockfile-rewriting package-manager upgrade, a dependency major-version bump) in its own commit/PR, separate from feature work — makes both easier to review and to revert independently.
Open PRs (don't just push branches) and confirm CI actually runs green in GitHub's environment, not just locally — a passing local run doesn't confirm the CI service containers (e.g. the Postgres service container M1 added) are configured correctly in the real environment.
Milestone log
M0 (Phase 0 foundation) — complete. Tooling/enforcement (linting, type-aware promise rules, pre-commit hook, CI), real workspace packages, packages/shared (config, logging, error hierarchy), initial apps/web scaffold conforming to docs/DESIGN.md, docs/decisions.md established. See ADRs for tooling specifics and the architecture doc's Phase 0 amendment for the corrected FPC/body-cap details.
M1 (Phase 1 schema/tenancy foundation) — complete. Branched phase-1/m1-schema-tenancy off develop (includes M0); all four CI gates pass; 26 integration tests against a real Postgres 16. Delivered: the organization → site → sitemap_run → sitemap_file → pattern → pattern_population / pattern_sample → sample_observation model plus audit_snapshot and sampling_health, with site as a durable root entity (the deliberate fix over legacy's run-rooted session model); the degenerate-interval defect closed as a CHECK constraint with an n = N exemption; compile-time tenant isolation via an opaque Database type + single entry point + compile-guards.test.ts; the composite (site_id, id) primary key exception for six partitioned tables, recorded as ADR-0010. Two documented hazards: Drizzle Kit can't express PARTITION BY (hand-completed migration, three guards, never run drizzle-kit push); a native postgres.exe on port 5432 was shadowing the Docker container locally (fixed via overridable POSTGRES_PORT/REDIS_PORT, 5433 set locally). Still open going into M2: three branches (develop, M0, M1) unmerged with no PRs opened yet, and CI has never been observed running in GitHub's actual environment (local gh unauthenticated) — worth closing out before compounding further milestones on an unverified pipeline, especially since M1 added a new Postgres service container to CI. Also open: whether pattern_population/pattern_sample resolves the shape/stratum (structureClusters/shapeStrata/pattern_shape_rules) question from the original architecture review, or just the population/sample storage question — not yet confirmed either way. Next: M2, single-pass streaming sitemap ingestion (ported SAX parser, synthetic 10M-URL benchmark).