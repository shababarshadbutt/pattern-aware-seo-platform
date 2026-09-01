# Pattern-Aware SEO Platform — Agent Guide

This file is read automatically by Claude Code (and should be treated as load-bearing by any other coding agent working in this repo). It tells you what this project is, what's already been decided, and what rules to follow so the codebase stays consistent instead of accumulating whatever style each session or contributor happens to reach for.

## Read before making non-trivial changes

- `docs/architecture-review-and-action-plan.md` — the why: the product direction, the phased build order (Phase 0 through 5), and a list of open decisions that haven't been made yet. Don't build ahead of the current phase without checking this.
- `docs/CODING_STANDARDS.md` — the how: full TypeScript/Node.js and PostgreSQL conventions. This file only summarizes the parts an agent is most likely to violate by default.

If a task touches something listed under "Open decisions" in the action plan (e.g. whether `PopulationProfile` duplicates existing tables, or the internal-vs-external auth question), stop and surface the decision instead of guessing.

## What this is

A pattern-aware, sampling-based SEO intelligence platform. It does not crawl every URL on a site. It collapses a sitemap's URLs into a much smaller set of patterns, samples each pattern statistically (with proper confidence intervals, not guesses), and verifies health with targeted HTTP checks — the entire point is auditing a 90M-URL site without making 90M requests. Any change that reintroduces "just crawl everything" thinking is working against the product's actual differentiator.

## Repo layout

```
apps/
  web/       Next.js frontend (dashboard)
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  database/   Schema shared by api + worker
  sampling/   Bounded min-heap sampling, Wilson score intervals, finite-population correction
  sitemap/    Streaming SAX parser + pattern extraction
  shared/     Shared types, utils, constants
  ml-client/  Client for the ml-service prediction endpoint
ml-service/   Separate Python service (model training + /predict) — see rule below
infrastructure/  Terraform/CDK for AWS
docs/         Architecture plan + coding standards
```

## Commands

```bash
docker compose up -d        # Postgres 16 + Redis
pnpm install
pnpm dev                    # runs web + api + worker together (from repo root)
pnpm --filter <app> dev     # run just one app, e.g. pnpm --filter worker dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Run `pnpm dev` from the repo root, not from inside an app folder — a package's own `dev` script only exists once that package has real source files.

## Non-negotiable project rules

These come out of a specific architecture review and its critique (see the action plan doc for the full reasoning) — they are not arbitrary preferences, and deviating from them reintroduces problems that were already identified and fixed once.

- **No `ORDER BY random()` for sampling**, ever, on tables that can grow large. Use the bounded min-heap-by-hash approach in `packages/sampling`.
- **Confidence math must use the Wilson score interval with finite-population correction**, not a naive normal approximation. This lives in `packages/sampling` — don't recompute it ad hoc elsewhere.
- **HTTP verification is HEAD-first, GET only on suspicious results**, and GET body fetches must be size-capped (soft-404 detection needs the first few KB, not the whole page). Cap how much of a pattern's sample is allowed to escalate to GET before flagging it for manual review instead of continuing.
- **Never materialize a full URL population in memory or in a single query result.** Everything works off streaming passes and pattern/file-level aggregates, not per-URL row sets at the 10M+ scale.
- **Multi-tenant isolation is a first-class concern, not an afterthought.** Large per-URL/per-pattern tables are partitioned by `site_id` from schema creation, not retrofitted later. BullMQ queues and Redis keys are namespaced per site/tier so one site's job volume can't starve another's.
- **Query layer split:** use Drizzle or Kysely (not Prisma) for anything in `packages/sampling` or `packages/sitemap` — this workload needs hash filtering, window functions, and CTEs close to raw SQL. Prisma is fine for simple CRUD (dashboard/admin, user/site management) if used there, but never for the sampling hot path.
- **ML work lives in `ml-service/` (Python), never inlined into the Node platform.** The Node/TypeScript core stays as-is; `ml-service/` reads features from the same Postgres database and serves predictions over a small internal endpoint or writes them back on a schedule.
- **Don't reach for:** NestJS, Lambda for the main workers, MongoDB, SQS in front of BullMQ, or EKS — all considered and rejected for this workload in the architecture doc. Revisit only if a concrete gap shows up in practice, not speculatively.
- **Don't add a new `PopulationProfile`-style entity (or similar) without first checking** whether `pattern_shape_rules`, `structureClusters`, or `shapeStrata` already cover it — this is an open decision, not a settled one.

## Coding standards (see `docs/CODING_STANDARDS.md` for full detail)

The essentials an agent must not violate by default:

- TypeScript strict mode everywhere; no `any` — use `unknown` and narrow it.
- Named exports only; no default exports.
- ESM only (`"type": "module"`) — no `require()` in new code.
- All async code uses `async`/`await`; no unhandled/floating promises.
- Structured logging (pino) — no stray `console.log` in application code, only in one-off scripts.
- Every table, column, and index name is `snake_case`; every foreign key is `<singular_table>_id`; every table has `created_at`/`updated_at`.
- All SQL is parameterized — no string-concatenated queries, ever.
- Every exported function that isn't trivial gets a short TSDoc comment explaining *why*, not a restatement of the signature.
- Environment variables are validated once at startup via a schema (zod) — never read scattered `process.env.X` calls through business logic.

## Workflow expectations

- Check which Phase (0–5) a task belongs to in the action plan before starting; Phase 1 (sampling/population engine) work shouldn't get blocked on Phase 5 (SEO audit UI) polish, and vice versa.
- When a change touches a decision the action plan marks open, say so explicitly rather than picking an answer silently.
- Update `docs/architecture-review-and-action-plan.md` when a real architectural decision gets made or changed — it's meant to stay current, not freeze as a one-time snapshot.
- Never commit `.env`, credentials, or AWS/SFTP keys. `.env.example` documents what's needed; real values stay local or in Secrets Manager.
- New logic in `packages/sampling` (confidence intervals, sampling algorithms, statistical decisions) needs tests — this is the part of the system a wrong-but-plausible-looking answer would be most costly, and it's also the part hardest to eyeball-review.

## Git conventions

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`.
- Branch names: `feat/<short-description>`, `fix/<short-description>`, or `phase-<n>/<short-description>` for work tied directly to an action-plan phase.
- Don't push directly to `main` once more than one person is working in this repo — open a PR, even a small one.
