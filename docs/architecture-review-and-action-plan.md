# Pattern-Aware SEO Platform — Architecture Review & Action Plan

Source: architecture review conducted in a shared ChatGPT conversation (against the `feature/aws-s3-sftp-deploy` branch and an uploaded code ZIP), critiqued and turned into an action plan on 2026-09-01. Tech stack recommendation added the same day, evaluated against a second ChatGPT proposal and reformatted for reference on 2026-09-01. Frontend design-tooling recommendation added and revised (Impeccable added) 2026-09-01.

## Context

The review examined the existing sitemap migration/health-check engine (Next.js frontend, Fastify backend, BullMQ + Redis, PostgreSQL, streaming SAX sitemap parsing, Piscina for CPU-heavy work, S3/SFTP deployment) and concluded the direction is sound: don't rewrite it, evolve it into a pattern-aware, sampling-based SEO intelligence platform that can audit sites with tens or hundreds of millions of URLs without crawling the whole URL universe. The core idea — collapse 90M+ URLs into a few thousand patterns, sample each pattern, verify statistically, and only do targeted deep audits where evidence says to — is the real differentiator and is worth keeping as the north star.

Deployment path: local development on the team's own Mac/Windows PCs first, then deployment to AWS for multi-user access, with model training on the accumulated sampling data planned as a later phase (this lines up with Phase 4 below).

The full transcript is not reproduced here; this document captures what's worth acting on, plus the gaps a second pass surfaced.

> **Phase 0 is complete as of 2026-09-01, and it corrects several claims in the next section.** The legacy repository (`../Sitemap_Migration`, branch `feature/aws-s3-sftp-deploy`) has now been read directly rather than secondhand. Three claims below turn out to be wrong, one is understated, two new problems were found, and the `PopulationProfile` open decision is resolved. The section immediately before "Action plan" records what the code actually does. **Read that section before acting on anything in "Issues and gaps in the review"** — the original text is kept intact deliberately, because which predictions held up is itself useful, but it is no longer accurate on its own.

## Issues and gaps in the review

The review is strategically strong but several things in it don't hold up, or were left unspecified, on closer look.

**Confidence intervals are named but not defined.** It recommends storing `confidence_interval` / `confidence_level` per pattern but never says which method to use. A naive normal-approximation interval breaks down at small sample sizes or when the observed error rate is near 0% or 100% (exactly the "1 error out of 20 samples" case the review itself uses as an example). Use the Wilson score interval (or Agresti–Coull) instead — both behave correctly in that regime.

**No finite-population correction.** Sampling 30 URLs out of a pattern with a population of 200 is statistically very different from sampling 30 out of 40 million, but the review treats "sample size 30" as equally informative in both cases. A finite-population correction factor needs to feed both the confidence-interval math and the "should we expand the sample" decision, or small patterns will be systematically over-sampled relative to what they need and large ones under-sampled relative to what the review implies.

**Hash-threshold sampling and reservoir sampling are conflated.** The review proposes both "keep URLs where `hash(url) < threshold`" and "streaming reservoir sampling" as if they're the same technique. They're not: threshold sampling gives a sample size that varies around an expected value (awkward when the code already enforces a hard minimum of 30), while classic reservoir sampling gives an exact size but doesn't cleanly support "grow the sample later" without extra state. The technique that actually gives both properties — exact size, streamable in one pass, growable later without re-scanning — is a bounded min-heap keyed by hash (keep the K smallest hashes seen so far; raising K later is a superset of the previous set, same reproducibility property the review wants). That's the one to implement, not either of the two it mentions.

**The repo-specific claims are unverified in this session.** Everything about `triageSampling.ts`, `patternPopulationPool.ts`, `workerRuntime.ts`, `samplePatternsJob.ts`, and the current Piscina pool setup is ChatGPT's reading of the actual code — this session has not seen the repository. That matters because the most reassuring conclusion in the review ("your triage engine is already close to what I was proposing") rests entirely on those unverified reads. Worth confirming directly before treating it as settled — see Phase 0 below.

**No multi-tenant resource isolation.** The end state is 650 sites running concurrently. The review covers per-host HTTP rate limiting (correctly separating concurrency from requests/sec, and making the limiter host-global) but says nothing about isolating BullMQ queues, Postgres connection pools, or Redis memory budgets per site or tenant. Without that, one site's job flood — say, a 90M-URL sitemap reprocessing — can starve smaller sites sharing the same Redis instance and queue namespace.

