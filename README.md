# Pattern-Aware SEO Platform

A pattern-aware, sampling-based SEO intelligence platform. Instead of crawling every URL on a site, it collapses tens or hundreds of millions of sitemap URLs into a much smaller set of patterns, samples each pattern statistically, and verifies health with targeted HTTP checks — so auditing a 90M-URL site doesn't require requesting 90M URLs.

Read these before making non-trivial changes:

- [`docs/architecture-review-and-action-plan.md`](docs/architecture-review-and-action-plan.md) — product direction, phasing, and the Phase 0 verification results (which correct several claims in the original review).
- [`docs/decisions.md`](docs/decisions.md) — architecture decision records. Start here to understand *why* something is the way it is.
- [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) — TypeScript and PostgreSQL conventions.
- [`DESIGN.md`](docs/DESIGN.md) — **the design system, and the source of truth for every UI decision.** Read it before building or modifying any screen. It is specific and opinionated: a dark-first instrument-panel language, one amber accent, monospace tabular numbers, tables rather than cards, and a named list of anti-patterns that are bans rather than suggestions.
- [`CLAUDE.md`](CLAUDE.md) — the non-negotiable project rules, for humans and coding agents alike.

## Stack

- **Frontend:** Next.js 16 (App Router) + React 19 + Tailwind CSS 4, shadcn/ui, Recharts/Tremor
- **API:** Fastify 5 + TypeScript
- **Workers:** BullMQ + Redis, Piscina for CPU-bound work
- **Database:** PostgreSQL 16, partitioned by `site_id` from creation
- **Query layer:** Drizzle only, with Drizzle Kit as the single source of truth for migrations ([ADR-0005](docs/decisions.md))
- **Tooling:** Biome for lint and format, plus a two-rule type-aware ESLint pass ([ADR-0006](docs/decisions.md)); Vitest for tests
- **ML service:** a separate Python service (FastAPI + scikit-learn/XGBoost), added once enough sampling history exists to train on
- **Monorepo:** pnpm workspaces + Turborepo

## Prerequisites

- Node.js 22 LTS or newer (`.nvmrc` pins 22)
- pnpm — see the note under [Toolchain](#toolchain) below
- Docker Desktop, for Postgres and Redis
- Python 3.11+, only once `ml-service/` is active

## Getting started

```bash
cp .env.example .env      # only DATABASE_URL and REDIS_URL have no default
docker compose up -d      # Postgres 16 + Redis 7
pnpm install
pnpm dev                  # web + api + worker together
```

`pnpm dev` runs all three apps via Turborepo. For one at a time: `pnpm --filter web dev` (or `api` / `worker`).

Configuration is validated once at startup against a zod schema in [`packages/shared/src/config.ts`](packages/shared/src/config.ts). A missing or malformed variable fails the process immediately, naming every offending variable at once — it will not surface three jobs into a worker run. Every operational limit (parse concurrency, sampling bounds, HTTP request budgets, circuit-breaker thresholds) lives in that schema too, so what a deployment will do to a client's origin server is answerable by reading one file.

## Verifying a change

```bash
pnpm lint        # Biome, then the narrow type-aware ESLint pass
pnpm typecheck   # tsc --noEmit across every workspace
pnpm test        # Vitest
pnpm build       # tsc for packages and apps, next build for web
```

All four run in CI on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). A pre-commit hook runs Biome over staged files so formatting never reaches a PR.

Two conventions worth knowing before you add a query or a number to a screen:

- **Every database read goes through a repository function that takes a `SiteScope` token.** The `Database` handle is opaque — its public type has no query methods — so an unscoped query is a compile error, not something a reviewer has to catch ([ADR-0004](docs/decisions.md)).
- **An invariant that can be a database constraint is one.** The estimator cannot write a zero-width interval for a partial sample, a partial sample cannot be labelled `counted`, and a site cannot have two runs in flight ([ADR-0011](docs/decisions.md)).
- **A sampled number may never be rendered without its confidence interval.** One `<Estimate>` component enforces this in the type system, and a CI test asserts nothing bypasses it ([ADR-0008](docs/decisions.md)).
- **UI values come from the token layer, never from a literal.** [`apps/web/app/globals.css`](apps/web/app/globals.css) resets Tailwind's default colour, radius, and font-size namespaces and defines only what [`DESIGN.md`](docs/DESIGN.md) specifies — so `rounded-2xl` and `bg-indigo-500` do not exist to be typed by accident. The bans in DESIGN.md section 9 are structural, not a review checklist.

## Project structure

```
apps/
  web/       Next.js frontend
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  shared/     Validated config, pino logging, domain error hierarchy
  database/   Drizzle schema, partitioning, SiteScope-gated repositories
  sitemap/    Streaming SAX parser + single-pass extraction
  sampling/   Min-heap-by-hash, Wilson intervals with FPC
  ml-client/  Client for the ml-service /predict endpoint     (Phase 4)
ml-service/      Separate Python service: training + /predict
infrastructure/  Terraform/CDK for AWS
docs/            Architecture, decisions, coding standards
```

