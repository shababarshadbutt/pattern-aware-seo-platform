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

Do this before touching AWS. It's the same images either place runs, and
it's much faster to debug on your own machine.

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

## Step 2 — deploy for testing (this phase): a single AWS EC2 instance

The plan changed from Railway to AWS directly, even for this testing phase.
The pragmatic way to do that **without** building out ECS/RDS/ElastiCache/ALB
infrastructure you'll likely reshape once the product is actually complete:
one EC2 instance running the exact `docker compose --profile full` stack
from Step 1. Same images, same compose file, same verification steps — just
running on a box in AWS instead of your laptop. This is a real, reasonable
way to run this in production for a while, not just a toy — plenty of small
products run this way. The step up from here (Step 3) is ECS Fargate + RDS +
ElastiCache, and nothing about this step makes that harder later, since it's
the same Dockerfiles either way.

### Which instance type

This platform's own docs are explicit that its stress-tested scale (10M-URL
corpora, 90M-URL sites) is a *design target*, not what a **testing** deployment
needs to run — `docs/LIVE_RUN_GUIDE.md` itself says to start with "tens to low
hundreds of URLs". Sized for that, not for the architecture doc's ceiling:

| Instance | vCPU | RAM | ~On-demand cost (us-east-1) | Verdict |
|---|---|---|---|---|
| `t3.medium` | 2 | 4 GB | ~$30/mo | Workable, but Postgres + Redis + API + worker + web sharing 4 GB leaves little headroom once you run a real `pnpm live:run` — the Piscina thread pool (`PARSE_MAX_THREADS`, default 4) and Postgres's own cache both want memory at the same time. |
| **`t3.large`** | 2 | 8 GB | ~$60/mo | **Recommended.** Comfortable headroom for all five containers at once, still burstable/cheap, x86_64 so there is zero doubt about native-module compatibility (`esbuild`, `msgpackr-extract` — both showed up building these images). |
| `t4g.large` | 2 | 8 GB | ~$49/mo | Same RAM as `t3.large` for ~20% less — it's Graviton (ARM64) instead of x86_64. This works here specifically because you'd be running `docker compose build` **on the instance itself**, not pushing a pre-built x86 image to it, so there's no cross-architecture step to get wrong. Take this if you're comfortable debugging an obscure native-module issue for the savings; take `t3.large` if you'd rather not think about it. |

Storage: a **30 GB gp3** root volume (the default 8 GB on most AMIs is tight
once Docker's image layers and Postgres's data volume are both on it).
OS: **Ubuntu Server 24.04 LTS** — the steps below assume it.

### 1. Launch the instance

- AMI: Ubuntu Server 24.04 LTS (x86_64 for `t3.large`, arm64 for `t4g.large`
  — pick the matching AMI architecture).
- Instance type: `t3.large` (see above).
- Storage: 30 GB gp3.
- **Security group** — this matters more than usual since there's no real
  auth yet, only the Basic Auth stopgap:
  - `22/tcp` (SSH) from **your own IP only**, not `0.0.0.0/0`.
  - `80/tcp` and `443/tcp` (HTTP/HTTPS) from anywhere, once you set up the
    reverse proxy in step 7 below.
  - **Do not open `3001` (api), `5432` (postgres) or `6379` (redis) to the
    internet at all.** Nothing external needs to reach them directly — `web`
    reaches `api` over the Docker-internal network regardless of what's
    published to the host, and Postgres/Redis should never be reachable from
    outside the box.
- Allocate and associate an **Elastic IP** so the address doesn't change on
  a stop/start (mention it to whoever sets up DNS in step 7).
- Create or reuse a key pair for SSH.

### 2. Install Docker

SSH in, then:

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"
# log out and back in for the group change to take effect
```

### 3. Get the code onto the box

```bash
git clone https://github.com/<your-org>/<this-repo>.git
cd <this-repo>
```

Use a deploy key or a fine-scoped personal access token for a private repo —
don't put a broadly-scoped token in a file that lands on a server.

### 4. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set real values for `BASIC_AUTH_USER` and
`BASIC_AUTH_PASSWORD` — this is the one thing standing between the internet
and an unauthenticated `POST /sites` (see "Known limits" below). Everything
else in `.env.example` can stay at its default for a testing deployment;
`docker-compose.yml`'s `full` profile already wires `DATABASE_URL`/`REDIS_URL`
to the containerized Postgres/Redis for you.

### 5. Bring up the stack

```bash
docker compose --profile full up -d --build
docker compose --profile full ps        # postgres, redis, api, worker, web all "Up"
```

### 6. Run migrations once

```bash
docker compose exec postgres psql -U seo_platform -d seo_platform -c "select 1;"   # sanity check it's up
DATABASE_URL="postgresql://seo_platform:password@localhost:${POSTGRES_PORT:-5432}/seo_platform" \
  pnpm --filter @pattern-aware/database db:migrate
```

### 7. Put a reverse proxy in front (recommended, not optional)

Basic Auth sends credentials that decode to plain text with one line of
code — **over plain HTTP that's no protection at all.** If you have a domain
to point at this box, [Caddy](https://caddyserver.com) gets you automatic
HTTPS with a four-line config and no separate certbot setup:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Point your domain's `A` record at the instance's Elastic IP, then write
`/etc/caddy/Caddyfile`:

```
your-domain.example {
    reverse_proxy localhost:3000
}
```

`sudo systemctl reload caddy`. Caddy fetches and renews the certificate on
its own; `web` stays on plain HTTP on `localhost:3000` (not exposed publicly
— only Caddy's 80/443 are), and Basic Auth now actually protects something.

No domain yet? Skip this step for now, but treat the deployment as
**internal-only** until you add it — put it behind a VPN, or restrict the
security group's `3000/tcp` to specific IPs — rather than exposing Basic
Auth over plain HTTP to the open internet.

### 8. Verify

- `https://your-domain.example` (or `http://<elastic-ip>:3000` if you
  skipped step 7) prompts for Basic Auth before showing anything.
- `pnpm live:run` or `pnpm seed:demo` against the box's `DATABASE_URL` to put
  real data behind the screens (run these from your own machine with
  `DATABASE_URL` pointed at the instance, or SSH in and run them there).

### 9. Keep it running across reboots

Docker itself restarts on boot once enabled, and every service in
`docker-compose.yml` already has `restart: unless-stopped` — but the `full`
profile's containers still need `docker compose --profile full up -d` to
have run at least once after boot for Compose to know about them. The
simplest fix is a systemd unit:

```bash
sudo systemctl enable docker
```

then add a small systemd service (or a `@reboot` crontab entry) that runs
`docker compose --profile full up -d` from the repo directory on boot — a
one-line addition, not worth a generated unit file here since it depends on
where you cloned the repo.

## Step 3 — later: moving beyond one box (ECS Fargate + RDS + ElastiCache)

The same three Dockerfiles are what ECS Fargate (or EKS, though CLAUDE.md's
non-negotiable rules already rule EKS out for this workload) runs — this
single-instance setup and that one consume identical images, so nothing here
is wasted when you outgrow it. Move to this once the product is complete and
you need independent scaling, zero-downtime deploys, or multi-AZ resilience
that one box can't give you:

- Push the three images to ECR.
- RDS Postgres + ElastiCache Redis replace the containerized ones — this is
  also the point where a Multi-AZ RDS instance and automated backups stop
  being optional.
- An Application Load Balancer replaces Caddy for TLS termination, fronting
  the `web` ECS service; `api` and `worker` stay on the private network with
  no public listener, same principle as the security group rule in step 2.
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