**PopulationProfile may duplicate what already exists.** The review proposes a new `PopulationProfile` entity, but earlier in the same review it notes the repo already has `pattern_shape_rules`, `structureClusters.ts`, `shapeStrata.ts`, and per-pattern coverage tracking. Whether this is a genuinely new entity or a rename/consolidation of what's already there needs a schema read before anyone writes migrations for it, to avoid ending up with two overlapping systems.

**No cost or infrastructure budget analysis.** 20–400 sampled requests per pattern, times thousands of patterns, times 650 sites, is still potentially millions of outbound requests a month. The review never discusses egress cost, the risk of tripping target-site WAFs at that volume, or a platform-wide request budget on top of the per-host limits.

**No observability or audit-trail plan.** A system that's going to publish claims like "P0: 13.8M URLs estimated affected" needs monitoring for its own estimator health (alerts when confidence keeps coming back LOW, or sampling never converges) and a way to reconstruct exactly what inputs produced a given historical report. Not addressed.

**The GET-fallback escalation isn't bounded.** HEAD-first with GET-on-suspicious is the right call, but nothing caps how much of the response body gets fetched for soft-404 detection (should be the first few KB, not the whole page), and nothing caps how much of a pattern's sample is allowed to escalate to GET before the pattern just gets flagged for manual review — otherwise a genuinely bad pattern defeats the "reduce HTTP traffic" goal the HEAD-first design exists for.

## Phase 0 verification results (2026-09-01)

Verified directly against `../Sitemap_Migration` on branch `feature/aws-s3-sftp-deploy` — 313 TypeScript files, 56 SQL migrations, a Next.js 14 frontend, real tests and benchmarks. Line references are to that tree.

| Claim in "Issues and gaps" above | Verdict | Evidence |
|---|---|---|
| `ORDER BY random()` in the sampling path | **Confirmed** | `backend/src/jobs/samplePatternsJob.ts` lines 116, 133, 152 — three occurrences over `pattern_urls` |
| "Confidence intervals are named but not defined" | **Wrong** | `estimateFromObservations` (`triageSampling.ts:505`) is a real stratified proportion estimator with a 95% interval, persisted as `ci_low`/`ci_high` in `verify_triage_runs.result` (migration `040`) |
| "No finite-population correction" | **Wrong** | The FPC `(1 − n_h/N_h)` is implemented, per stratum, in that estimator's variance term |
| Normal approximation degenerates near p≈0 | **Confirmed, and worse than stated** | At zero observed hits `p̂(1−p̂) = 0`, so variance is 0, the half-width is 0, and the interval collapses to `[0, 0]`. The system currently reports *certainty of zero errors* from a 1% sample. The single most damaging statistical defect. |
| "Hash-threshold and reservoir sampling are conflated" | **Partly right** | Two different mechanisms coexist. Triage draws "first k by hash" (`stableHash`, FNV-1a, `triageSampling.ts:99`) — correct, reproducible, and expansion is genuinely a superset. But `extractPatternsJob.ts:427` runs an Algorithm-R reservoir on `Math.random()`, which is **not** reproducible. |
| "GET body fetches are not size-capped" | **Wrong** | Capped and ranged: `SOFT_404_BODY_SAMPLE_BYTES = 64KB` sent with a `Range: bytes=0-…` header, `METHOD_FALLBACK_BODY_SAMPLE_BYTES = 8KB` (`sampleUrlCheck.ts:73-77`) |
| "Nothing caps how much of a sample escalates to GET" | **Confirmed** | Per-request byte caps exist; there is no pattern-level escalation-share cap |
| "No multi-tenant resource isolation" | **Confirmed, and deeper** | There is **no site or tenant entity at all** — every table keys on `session_id`, a one-shot migration run. Zero `site_id` and zero `PARTITION BY` across all 56 migrations. |
| *(new)* Full URL population materialized in memory | **Blocker at scale** | `triageJob.ts:183`: `const allUrls = Array.from(population.keys())` builds the whole pattern population as a JS string array and passes it to `planTriageSample(rawUrls: string[])`. Fatal on a 40M-URL pattern. |
| *(new)* The interval is computed and never displayed | **Confirmed** | `frontend/components/pattern-verify-panel.tsx:695` renders `~${formatNumber(estimate)}` — the point estimate only. The product's central claim is invisible in its own UI. |
| No pattern-to-file index | **Confirmed by the code's own comment** | `patternPopulationPool.ts:16-19`: *"Enumeration reads every `<loc>` of every file in the session … the only way to do it, since nothing records a pattern-to-file index."* |
| Per-host rate limiter is sound | **Confirmed, with a caveat** | `http/hostRateLimiter.ts` correctly separates concurrency from requests/sec and is host-global — but it is **process-global in memory**, so the effective rate silently multiplies by the container count on ECS. |

