# Deploying this platform

This is the runbook for containerizing and deploying the four services this
platform is actually made of — `apps/web` (Next.js), `apps/api` (Fastify),
`apps/worker` (BullMQ + Piscina), plus Postgres and Redis — and for the
Basic Auth stopgap that has to go in front of them before any of this leaves
a developer machine.

## Why not Vercel alone

Vercel is a strong fit for `apps/web` on its own, but it cannot run this
platform end to end:

- `apps/worker` runs persistent BullMQ consumers and Piscina thread pools.
  Vercel has no persistent compute — functions are short-lived and
  stateless — so a queue worker cannot run there in any form.
- `apps/api` is a standalone Fastify server (not Next.js API routes) with a
  long-lived Postgres pool and in-process rate-limiter/circuit-breaker state.
  It could be forced into serverless functions, but nothing about how it's
  built asks for that, and it fights the design instead of fitting it.

So it's Docker for `web` + `api` + `worker` + Postgres + Redis, full stop —
Vercel could optionally take over just the frontend later, but that adds a
cross-origin split (CORS, a second place to manage `WEB_API_URL`) for no
benefit while there's no auth story beyond the Basic Auth stopgap below.

## What changed to make this deployable

- `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` (see `.env.example`) — set both to
  put the whole platform behind one HTTP Basic Auth prompt:
  `apps/api/src/basic-auth.ts` gates every API route except `/health`, and
  `apps/web/middleware.ts` gates the whole Next app the same way. Setting
  only one fails the API at startup (`IncompleteBasicAuthConfigError`) rather
  than silently running unprotected. **This is a stopgap, not the real auth
  ADR-0026 defers** — it's one shared password, not a session or a user
  table. Don't mistake it for that.
- `apps/web/next.config.ts` now sets `output: "standalone"` so the Docker
  image doesn't ship a second full `node_modules`.
- `Dockerfile`s for all three apps (`apps/web/Dockerfile`,
  `apps/api/Dockerfile`, `apps/worker/Dockerfile`), each built from the
  **repo root** using a `turbo prune` + `pnpm install --frozen-lockfile`
  pattern so a container only carries the one app's workspace subset, not
  every package's dependencies.
- `docker-compose.yml` gained `api`, `worker` and `web` services behind a
  `full` Compose profile. Plain `docker compose up -d` is **unchanged** —
  still just Postgres + Redis, exactly what `LIVE_RUN_GUIDE.md` and local dev
  already assume.

## Step 1 — test the full stack locally in Docker

Do this before touching Railway or AWS. It's the same images either
destination runs, and it's much faster to debug on your own machine.

```bash
# Copy .env.example if you haven't, and set BOTH BASIC_AUTH_USER and
# BASIC_AUTH_PASSWORD for this test — leaving them unset works too, but then
# you're not testing the stopgap.
docker compose --profile full up -d --build
docker compose --profile full ps        # postgres, redis, api, worker, web all "Up"
```

Run migrations against the containerized database once, before the API
serves anything real:

```bash
DATABASE_URL="postgresql://seo_platform:password@localhost:${POSTGRES_PORT:-5432}/seo_platform" \
  pnpm --filter @pattern-aware/database db:migrate
```

Then:

- `curl -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASSWORD" http://localhost:3001/health`
  → `{"status":"ok",...}`. Without `-u`, confirm you get a `401`.
- Open `http://localhost:3000` in a browser — it should prompt for the same
  credentials before showing anything.
- `pnpm seed:demo` (against the same `DATABASE_URL`) or `pnpm live:run` (see
  `docs/LIVE_RUN_GUIDE.md`) to put real data behind the screens, then click
  through Overview/Projects/Runs/Analytics to confirm the containerized `web`
  is actually reaching the containerized `api`.

