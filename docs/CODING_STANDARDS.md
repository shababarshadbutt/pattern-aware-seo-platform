Coding Standards — Pattern-Aware SEO Platform

This document exists so code in this repo looks like it came from one team with one set of habits, whether it was written by a person or an AI coding agent, on Monday or six months from now. It draws on established, publicly documented style guides rather than inventing rules from scratch — see References at the end for the source material. Where this document and a referenced guide disagree, this document wins for this repo; the references are there for the reasoning, not to be followed blindly over project-specific needs (this project's sampling/statistics code, for instance, has correctness requirements no general style guide addresses).

Enforcement: these rules are meant to be checked by tooling (ESLint, Prettier or Biome, tsc --strict, a SQL linter) wherever a rule can be mechanically checked, not left to memory or code review alone. Section 4 lists the specific tooling.

1. TypeScript & Node.js
1.1 Compiler settings

strict: true in every tsconfig.json, no exceptions. That means noImplicitAny, strictNullChecks, strictFunctionTypes, and the rest of the strict family are all on. Target ES2022, module NodeNext (matches Node 22's native ESM support). skipLibCheck: true is fine for build speed; noUncheckedIndexedAccess: true is recommended for packages/sampling and packages/sitemap specifically, since off-by-one and undefined-access bugs in those packages are exactly the kind of thing that silently corrupts a sampling result rather than crashing loudly.

1.2 Naming
Element	Convention	Example
Variables, functions, methods	camelCase	computeConfidenceInterval
Classes, interfaces, types, enums	PascalCase	PatternSample, SamplingStrategy
Type parameters	single uppercase letter or short PascalCase	T, TResult
Constants (true, compile-time constants)	UPPER_SNAKE_CASE	MAX_SAMPLE_SIZE
File names	kebab-case.ts	confidence-interval.ts, pattern-population-pool.ts
Enum members	PascalCase	SampleMethod.MinHeapByHash
Boolean variables/props	prefixed is/has/should	isConverged, hasEscalated

Consistent file naming matters more than which convention is picked — kebab-case.ts is the choice here because it's case-insensitive-filesystem-safe (avoids Mac/Windows vs. Linux mismatches that PascalCase filenames can cause) and matches most of the modern Node ecosystem.

1.3 Exports and modules

Named exports only — no export default. Default exports make renames and re-exports harder to track mechanically and are explicitly discouraged by the Google TypeScript Style Guide for the same reason. ESM only ("type": "module" in every package.json); no require() in new code. Use import type { X } from "..." for type-only imports so they're erased cleanly at build time. Import order: Node built-ins, then external packages, then internal workspace packages, then relative imports — each group separated by a blank line and (where tooling allows) alphabetized within the group.

1.4 Types

Prefer interface for object shapes that describe data (especially anything mirroring a database row or an API payload) and type for unions, intersections, and utility-type compositions. Never use any; if the type genuinely isn't known yet, use unknown and narrow it before use. Avoid the non-null assertion operator (!) except with an inline comment explaining why the value is guaranteed non-null — an unguarded ! on sampling data is exactly the kind of thing that turns a missing sample into a runtime crash three layers away from the actual bug.

A package's public surface can enforce structural rules the type checker doesn't give you for free — e.g. exposing an opaque type with no query methods, and a single entry point, so a whole class of bug (an unscoped/cross-tenant query) becomes a compile error outside that package rather than a runtime risk to catch in review. packages/database does this for tenant-scoped queries (see ADR references in docs/decisions.md). Prefer this "make the wrong thing impossible to write" approach over a lint rule or a code-review checklist item whenever the type system can actually express the constraint.

1.5 Async code and error handling

Always async/await — no raw .then() chains, no callback-style APIs in new code. No floating promises: every promise is either awaited, returned, or explicitly voided with a comment explaining why it's fire-and-forget. Biome cannot express the type-aware promise rules (no-floating-promises, no-misused-promises) — run a narrow, type-aware ESLint pass for exactly those two rules alongside Biome for everything else (see §11 and ADR entries in docs/decisions.md); this is not "running two linters," it's Biome plus the one category of check it structurally can't do. Throw Error subclasses, never strings or plain objects — define a small hierarchy of domain errors (e.g. SamplingError, PopulationScanError) rather than throwing generic Error everywhere, so callers can distinguish expected failure modes from bugs; an explicit flag distinguishing an expected failure (a host refused a request) from a defect (the code is broken) is worth adding to the base error type, not just a message string. Never swallow an error silently (an empty catch {} block is a defect, not a shortcut) — at minimum log it with enough context to reproduce.

1.6 Logging

Structured logging via pino (Fastify's default, and reused as-is in the worker) — no console.log in application code paths; it's fine in one-off scripts under scripts/ but not in apps/*/src or packages/*/src. Log at the right level (debug for step-by-step tracing, info for state transitions like "sample expanded," warn for recoverable anomalies, error for failures) and always include structured context (pattern ID, site ID, job ID) rather than interpolating those values into a message string, so logs stay queryable.

1.7 Configuration

Validate all environment variables once, at startup, against a schema (zod is already a natural fit given it's used for API input validation too) — fail fast with a clear message if config is invalid, and report every missing/invalid variable together in one error rather than failing on the first one found (nobody should have to fix-and-rerun five times to discover five missing env vars one at a time). Don't read process.env.X scattered through business logic; read it once into a typed config object and pass that around or import it from one module.

1.8 Immutability and mutation

Default to const. Mark object properties readonly where a type describes something that shouldn't change after construction (most database row types and API response types qualify). Don't mutate function parameters — return a new value instead. This matters more than usual in the sampling code, where accidental shared mutable state between concurrent Piscina workers is a real, hard-to-reproduce bug class.

1.9 Documentation

TSDoc comments on every exported function, class, and type that isn't trivially self-explanatory. Write about why, not what the code already says — // re-hash on expansion so round two is a superset of round one, not a fresh random sample is useful; // hashes the url is not.

1.10 Testing

Vitest for unit and integration tests, files named *.test.ts colocated with the code they test. Anything in packages/sampling (confidence intervals, finite-population correction, min-heap sampling, adaptive expansion) needs tests with known statistical answers checked against — this is the part of the system most likely to look correct while being subtly wrong, and least likely to be caught by manual review. HTTP-checking code should be tested against mocked responses covering the HEAD/GET escalation paths and soft-404 detection, not live requests. Database-touching code should run against a real (throwaway/test) Postgres instance rather than a mocked query layer, since the whole point of the sampling engine is SQL behavior at scale that a mock can't represent — packages/database's integration suite (real Postgres 16) is the model to follow for any package with DB-touching logic.

A structural invariant that's cheap to check and expensive to get wrong belongs in a database constraint, not just a test or an alert — e.g. a CHECK constraint making a degenerate confidence interval (claiming a zero-width interval from a partial sample) literally impossible to write to the table, rather than a monitoring alert that fires after the bad row already exists. Prefer "unwritable" over "alerted on" wherever the invariant can be expressed declaratively.

1.11 Formatting and linting

Biome as the primary linter/formatter, plus a narrow, type-aware ESLint pass limited to @typescript-eslint/no-floating-promises and @typescript-eslint/no-misused-promises (see §1.5 — Biome cannot express these since they require type information). This is the one documented exception to "pick a single tool" — don't add further ESLint rules to that pass without a similar type-information justification, or the exception quietly becomes "running both linters" again. Wire it up as a pre-commit hook (husky + lint-staged) so formatting/lint issues never reach a PR in the first place, rather than relying on CI to catch them after the fact.

2. PostgreSQL / SQL
2.1 Identifiers

Always snake_case, always lowercase, no exceptions — Postgres folds unquoted identifiers to lowercase anyway, so mixed-case names silently stop working the moment a query forgets to quote them. This means the query layer (Drizzle/Kysely) needs an explicit camelCase-JS ↔ snake_case-SQL mapping at the boundary; don't fight this by trying to keep JS-style names in the database.

Table names: singular nouns (pattern, sample, site, not patterns/samples/sites). This is a real, debated choice (Rails-style pluralization is common too) — singular is picked here because it avoids irregular-plural edge cases entirely and reads naturally in a join (pattern.id = sample.pattern_id, not patterns.id = samples.pattern_id). Foreign keys are always <singular_referenced_table>_id (site_id, pattern_id). Every table gets created_at and updated_at (timestamptz, not timestamp, to avoid timezone ambiguity); soft-deletable tables get a nullable deleted_at. Boolean columns are prefixed is_/has_ (is_verified, has_redirect).

Primary keys: id alone for a non-partitioned table. Exception for partitioned tables: PostgreSQL requires every unique index (including the primary key) on a partitioned table to include the partition key column, so a table partitioned by site_id has primary key (site_id, id), not plain id — this is a database constraint, not a style preference, and it has the side benefit that every child row already carries site_id for partition pruning. This exception is recorded as an ADR (see docs/decisions.md) the first time it applied — don't rediscover it per table; any new partitioned table gets the same (site_id, id) treatment.

2.2 Indexes and constraints

Name indexes idx_<table>_<column(s)> (idx_sample_pattern_id), unique constraints uq_<table>_<column(s)>, and foreign key constraints fk_<table>_<referenced_table> — explicit names, never left to the database's auto-generated ones, because auto-generated names make migrations and error messages much harder to read once the schema has hundreds of objects across partitioned tables.

Use CHECK constraints for statistical/data invariants that can be expressed declaratively (see §1.10) — e.g. a sample that didn't cover its full population cannot report a zero-width confidence interval, with an explicit exception for the case where the full population genuinely was counted rather than estimated. This class of constraint is worth the effort to write correctly: it turns what used to be the highest-value alert in the legacy system into something that can't be written to the table in the first place.

2.3 Query style

No SELECT * in application code — list columns explicitly, so a later ALTER TABLE ADD COLUMN doesn't silently change the shape of every query result. No ORDER BY random() on any table that can grow large — this was a specific, already-identified problem in the sampling engine (see the architecture doc) and the fix (bounded min-heap by hash) applies to any future code that needs a random-ish sample, not just the original instance. Every query is parameterized — string concatenation into SQL is never acceptable, even for internal tooling.

Run EXPLAIN ANALYZE on any query touching a table expected to exceed roughly 1M rows before merging it — this project's entire premise is operating at a scale where a missing index or an accidental sequential scan is the difference between milliseconds and minutes.

2.4 Migrations

One logical schema change per migration file. Never edit a migration that has already been merged/shipped — write a new one that alters or corrects it, the same way you'd never rewrite git history that others have already pulled. Prefer migrations that are reversible (a working down) where practical. Pick one migration tool as the source of truth for the schema (Drizzle Kit, matching the query-layer choice for the sampling/sitemap packages) rather than letting two ORMs each maintain their own migration history against the same database — that's a guaranteed way to end up with drift no one notices until it breaks.

Known limitation: Drizzle Kit cannot generate PARTITION BY DDL, so a migration that creates a partitioned table is hand-completed after generation, not purely auto-generated — deleting and regenerating such a migration file produces SQL that still applies cleanly and typechecks, but silently drops the partitioning. Any migration file with hand-completed partition DDL needs: a comment banner saying so, a test asserting the affected tables report relkind = 'p' with the expected partition strategy against a real database, and a test asserting whatever constant lists the partitioned tables in code matches what the database actually reports. Never run an auto-push/sync command (e.g. drizzle-kit push) against a partitioned schema — same silent-unpartitioning failure mode. Revisit this whole workaround if Drizzle ever adds native PARTITION BY support.

2.5 Partitioning and scale

Large per-URL and per-pattern tables are partitioned by site_id from the moment they're created, not retrofitted after data exists — this is both a multi-tenancy isolation measure and a query-performance one (see the architecture doc's Phase 3). Keep transactions short: never make an HTTP call, wait on a queue, or do other slow I/O inside an open database transaction — hold the transaction only for the statements that need atomicity.

3. Repository hygiene

Conventional Commits for every commit message: feat:, fix:, chore:, docs:, refactor:, test:, perf:, optionally scoped (feat(sampling): add finite-population correction). Branch names: feat/<short-description>, fix/<short-description>, or phase-<n>/<short-description> (or phase-<n>/m<milestone>-<short-description> for a numbered milestone within a phase) for work tied directly to a phase in the action plan. PRs should note which phase or open decision (from docs/architecture-review-and-action-plan.md) they relate to, where applicable, and include tests for new logic rather than relying on a follow-up "add tests" PR that tends not to happen. Keep an unrelated large-diff change (a lockfile-rewriting package-manager upgrade, a dependency major-version bump) in its own commit/PR, separate from feature work.

Record a real engineering decision — a tooling choice, a standards exception, a resolved conflict between two docs — as an ADR in docs/decisions.md, not only in a commit message or PR description. Commit history is not a substitute for a decision log someone can skim later without archaeology.

4. Tooling summary
Linting/formatting: Biome (primary) + a narrow type-aware ESLint pass for no-floating-promises/no-misused-promises only (§1.11) — wired into a pre-commit hook via husky + lint-staged.
Type checking: tsc --noEmit in CI, strict: true everywhere.
Testing: Vitest.
Schema/config validation: zod, used both for environment config and for API request/response validation.
SQL migrations: Drizzle Kit as the single source of truth for schema migrations, with the hand-completed-partition-DDL caveat in §2.4.
References
Google TypeScript Style Guide — naming, exports, type usage, the reasoning against default exports.
Microsoft TypeScript Wiki — Coding guidelines — the TypeScript compiler team's own internal conventions; a second, independent perspective that agrees with Google's on most fundamentals.
Airbnb JavaScript Style Guide — widely adopted baseline for general JS/TS style; useful where this document doesn't cover something explicitly.
PostgreSQL Wiki — Don't Do This — a maintained list of common Postgres anti-patterns, several of which (naming, SELECT *, timestamp types) this document builds on directly.
SQL Style Guide (Simon Holywell) — general SQL formatting and naming conventions referenced for section 2.

This document should be revised the same way the architecture plan is — when a real decision changes (e.g. a new standards exception like §2.1's partitioned-table primary keys, or the team settles on plural table names instead of singular), update this file rather than letting practice silently drift away from what's written here. As of M1, two such exceptions are recorded here (§1.11 lint tooling, §2.1 partitioned-table primary keys) — see docs/decisions.md for the full ADRs.