**What is worth porting rather than rewriting.** The legacy code is better than the review credited, and several modules carry operational knowledge that would be expensive to re-derive: `sitemaps/parser.ts` (749 lines of streaming SAX with gzip, non-XML preamble recovery, redirect and nested-index handling, and an existing `LocCallback` streaming hook), `http/hostRateLimiter.ts`, `jobs/sampleUrlCheck.ts`, `sitemaps/structureClusters.ts`, `jobs/workerRuntime.ts`, and the user-agent constants in `config.ts` — which encode contradictory-but-real WAF findings measured against named hosts, and should be ported verbatim including their comments. The frontend is already Next.js 14 + Tailwind + shadcn/ui + Radix + TanStack Table + Recharts, i.e. exactly the stack recommended below, and its practice of extracting display decisions into unit-tested pure functions under `frontend/lib/` is worth carrying forward.

### Resolved: is `PopulationProfile` new?

**It is genuinely new**, and none of the three candidates duplicates it:

- `sitemaps/structureClusters.ts` clusters `{param}` values into anchored families — a **classifier**. Reuse it as the stratifier.
- `jobs/shapeStrata.ts` + `pattern_shape_rules` (migration `051`) group URLs by *valueShape* and store a distilled rewrite rule per shape — an **inference artifact for redirect fixing**, and migration `051` is emphatic that it is inference rather than measurement. It belongs to the fix workflow, which is now out of scope (see `decisions.md`, ADR-0007).
- `verify_triage_runs` (migration `040`) is a per-run **estimate snapshot**.

Nothing stores *"for pattern P: which files hold it, how many URLs, and which sample candidates."* It will be named for what it is — `pattern_population` / `pattern_file_population` — not `PopulationProfile`.

## Action plan

### Phase 0 — Verify before building — **COMPLETE (2026-09-01)**

- ~~Confirm the repo-specific claims above by reading the actual current code~~ — done; results in the section above.
- ~~Decide whether `PopulationProfile` is a new entity or a consolidation~~ — resolved above: new entity, renamed.
- ~~If the repository becomes accessible to a Claude session, it can do this verification directly~~ — done; the legacy repo was read at `../Sitemap_Migration`.

Decisions taken alongside this verification are recorded in `decisions.md` (ADR-0001 through ADR-0008). Scope is now **audit and intelligence only** — the fix-and-republish workflow stays in the legacy tool (ADR-0007) — and the legacy tool is frozen after cutover on audit.

### Phase 1 — Harden the sampling and population engine (critical)

- Replace the `ORDER BY random()` sampling path in `samplePatternsJob.ts` with deterministic sampling — this is a well-known PostgreSQL anti-pattern at scale since it forces a sort/randomize over the whole candidate set.
- Implement bounded min-heap-by-hash sampling (fixed size K, one streaming pass, growable later without re-scanning) in place of the ambiguous threshold/reservoir approach the review floated.
- Fold sample-candidate collection into the existing SAX streaming pass over the sitemap, so pattern population counts, per-file counts, and sample candidates are all captured in one pass — this removes the current need to rescan the whole population to find a given pattern's URLs.
- Add the persistent population index (pattern_id, file_id, population_count, sample-candidate references, timestamps) — after the Phase 0 decision on whether this reuses existing tables.
- Implement Wilson score confidence intervals with finite-population correction applied whenever sample size isn't negligible relative to population (e.g., above ~5%).
- Wire adaptive sample expansion to the confidence output, using the expansion bounds already present in the code (minimum/maximum sample size, expansion factor, anomaly trigger).

### Phase 2 — Impact scoring and evidence model (high)