Packages marked with a milestone are deliberately empty until then — see the action plan. `packages/sampling` and `packages/sitemap` additionally compile with `noUncheckedIndexedAccess`, because an off-by-one there corrupts a statistical result instead of crashing.

## Toolchain

`packageManager` pins **pnpm 8.15.0**, matching the pnpm currently installed and the `lockfileVersion: '6.0'` lockfile. Upgrading to pnpm 9+ is worth doing deliberately, as its own change: it needs `corepack enable` in an elevated shell (or a global install) and it rewrites the lockfile to v9 format, so it should land in a commit of its own rather than mixed into feature work.

## Database

The schema is `organization -> site -> sitemap_run -> sitemap_file -> pattern -> pattern_population / pattern_sample -> sample_observation`, plus `audit_snapshot` and `sampling_health`. Six of those tables are `PARTITION BY LIST (site_id)` from creation, and onboarding a site creates its partitions in the same transaction as the row ([ADR-0003](docs/decisions.md)).

```bash
pnpm --filter @pattern-aware/database db:generate   # after editing src/schema
pnpm --filter @pattern-aware/database db:migrate    # apply pending migrations
```

Two things to know before touching migrations. **Never run `drizzle-kit push`** — it would recreate the partitioned tables as ordinary ones and silently discard the partitioning. And `drizzle/0000_init_schema.sql` is hand-completed after generation, because Drizzle cannot express `PARTITION BY`; regenerating over it produces a schema that applies cleanly, typechecks, and is unpartitioned. Tests guard both ([ADR-0010](docs/decisions.md)).

Integration tests create and drop their own throwaway databases against a real Postgres — partitioning, composite foreign keys, partial unique indexes and CHECK constraints are the substance of this package, and a mocked query layer reproduces none of them. `docker compose up -d` is enough; CI runs a Postgres service container.

If a natively-installed Postgres already holds port 5432, set `POSTGRES_PORT` in `.env` (and match it in `DATABASE_URL`). The container is otherwise shadowed and connections fail on credentials against the wrong server.

## Sitemap ingestion

One streaming pass over a site produces all three things the sampler needs — per-pattern population counts, the pattern-to-file index, and the sample candidates. The legacy engine needs a separate full scan for each, and reads every `<loc>` of every file to build the second one because no pattern-to-file index exists.

Memory is bounded by pattern count, not URL count: nothing holds a URL string past the moment it is hashed, and candidates are stored as 12-byte `(hash, file, ordinal)` triples ([ADR-0002](docs/decisions.md)). Measured on a synthetic 10M-URL corpus: **681 MB peak RSS against a 1,536 MB budget, 89 MB retained, 19 patterns, ~41,600 URLs/s.**

Patterns are grouped with a prefix trie rather than the legacy per-position counters, which merged a third of that corpus into a single meaningless `/{param}/{param}/{param}` ([ADR-0012](docs/decisions.md) has the before-and-after).

```bash
pnpm gen:sitemaps --out .tmp/sitemaps --urls 10000000   # seeded, deterministic
SITEMAP_BENCH_URLS=10000000 pnpm --filter @pattern-aware/sitemap test
```

The corpus is deliberately adversarial — it is what found three bugs that unit tests on small inputs did not. Keep it that way.

## Sampling and confidence

`packages/sampling` is pure and synchronous by design — every decision it makes is checkable against a hand-computed value with no database, network or sitemap involved. It is the part of the system where a wrong-but-plausible answer is most expensive and least likely to be caught by review.

The legacy estimator uses a normal approximation, and with zero observed hits its variance is zero, so the interval collapses to `[0, 0]`: certainty that a 40,000-URL pattern has no errors, on thirty probes. Wilson does not degenerate there — thirty probes finding nothing yields a ceiling of about 4,539 URLs, and four hundred narrows it under 1% ([ADR-0001](docs/decisions.md)).

Intervals come with a plain-language band, and the band's thresholds are the same ones the expansion trigger uses, so the engine can never call a pattern settled while the interface calls it uncertain. Expansion is driven by whether the interval is too wide to act on, not by a hardcoded hit rate.

`ESTIMATOR_VERSION` is written to every `audit_snapshot`. Bump it whenever a change alters the numbers this package produces for inputs it already handled, or old and new rows become incomparable while looking identical.

## Status

**M0 through M3 complete** — the workspace builds and runs end to end, the schema and tenant boundary are in place, and sitemap ingestion parses ten million URLs in one bounded-memory pass, and the statistical core computes defensible intervals. Next is M4: HTTP verification. See the action plan for what's built versus planned.
