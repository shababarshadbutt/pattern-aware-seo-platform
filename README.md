# Pattern-Aware SEO Platform

A pattern-aware, sampling-based SEO intelligence platform. Instead of crawling every URL on a site, it collapses tens or hundreds of millions of sitemap URLs into a much smaller set of patterns, samples each pattern statistically, and verifies health with targeted HTTP checks — so auditing a 90M-URL site doesn't require requesting 90M URLs.

Read these before making non-trivial changes:

- [`docs/architecture-review-and-action-plan.md`](docs/architecture-review-and-action-plan.md) — product direction, phasing, and the Phase 0 verification results (which correct several claims in the original review).
- [`docs/decisions.md`](docs/decisions.md) — architecture decision records. Start here to understand *why* something is the way it is.
- [`docs/CODING_STANDARDS.md`](docs/CODING_STANDARDS.md) — TypeScript and PostgreSQL conventions.
- [`DESIGN.md`](DESIGN.md) — **the design system, and the source of truth for every UI decision.** Read it before building or modifying any screen. It is specific and opinionated: a dark-first instrument-panel language, one amber accent, monospace tabular numbers, tables rather than cards, and a named list of anti-patterns that are bans rather than suggestions.
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

- **Every database read goes through a repository function that takes a `SiteScope` token.** An unscoped query is a compile error, not something a reviewer has to catch ([ADR-0004](docs/decisions.md)).
- **A sampled number may never be rendered without its confidence interval.** One `<Estimate>` component enforces this in the type system, and a CI test asserts nothing bypasses it ([ADR-0008](docs/decisions.md)).
- **UI values come from the token layer, never from a literal.** [`apps/web/app/globals.css`](apps/web/app/globals.css) resets Tailwind's default colour, radius, and font-size namespaces and defines only what [`DESIGN.md`](DESIGN.md) specifies — so `rounded-2xl` and `bg-indigo-500` do not exist to be typed by accident. The bans in DESIGN.md section 9 are structural, not a review checklist.

## Project structure

```
apps/
  web/       Next.js frontend
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  shared/     Validated config, pino logging, domain error hierarchy
  database/   Drizzle schema + SiteScope-gated repositories   (M1)
  sitemap/    Streaming SAX parser + single-pass extraction   (M2)
  sampling/   Min-heap-by-hash, Wilson intervals with FPC     (M3)
  ml-client/  Client for the ml-service /predict endpoint     (Phase 4)
ml-service/      Separate Python service: training + /predict
infrastructure/  Terraform/CDK for AWS
docs/            Architecture, decisions, coding standards
```

Packages marked with a milestone are deliberately empty until then — see the action plan. `packages/sampling` and `packages/sitemap` additionally compile with `noUncheckedIndexedAccess`, because an off-by-one there corrupts a statistical result instead of crashing.

## Toolchain

`packageManager` pins **pnpm 8.15.0**, matching the pnpm currently installed and the `lockfileVersion: '6.0'` lockfile. Upgrading to pnpm 9+ is worth doing deliberately, as its own change: it needs `corepack enable` in an elevated shell (or a global install) and it rewrites the lockfile to v9 format, so it should land in a commit of its own rather than mixed into feature work.

## Status

**M0 complete** — the workspace builds, lints, typechecks, tests, and runs end to end. Next is M1: schema, tenancy, and partitioning. See the action plan for what's built versus planned.
