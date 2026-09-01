# Pattern-Aware SEO Platform

A pattern-aware, sampling-based SEO intelligence platform. Instead of crawling every URL on a site, it collapses tens or hundreds of millions of sitemap URLs into a much smaller set of patterns, samples each pattern statistically, and verifies health with targeted HTTP checks — so auditing a 90M-URL site doesn't require requesting 90M URLs.

See [`docs/architecture-review-and-action-plan.md`](docs/architecture-review-and-action-plan.md) for the full architecture review, phased action plan, and tech stack rationale this repo is built from.

## Stack

- **Frontend:** Next.js (App Router) + TypeScript, shadcn/ui + Tailwind CSS, Recharts/Tremor
- **API:** Fastify + TypeScript
- **Workers:** BullMQ + Redis, Piscina for CPU-bound work
- **Database:** PostgreSQL
- **Query layer:** Drizzle/Kysely for sampling & analytics queries, Prisma optional for simple CRUD
- **ML service:** separate Python service (FastAPI + scikit-learn/XGBoost) for pattern risk prediction, added once enough historical sampling data exists
- **Monorepo tooling:** pnpm workspaces + Turborepo

## Prerequisites

- Node.js 22 LTS
- pnpm (`corepack enable` will pick up the version pinned in `package.json`)
- Docker Desktop (for Postgres + Redis locally)
- Python 3.11+ (only needed once `ml-service/` is active)

## Getting started

1. Copy the environment template and fill in local values:

   ```bash
   cp .env.example .env
   ```

2. Start Postgres and Redis:

   ```bash
   docker compose up -d
   ```

3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Run everything in dev mode:

   ```bash
   pnpm dev
   ```

   This runs the `web`, `api`, and `worker` apps in parallel via Turborepo. To run just one, use `pnpm --filter web dev` (or `api` / `worker`).

## Project structure

```
apps/
  web/       Next.js frontend
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  database/   Schema (Drizzle/Prisma) shared by api + worker
  sampling/   Bounded min-heap sampling, Wilson score intervals, finite-population correction
  sitemap/    Streaming SAX parser + pattern extraction
  shared/     Shared types, utils, constants
  ml-client/  Client for the ml-service prediction endpoint
ml-service/   Separate Python service: model training + /predict endpoint
infrastructure/  Terraform/CDK for AWS
docs/         Architecture and planning docs
```

## Status

Early setup — see the action plan in `docs/architecture-review-and-action-plan.md` for what's built vs. planned.