- Add an Impact Score (population × error probability × severity), starting with a simple static severity table by status-code class; leave a GSC-traffic-factor multiplier as a later hook rather than building it now.
- Extend the existing evidence provenance model (sampled / operator / no_change / operator_pattern) with only the additional evidence-source categories that will actually be populated soon — avoid adding enum values that stay permanently empty.
- Cap the HEAD→GET escalation: limit GET body fetch size for soft-404 detection, and cap how much of a pattern's sample may escalate to GET before the pattern is flagged for manual review instead of continuing to burn budget.

### Phase 3 — Multi-tenant hardening (high — not in the original review)

- Partition BullMQ queues / Redis key namespaces per site or site tier so one site's job volume can't starve others.
- Add a platform-wide outbound request budget on top of the existing per-host limits, with alerting as it's approached.
- Budget Postgres connection pools per worker type so a population-scan spike doesn't starve connections needed by the API or dashboard.

### Phase 4 — Historical intelligence and risk modeling (medium)

- Start persisting sample outcomes over time per pattern/site now — this is cheap and doesn't require any ML to be useful later.
- Once enough history exists, train a simple baseline (logistic regression before XGBoost/LightGBM) to predict pattern risk and set per-pattern sampling budgets, instead of every pattern getting the same default sample size.

### Phase 5 — SEO evidence and audit layer (later)

- Build targeted page audits on top of the pattern engine, scoped to patterns sampling has flagged as risky — not full crawls.
- Add GSC integration as a second intelligence source feeding the Impact Score.
- Build the cross-site (650-site) enterprise dashboard last, since it's only as good as everything under it.

### Cross-cutting: observability (start in Phase 1, not later)

- Dashboards for sampling convergence rate, share of patterns stuck at LOW confidence, GET-escalation rate, and per-site request volume against budget.
- A way to reconstruct exactly which inputs produced a given historical report, so a claim like "13.8M URLs estimated affected" is defensible after the fact.

## Open decisions — status after Phase 0

- ~~Is `PopulationProfile` new, or does it consolidate `pattern_shape_rules` / `structureClusters` / `shapeStrata`?~~ **Resolved:** genuinely new, and renamed `pattern_population`. See the Phase 0 results above.
- ~~Should the actual repository be connected to a Claude session so architecture claims can be verified directly?~~ **Resolved:** done. The legacy repo was read at `../Sitemap_Migration`.
- ~~Does "multi-user" mean the internal Asapsemi team, or will external clients ever log in?~~ **Resolved:** internal RBAC (admin/analyst/viewer) via Auth.js now, but the schema carries an `organization` boundary from day one so external client logins can be added without reshaping tables. See ADR-0004.
- **Still open — what severity weights should the initial Impact Score use?** Needs SEO/business input, not an engineering guess. **Owner: Shabab Arshad.** This is a hard entry condition for the Impact Score work (Phase 2): that milestone does not start without a first version of the table.
- **Still open — what is the acceptable platform-wide HTTP request budget per day/month**, and do any of the 650 target sites have contractual or `robots.txt` crawl-rate constraints that should cap it further? Provisional defaults are now implemented in `packages/shared/src/config.ts` so Phase 2/3 work is not blocked — 5,000,000 requests/day platform-wide, 250,000 per site per audit, giving roughly a 33-day full-fleet cycle. Those are engineering estimates and must be re-derived from the first ten real site audits before the first full-fleet run.

## Recommended tech stack

A second ChatGPT conversation proposed the full stack below for local Mac/Windows development first, then AWS deployment for multiple users, with model training on the accumulated data as a later phase. The core of it is correct and endorsed here — it matches the existing codebase, so most rows are "keep what you have," not a new decision. Rows marked with a note below the table have an adjustment worth reading before committing to them as written.

### Recommended core stack (2026)