Tear down with `docker compose --profile full down` (add `-v` only if you
want to also drop the Postgres/Redis volumes — don't add it by default,
that's a data-loss step).

## Step 2 — deploy for testing (this phase): Railway

You said AWS is the destination once the product is complete, and asked what
to use for testing now. **Railway** is the recommended choice for this phase:
it runs the exact same Dockerfiles (no rewrite needed later — ECS/Fargate
consumes the same images), needs no Terraform/VPC work up front, gives you
managed Postgres and Redis with zero ops, and a public HTTPS URL per service
in minutes. Render or Fly.io are reasonable alternatives if you'd rather use
one of those instead; the steps below are Railway-specific but the shape is
the same anywhere that builds from a Dockerfile.

1. **Create the project.** [railway.app](https://railway.app) → New Project →
   Deploy from GitHub repo → select this repo.
2. **Add managed Postgres and Redis.** In the project, "+ New" → Database →
   PostgreSQL, and again for Redis. Railway gives each a `DATABASE_URL` /
   `REDIS_URL`-shaped connection variable you'll reference from the app
   services below (Railway calls this "variable referencing":
   `${{Postgres.DATABASE_URL}}` etc.) — don't hand-copy the connection
   string, reference it, so a Railway-side credential rotation doesn't
   silently break the app services.
3. **Add the `api` service.** "+ New" → GitHub Repo (same repo) →
   in Settings, set:
   - **Root Directory**: `/` (repo root — the Dockerfile needs the whole
     monorepo as build context, per the "Why" comment at the top of
     `apps/api/Dockerfile`)
   - **Dockerfile Path**: `apps/api/Dockerfile`
   - **Variables**: `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
     `REDIS_URL=${{Redis.REDIS_URL}}`, `NODE_ENV=production`,
     `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` (pick real values here)
   - **Networking**: generate a public domain (Settings → Networking →
     Generate Domain) so `web` can reach it, or keep it on Railway's private
     network if you set `web` up in the same project (preferred — keeps the
     API off the public internet entirely, which matters more than the
     Basic Auth stopgap does).
4. **Add the `worker` service.** Same repo, same steps, but:
   - **Dockerfile Path**: `apps/worker/Dockerfile`
   - **Variables**: `DATABASE_URL`, `REDIS_URL` (same references as `api`),
     `NODE_ENV=production`
   - No public networking needed — it only consumes queues.
5. **Add the `web` service.** Same repo:
   - **Dockerfile Path**: `apps/web/Dockerfile`
   - **Variables**: `WEB_API_URL=http://api.railway.internal:3001` (Railway's
     private networking hostname for the `api` service — internal traffic
     never leaves Railway's network, so this is the one hop that should
     *not* go over the public internet even though Basic Auth would still
     cover it if it did), `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` (same
     values as `api`)
   - **Networking**: generate a public domain — this is the one URL you
     actually give out.
6. **Run migrations once**, from your own machine, against Railway's public
   Postgres connection string (Railway → Postgres service → Connect tab):
   ```bash
   DATABASE_URL="<railway-postgres-connection-string>" \
     pnpm --filter @pattern-aware/database db:migrate
   ```
7. **Verify**: open the `web` service's public URL, confirm the Basic Auth
   prompt appears, log in, and check `/settings` renders (it's a read-only
   screen with no dependency on a seeded organization existing yet — see
   `OrganizationNotSeededError` if it 500s, meaning no organization row
   exists for `DEFAULT_ORGANIZATION_SLUG` yet). Run `pnpm live:run` or
   `pnpm seed:demo` against the Railway `DATABASE_URL` to put data behind it.

## Step 3 — later: moving to AWS

When the product is complete, the same three Dockerfiles are what ECS
Fargate (or EKS, though CLAUDE.md's non-negotiable rules already rule EKS out
for this workload) runs — nothing here is Railway-specific except the
`*.railway.internal` hostname convention in step 5. At that point:

- Push the three images to ECR.
- RDS Postgres + ElastiCache Redis replace the managed add-ons.
- The real auth question (ADR-0026, still open) needs answering before this
  goes further than internal use — Basic Auth is not a substitute for a
  session/user model, it's what stands between "no auth" and "one shared
  password" for the testing phase.
- `infrastructure/` is the scoped-but-empty Terraform/CDK location the
  architecture doc names for this — this is the point where it stops being
  empty.

## Known limits, unchanged by any of this

- **No real auth.** Basic Auth is a shared password, not a session. Anyone
  with the credentials can create/edit sites (`POST /sites`,
  `PATCH /sites/:siteId`) — treat the credentials themselves as the access
  boundary until ADR-0026 lands.
- **The twelve configured-but-unenforced operational limits** (ADR-0030,
  visible on `/settings`) are still unenforced regardless of where this
  runs. Deploying it does not turn `HTTP_PLATFORM_DAILY_REQUEST_CAP` into a
  real cap.
- **CORS is still wide open** (`origin: true` in `apps/api/src/app.ts`) —
  harmless today because nothing in the browser calls the API directly (see
  `lib/api.ts`'s docblock), but narrow it when real auth adds
  cookie/credentialed requests, per the comment already in that file.