| Layer | Technology | Why this choice | Local (Mac/Windows) | AWS |
|---|---|---|---|---|
| Frontend | Next.js 15/16 (App Router) + TypeScript | Excellent for dashboards, SSR/SSG, Server Actions, React ecosystem | `npm run dev` | ECS Fargate (see note 1) |
| UI | shadcn/ui + Tailwind CSS + Recharts/Tremor | Fast, clean, professional enterprise look | Perfect | Perfect |
| Backend API | Fastify 5 + TypeScript | Extremely fast, low overhead, great plugin ecosystem, schema validation | Runs natively | ECS Fargate / EC2 / EKS |
| Job Queue | BullMQ + Redis | Best-in-class for Node: priorities, rate limiting, delayed jobs, retries | Redis via Docker (see note 2) | ElastiCache (Redis) |
| Database | PostgreSQL 16 | Strong for relational data, JSONB, window functions, statistical queries | Docker or local Postgres (Postgres.app / Homebrew / Windows installer) | Amazon RDS PostgreSQL (see note 3) |
| ORM / query layer | Prisma or Drizzle | See note 4 — not actually interchangeable for this workload | Both work | Both work |
| CPU-heavy work | Piscina (worker threads pool) | Ideal for SAX parsing, hash calculations, confidence-interval math, pattern processing | Native | Native (worker containers) |
| Sitemap parsing | sax or saxes (streaming) + custom pattern extraction | Memory-efficient for huge sitemaps | Native | Native |
| HTTP client / crawler | undici + optional Playwright (deep audits only) | Fast, modern; keep Playwright out of the main sampling path | Native | Native |
| Object storage | AWS SDK v3 (S3) | Already in the architecture for S3/SFTP deploy | Real S3 dev bucket (see note 5) | S3 |
| Auth | NextAuth.js / Auth.js or Clerk | See note 6 — depends on an unanswered question | Easy | Easy |
| Observability | OpenTelemetry + Prometheus + Grafana (or AWS X-Ray + CloudWatch) | Critical for sampling convergence, request budgets, estimator health | See note 7 — defer for now | CloudWatch + Managed Grafana or AMP |
| ML training (added — not in the original proposal) | Separate Python service (FastAPI + scikit-learn/XGBoost/LightGBM) reading from the same Postgres | See note 8 — needed for the Phase 4 risk model, without rewriting the platform | Runs as its own local process/container | Its own small ECS service or scheduled job |

### Notes on the table (adjustments to the original proposal)

1. **Frontend on AWS** — the original proposal also lists Amplify Hosting or EKS or Vercel-then-AWS as options. ECS Fargate is the one to plan around here, since API and workers are already going to ECS — keeping the frontend on the same platform avoids running a second deployment system for no real benefit at this stage.
2. **Redis locally** — the original proposal says "Redis via Docker or local Redis." On Windows there's no supported native Redis build, so Docker is not optional there; only macOS can realistically run it natively (via Homebrew). Use Docker Compose for both platforms so Mac and Windows environments stay identical.
3. **Database on AWS** — the original proposal suggests Aurora Serverless v2 "if traffic is spiky." This workload's traffic (bursty population scans and sampling jobs) is spiky in exactly the way that makes ACU-based billing unpredictable before there's usage history to size it against. Start with a provisioned RDS instance sized from real local/staging load, add a read replica once dashboard read load justifies it, and revisit Aurora once there's billing data to compare. Partition the large per-URL and per-pattern tables by `site_id` from the start — cheap now, expensive to retrofit after 650 sites have data in an unpartitioned table.
4. **ORM/query layer** — Prisma and Drizzle are not interchangeable here. The sampling engine needs hash-based filtering, window functions, and CTEs close to raw SQL (Phase 1 above is largely about getting away from ORM-shaped queries like `ORDER BY random()`), and Prisma's query engine gets awkward exactly in that territory. Use Drizzle (or Kysely, a thinner type-safe SQL builder with no migration opinions of its own) for the `packages/sampling` and `packages/sitemap` query paths; Prisma is still fine for simpler CRUD — dashboard/admin, user and site management — if the team prefers it there. No need to standardize on one ORM for the whole codebase.
5. **Local S3 testing** — the original proposal suggests LocalStack for local S3 simulation. Since S3/SFTP deploy correctness is an active feature (`feature/aws-s3-sftp-deploy`), testing against LocalStack's emulation risks masking real-service behavior differences (auth edge cases, multipart upload thresholds, eventual consistency quirks) that only show up against actual S3. A dedicated low-traffic dev bucket costs close to nothing at this scale and removes that risk.
6. **Auth** — this depends on an open question (also listed above): does "multiuser" mean the internal Asapsemi team (RBAC across roles: admin/analyst/viewer), or will external clients ever log in? If internal, Auth.js (free, self-hosted, full control of the RBAC/org model) is the better fit than Clerk, whose per-user pricing and managed-org model are built for customer-facing SaaS. If external client logins are actually on the roadmap, Clerk's managed org support earns its cost. Settle this before Phase 3 (multi-tenant hardening) rather than defaulting to whichever library is easiest to wire up first.
7. **Observability** — the full OpenTelemetry + Prometheus + Grafana stack is right for the AWS multi-user phase, but standing it up for solo local development is overhead without payoff. For the PC-first phase, structured JSON logging plus the sampling-health tables already called for above (convergence rate, confidence distribution, escalation rate) is enough to build against. Add the full stack when deploying to AWS for multiple users, not before.
8. **ML training** — the original proposal only says to avoid Python for the main workers (correct — Node stays right for the streaming/sampling core), but doesn't address the model-training work that's actually planned (Phase 4 above). The right shape is a hybrid: keep the whole platform in Node/TypeScript as proposed, and add one small, separate Python service — a FastAPI app, or even just scheduled training scripts — that reads features from the same PostgreSQL database (the historical sample-outcome data Phase 4 starts collecting immediately) and either writes predictions back to Postgres on a schedule or serves a small internal `/predict` endpoint the Fastify backend calls when computing per-pattern sampling budgets. scikit-learn/XGBoost/LightGBM are the natural choices, matching Phase 4. This keeps the core platform's language unchanged while giving the ML work proper tooling — training in Node, or rewriting the platform in Python for the model's sake, are both the wrong trade.

### Local development setup (Mac + Windows)

Use Docker Compose so Mac and Windows developers get identical environments. See `docker-compose.yml` at the repo root — it already reflects this (real S3 dev bucket instead of LocalStack, per note 5).

Run Next.js, Fastify, and the workers directly on the host (Node 22 LTS). Use `pnpm dev` (Turborepo) to start the API, workers, and frontend together, or `pnpm --filter <app> dev` for just one. Piscina works natively on both Apple Silicon and Windows. For large sitemap testing, mount a local folder or point at the real S3 dev bucket.

### AWS deployment architecture

Start simple and scale later.

**Phase 1 — MVP / early production:**

- Frontend, API, and workers: ECS Fargate (separate task definitions for the API and worker services; see note 1 on keeping the frontend here too rather than Amplify).
- Database: Amazon RDS PostgreSQL, provisioned (not Aurora Serverless v2 — see note 3).
- Redis: Amazon ElastiCache.
- Storage: S3.
- Load balancer: Application Load Balancer.
- Secrets: AWS Secrets Manager.
- CI/CD: GitHub Actions → ECR → ECS.

**Later, once there's an actual scaling problem (100+ sites or heavy load):**

- Stay on ECS + Auto Scaling Groups if it keeps meeting needs — it's simpler and cheaper than Kubernetes for most teams; only move to EKS if finer control over worker-pool autoscaling becomes a real requirement, not a hypothetical one.
- AWS Batch or Spot instances for very large one-off population scans.
- SQS in front of specific job types only if a concrete durability gap in BullMQ shows up in practice — don't add it pre-emptively.

### Why this stack fits

This matches the current direction — Next.js, Fastify, BullMQ, Redis, PostgreSQL, Piscina, and SAX streaming are already in place, so this is hardening, not a rewrite. It's local-first: everything runs on Mac and Windows with Docker Compose, no cloud required for development. Every component has a first-class managed AWS service, so the path to production doesn't require re-architecting. Fastify + BullMQ + Piscina + streaming SAX is a genuinely high-throughput combination for this specific workload. It's multi-tenancy ready — PostgreSQL (partitioned by `site_id`, with row-level security or schema-per-tenant as a later option) plus BullMQ queue isolation and Redis key namespacing (see Phase 3 above) covers the 650-site end state. And it's cost-controlled: ECS Fargate + provisioned RDS starts cheap, and only the worker fleet needs to scale as load grows.

### What to avoid

NestJS is too heavy and opinionated for this shape of workload. Don't put the main workers on serverless (Lambda) — long-running sitemap processing and Piscina worker pools are a bad fit for Lambda's execution model. MongoDB isn't the right choice here — the workload leans on relational and statistical queries (window functions, CTEs) that Postgres is built for. Don't replace BullMQ — it remains the strongest Node queue for this. And don't treat "avoid Python" as blocking the ML roadmap — the fix is a separate small Python service (note 8), not avoiding Python everywhere or rewriting the platform in it.

### Project structure

See the repo root — the `apps/`, `packages/`, `ml-service/`, and `infrastructure/` layout here already reflects this plan. Managed with pnpm workspaces + Turborepo.

### Frontend design tooling (in the coding assistant, not the product itself)

This is about what to plug into whatever coding assistant builds the Next.js frontend (Claude Code or similar) — not something the shipped product depends on. These tools solve two different problems — design *taste* (does the output look considered rather than generic) versus *components* (what gets installed into the codebase) — and it's worth keeping the two separate rather than picking one tool to do both.

**Taste layer — pick one, don't run two at once, and Impeccable is the better fit here:**

- **Impeccable** (`pbakaus/impeccable`, open source) is the stronger choice for this specific project. Unlike a single automatic skill, it's a full design-vocabulary framework: one `/impeccable` skill with roughly 23 commands (`init`, `shape`, `critique`, `polish`, `audit`, `typeset`, `colorize`, `animate`, and more), backed by around 60 deterministic anti-pattern detectors (overused fonts, purple gradients, bounce easing, cards-in-cards, low-contrast gray text) and documented design decisions (`PRODUCT.md`/`DESIGN.md`) that keep a large surface area — a dashboard spanning 650 sites' worth of pattern health, confidence intervals, and impact scores — visually consistent as different people or sessions build different screens. Critically, its setup explicitly distinguishes "brand surfaces" (marketing/landing pages) from "product surfaces" (dashboards/tools/apps) and calibrates its checks accordingly — which is exactly the gap in Anthropic's own skill (next item). Install via `npx impeccable install` (auto-detects the Claude Code folder) or the plugin marketplace.
- **`frontend-design`** (Anthropic's official Claude Code plugin) is a lighter, single automatic skill aimed at the same problem — steering away from generic "AI slop" (Inter font, purple gradients, rounded-corner three-box grids). It's worth knowing about, but it leans maximalist/bold by default with no equivalent "this is a dashboard, not a landing page" mode, so it needs to be explicitly and repeatedly steered toward a clean, information-dense enterprise style for this project. Given Impeccable already handles that distinction natively, install Impeccable instead of this one for the dashboard — there's little reason to run both, since two taste-layer skills active at once can give the coding assistant conflicting instructions.

**Component layer — shadcn/ui MCP, not Magic UI, for this project:**

- **shadcn/ui MCP** (official, from ui.shadcn.com) is the one to install, because shadcn/ui is already the chosen component library in the stack above. It lets the coding assistant browse, search, and install real shadcn components and blocks — including shadcn's own dashboard blocks — directly into the codebase via natural language, and supports a private company registry later if a shared internal design system gets built. Install with `pnpm dlx shadcn@latest mcp init --client claude`, or configure manually via `.mcp.json`.
- **Magic UI MCP** (`magicuidesign/mcp`, from magicui.design) adds animated marketing-style components — marquees, particle/grid backgrounds, animated beams — on top of shadcn/ui and Tailwind. Good for a public-facing landing or marketing page for the product, but a poor fit for this dashboard: those effects fight readability in a dense interface built around tables, health scores, and status badges. Skip it here; revisit only if a marketing site for the product gets built later.
- **Note the name collision:** "21st.dev Magic MCP" (`21st-dev/magic-mcp`) is a different, unrelated project — an AI-driven UI generator pulling from 10,000+ components across many different design systems, closer to a v0-style generator than a scoped component installer. Mixing it in alongside shadcn MCP risks visual inconsistency, since it isn't scoped to one design system. Not recommended here.

**Recommended combination for this project:** Impeccable (taste layer, set up as a "product surface"/dashboard from its `init` step) + shadcn/ui MCP (components, including its dashboard blocks) + Tremor/Recharts for charts (already in the stack above). Skip `frontend-design`, Magic UI, and 21st.dev Magic MCP for the core dashboard; reconsider Magic UI only for a future public marketing page.

### Final recommendation

Stick with and harden the current direction: Next.js 15/16 + Fastify 5 + BullMQ + Redis + PostgreSQL 16 + Piscina + TypeScript for the platform, plus one small separate Python service for model training and inference once Phase 4 has enough historical data to train on. For the coding assistant building the frontend, pair Impeccable (design taste, set up for a product/dashboard surface) with the shadcn/ui MCP (components). This is the strongest combination for a pattern-aware, sampling-based SEO platform that needs to run locally today, look genuinely professional rather than templated, and scale to AWS with multiple users and, later, ML-driven sampling.
