Pattern-Aware SEO Platform — Architecture Review & Action Plan

Source: architecture review conducted in a shared ChatGPT conversation (against the feature/aws-s3-sftp-deploy branch and an uploaded code ZIP), critiqued and turned into an action plan on 2026-09-01. Tech stack recommendation added the same day, evaluated against a second ChatGPT proposal and reformatted for reference on 2026-09-01. Frontend design-tooling recommendation added and revised (Impeccable added) 2026-09-01. Implementation progress (M0, M1) logged 2026-09-01.

Context

The review examined the existing sitemap migration/health-check engine (Next.js frontend, Fastify backend, BullMQ + Redis, PostgreSQL, streaming SAX sitemap parsing, Piscina for CPU-heavy work, S3/SFTP deployment) and concluded the direction is sound: don't rewrite it, evolve it into a pattern-aware, sampling-based SEO intelligence platform that can audit sites with tens or hundreds of millions of URLs without crawling the whole URL universe. The core idea — collapse 90M+ URLs into a few thousand patterns, sample each pattern, verify statistically, and only do targeted deep audits where evidence says to — is the real differentiator and is worth keeping as the north star.

Deployment path: local development on the team's own Mac/Windows PCs first, then deployment to AWS for multi-user access, with model training on the accumulated sampling data planned as a later phase (this lines up with Phase 4 below).

The full transcript is not reproduced here; this document captures what's worth acting on, plus the gaps a second pass surfaced.

Implementation progress
M0 (Phase 0 foundation) — complete. Tooling/enforcement (Biome + a narrow type-aware ESLint pass, pre-commit hook, CI), real workspace packages, packages/shared (zod-validated startup config, pino logging, a domain error hierarchy with an isExpected flag separating expected failures from bugs), initial apps/web scaffold conforming to docs/DESIGN.md. docs/decisions.md (ADR log) established. Two corrections to this doc's original Phase 1 language were identified during M0 verification (finite-population-correction and GET body-cap specifics) — pending the exact corrected text to fold in here; treat docs/decisions.md as ground truth on those two points in the meantime.
M1 (Phase 1 schema/tenancy) — complete. Real schema landed: organization → site → sitemap_run → sitemap_file → pattern → pattern_population / pattern_sample → sample_observation, plus audit_snapshot and sampling_health. Root entity is site (not a one-off run), which is what makes trends, regressions, a fleet view, and historical training data possible — a direct fix of the legacy model's biggest limitation. The degenerate-interval defect (a sample claiming zero-width confidence from a partial count — the highest-value alert in the legacy system) is now a CHECK constraint, not just monitored. Tenant isolation is enforced at the type level: packages/database exposes an opaque Database type with no query methods and a single entry point, so an unscoped/cross-tenant query doesn't compile, verified by a @typescript-eslint/tsc-checked test suite. Two new standards exceptions from real PostgreSQL constraints are recorded in docs/CODING_STANDARDS.md (partitioned-table primary keys) and docs/decisions.md (ADR-0010 and others) — this doc's Phase 1 language on primary keys should be read alongside that exception now.
Open question from M1, not yet resolved here: M1's schema doesn't visibly carry forward the shape/stratum distinction (structureClusters/shapeStrata/pattern_shape_rules) that the original review flagged as valuable and that the "Open decisions" section below asks about — pattern_population/pattern_sample may supersede it, consolidate it, or simply not have reached that granularity yet at M1. Needs a direct answer before this doc's PopulationProfile open decision gets marked resolved.
Known operational gap: as of M1, three branches (develop, the M0 branch, and phase-1/m1-schema-tenancy) are unmerged and CI has never been observed actually running in GitHub's environment (local gh isn't authenticated) — meaning "all gates pass" so far is a local-only claim, not a verified-in-CI one. M1 specifically adds a Postgres service container to CI, which is exactly the kind of step that behaves differently in a real runner than locally. Worth closing this gap (authenticate gh, push, open the PRs, confirm a green run) before compounding more milestones on an unverified pipeline — not a hard blocker, but shouldn't be deferred indefinitely.
Issues and gaps in the review

The review is strategically strong but several things in it don't hold up, or were left unspecified, on closer look.

Confidence intervals are named but not defined. It recommends storing confidence_interval / confidence_level per pattern but never says which method to use. A naive normal-approximation interval breaks down at small sample sizes or when the observed error rate is near 0% or 100% (exactly the "1 error out of 20 samples" case the review itself uses as an example). Use the Wilson score interval (or Agresti–Coull) instead — both behave correctly in that regime.

No finite-population correction. Sampling 30 URLs out of a pattern with a population of 200 is statistically very different from sampling 30 out of 40 million, but the review treats "sample size 30" as equally informative in both cases. A finite-population correction factor needs to feed both the confidence-interval math and the "should we expand the sample" decision, or small patterns will be systematically over-sampled relative to what they need and large ones under-sampled relative to what the review implies. (M0 verification found this section's own threshold language needed correction — see Implementation progress above; check docs/decisions.md for the corrected version.)

Hash-threshold sampling and reservoir sampling are conflated. The review proposes both "keep URLs where hash(url) < threshold" and "streaming reservoir sampling" as if they're the same technique. They're not: threshold sampling gives a sample size that varies around an expected value (awkward when the code already enforces a hard minimum of 30), while classic reservoir sampling gives an exact size but doesn't cleanly support "grow the sample later" without extra state. The technique that actually gives both properties — exact size, streamable in one pass, growable later without re-scanning — is a bounded min-heap keyed by hash (keep the K smallest hashes seen so far; raising K later is a superset of the previous set, same reproducibility property the review wants). That's the one to implement, not either of the two it mentions.

The repo-specific claims are unverified in this session. Everything about triageSampling.ts, patternPopulationPool.ts, workerRuntime.ts, samplePatternsJob.ts, and the current Piscina pool setup is ChatGPT's reading of the actual code — this session has not seen the repository. That matters because the most reassuring conclusion in the review ("your triage engine is already close to what I was proposing") rests entirely on those unverified reads. Worth confirming directly before treating it as settled — see Phase 0 below.

No multi-tenant resource isolation. The end state is 650 sites running concurrently. The review covers per-host HTTP rate limiting (correctly separating concurrency from requests/sec, and making the limiter host-global) but says nothing about isolating BullMQ queues, Postgres connection pools, or Redis memory budgets per site or tenant. Without that, one site's job flood — say, a 90M-URL sitemap reprocessing — can starve smaller sites sharing the same Redis instance and queue namespace.

PopulationProfile may duplicate what already exists. The review proposes a new PopulationProfile entity, but earlier in the same review it notes the repo already has pattern_shape_rules, structureClusters.ts, shapeStrata.ts, and per-pattern coverage tracking. Whether this is a genuinely new entity or a rename/consolidation of what's already there needs a schema read before anyone writes migrations for it, to avoid ending up with two overlapping systems. (M1 shipped pattern_population/pattern_sample — whether this resolves, consolidates, or sidesteps the shape/stratum question is still open; see Implementation progress above.)

No cost or infrastructure budget analysis. 20–400 sampled requests per pattern, times thousands of patterns, times 650 sites, is still potentially millions of outbound requests a month. The review never discusses egress cost, the risk of tripping target-site WAFs at that volume, or a platform-wide request budget on top of the per-host limits.

No observability or audit-trail plan. A system that's going to publish claims like "P0: 13.8M URLs estimated affected" needs monitoring for its own estimator health (alerts when confidence keeps coming back LOW, or sampling never converges) and a way to reconstruct exactly what inputs produced a given historical report. Not addressed.

The GET-fallback escalation isn't bounded. HEAD-first with GET-on-suspicious is the right call, but nothing caps how much of the response body gets fetched for soft-404 detection (should be the first few KB, not the whole page), and nothing caps how much of a pattern's sample is allowed to escalate to GET before the pattern just gets flagged for manual review — otherwise a genuinely bad pattern defeats the "reduce HTTP traffic" goal the HEAD-first design exists for. (M0 verification found this section's body-cap specifics needed correction — see Implementation progress above; check docs/decisions.md for the corrected version.)

Action plan
Phase 0 — Verify before building
Confirm the repo-specific claims above by reading the actual current code (triageSampling.ts, patternPopulationPool.ts, workerRuntime.ts, samplePatternsJob.ts, the Piscina pool setup) rather than taking the ChatGPT review's summary at face value.
Decide whether PopulationProfile is a new entity or a consolidation of pattern_shape_rules / structureClusters / shapeStrata.
If the repository becomes accessible to this Claude session (connected folder or upload), it can do this verification directly and refine the plan below with real file/line references.

Status: complete (M0). See Implementation progress above.

Phase 1 — Harden the sampling and population engine (critical)
Replace the ORDER BY random() sampling path in samplePatternsJob.ts with deterministic sampling — this is a well-known PostgreSQL anti-pattern at scale since it forces a sort/randomize over the whole candidate set.
Implement bounded min-heap-by-hash sampling (fixed size K, one streaming pass, growable later without re-scanning) in place of the ambiguous threshold/reservoir approach the review floated.
Fold sample-candidate collection into the existing SAX streaming pass over the sitemap, so pattern population counts, per-file counts, and sample candidates are all captured in one pass — this removes the current need to rescan the whole population to find a given pattern's URLs.
Add the persistent population index (pattern_id, file_id, population_count, sample-candidate references, timestamps) — after the Phase 0 decision on whether this reuses existing tables.
Implement Wilson score confidence intervals with finite-population correction applied whenever sample size isn't negligible relative to population (e.g., above ~5%).
Wire adaptive sample expansion to the confidence output, using the expansion bounds already present in the code (minimum/maximum sample size, expansion factor, anomaly trigger).

Status: schema/tenancy foundation complete (M1) — the schema, degenerate-interval constraint, and tenant-scoping type guards above are done; the streaming ingestion, sampling algorithm, and confidence-math implementation are M2+. See Implementation progress above.

Phase 2 — Impact scoring and evidence model (high)
Add an Impact Score (population × error probability × severity), starting with a simple static severity table by status-code class; leave a GSC-traffic-factor multiplier as a later hook rather than building it now.
Extend the existing evidence provenance model (sampled / operator / no_change / operator_pattern) with only the additional evidence-source categories that will actually be populated soon — avoid adding enum values that stay permanently empty.
Cap the HEAD→GET escalation: limit GET body fetch size for soft-404 detection, and cap how much of a pattern's sample may escalate to GET before the pattern is flagged for manual review instead of continuing to burn budget.
Phase 3 — Multi-tenant hardening (high — not in the original review)
Partition BullMQ queues / Redis key namespaces per site or site tier so one site's job volume can't starve others.
Add a platform-wide outbound request budget on top of the existing per-host limits, with alerting as it's approached.
Budget Postgres connection pools per worker type so a population-scan spike doesn't starve connections needed by the API or dashboard.

Status: database-level tenant isolation (partitioning by site_id, compile-time query scoping) landed early, in M1, ahead of this phase's original sequencing — the queue/Redis namespacing and connection-pool budgeting pieces of this phase are still pending.

Phase 4 — Historical intelligence and risk modeling (medium)
Start persisting sample outcomes over time per pattern/site now — this is cheap and doesn't require any ML to be useful later.
Once enough history exists, train a simple baseline (logistic regression before XGBoost/LightGBM) to predict pattern risk and set per-pattern sampling budgets, instead of every pattern getting the same default sample size.
Phase 5 — SEO evidence and audit layer (later)
Build targeted page audits on top of the pattern engine, scoped to patterns sampling has flagged as risky — not full crawls.
Add GSC integration as a second intelligence source feeding the Impact Score.
Build the cross-site (650-site) enterprise dashboard last, since it's only as good as everything under it.
Cross-cutting: observability (start in Phase 1, not later)
Dashboards for sampling convergence rate, share of patterns stuck at LOW confidence, GET-escalation rate, and per-site request volume against budget.
A way to reconstruct exactly which inputs produced a given historical report, so a claim like "13.8M URLs estimated affected" is defensible after the fact.
Open decisions needed before Phase 0 sign-off
Is PopulationProfile new, or does it consolidate pattern_shape_rules / structureClusters / shapeStrata? Partially addressed by M1's pattern_population/pattern_sample schema — still need confirmation on whether the shape/stratum granularity was consolidated in, deferred, or dropped. (See Implementation progress above.)
What severity weights should the initial Impact Score use? (Needs SEO/business input, not just an engineering guess.)
What's the acceptable platform-wide HTTP request budget per day/month, and do any of the 650 target sites have contractual or robots.txt crawl-rate constraints that should cap it further?
Should the actual repository be connected to this project so architecture claims can be verified directly against code rather than against a secondhand review?
Does "multi-user" for the AWS deployment mean the internal Asapsemi team (RBAC across roles), or will external clients ever log in? This changes the auth recommendation below and should be settled before Phase 3.
Recommended tech stack

A second ChatGPT conversation proposed the full stack below for local Mac/Windows development first, then AWS deployment for multiple users, with model training on the accumulated data as a later phase. The core of it is correct and endorsed here — it matches the existing codebase, so most rows are "keep what you have," not a new decision. Rows marked with a note below the table have an adjustment worth reading before committing to them as written.

Recommended core stack (2026)
Layer	Technology	Why this choice	Local (Mac/Windows)	AWS
Frontend	Next.js 15/16 (App Router) + TypeScript	Excellent for dashboards, SSR/SSG, Server Actions, React ecosystem	npm run dev	ECS Fargate (see note 1)
UI	shadcn/ui + Tailwind CSS + Recharts/Tremor	Fast, clean, professional enterprise look	Perfect	Perfect
Backend API	Fastify 5 + TypeScript	Extremely fast, low overhead, great plugin ecosystem, schema validation	Runs natively	ECS Fargate / EC2 / EKS
Job Queue	BullMQ + Redis	Best-in-class for Node: priorities, rate limiting, delayed jobs, retries	Redis via Docker (see note 2)	ElastiCache (Redis)
Database	PostgreSQL 16	Strong for relational data, JSONB, window functions, statistical queries	Docker or local Postgres (Postgres.app / Homebrew / Windows installer)	Amazon RDS PostgreSQL (see note 3)
ORM / query layer	Prisma or Drizzle	See note 4 — not actually interchangeable for this workload	Both work	Both work
CPU-heavy work	Piscina (worker threads pool)	Ideal for SAX parsing, hash calculations, confidence-interval math, pattern processing	Native	Native (worker containers)
Sitemap parsing	sax or saxes (streaming) + custom pattern extraction	Memory-efficient for huge sitemaps	Native	Native
HTTP client / crawler	undici + optional Playwright (deep audits only)	Fast, modern; keep Playwright out of the main sampling path	Native	Native
Object storage	AWS SDK v3 (S3)	Already in the architecture for S3/SFTP deploy	Real S3 dev bucket (see note 5)	S3
Auth	NextAuth.js / Auth.js or Clerk	See note 6 — depends on an unanswered question	Easy	Easy
Observability	OpenTelemetry + Prometheus + Grafana (or AWS X-Ray + CloudWatch)	Critical for sampling convergence, request budgets, estimator health	See note 7 — defer for now	CloudWatch + Managed Grafana or AMP
ML training (added — not in the original proposal)	Separate Python service (FastAPI + scikit-learn/XGBoost/LightGBM) reading from the same Postgres	See note 8 — needed for the Phase 4 risk model, without rewriting the platform	Runs as its own local process/container	Its own small ECS service or scheduled job
Notes on the table (adjustments to the original proposal)
Frontend on AWS — the original proposal also lists Amplify Hosting or EKS or Vercel-then-AWS as options. ECS Fargate is the one to plan around here, since API and workers are already going to ECS — keeping the frontend on the same platform avoids running a second deployment system for no real benefit at this stage.
Redis locally — the original proposal says "Redis via Docker or local Redis." On Windows there's no supported native Redis build, so Docker is not optional there; only macOS can realistically run it natively (via Homebrew). Use Docker Compose for both platforms so Mac and Windows environments stay identical.
Database on AWS — the original proposal suggests Aurora Serverless v2 "if traffic is spiky." This workload's traffic (bursty population scans and sampling jobs) is spiky in exactly the way that makes ACU-based billing unpredictable before there's usage history to size it against. Start with a provisioned RDS instance sized from real local/staging load, add a read replica once dashboard read load justifies it, and revisit Aurora once there's billing data to compare. Partition the large per-URL and per-pattern tables by site_id from the start — cheap now, expensive to retrofit after 650 sites have data in an unpartitioned table.
ORM/query layer — Prisma and Drizzle are not interchangeable here. The sampling engine needs hash-based filtering, window functions, and CTEs close to raw SQL (Phase 1 above is largely about getting away from ORM-shaped queries like ORDER BY random()), and Prisma's query engine gets awkward exactly in that territory. Use Drizzle (or Kysely, a thinner type-safe SQL builder with no migration opinions of its own) for the packages/sampling and packages/sitemap query paths; Prisma is still fine for simpler CRUD — dashboard/admin, user and site management — if the team prefers it there. No need to standardize on one ORM for the whole codebase.
Local S3 testing — the original proposal suggests LocalStack for local S3 simulation. Since S3/SFTP deploy correctness is an active feature (feature/aws-s3-sftp-deploy), testing against LocalStack's emulation risks masking real-service behavior differences (auth edge cases, multipart upload thresholds, eventual consistency quirks) that only show up against actual S3. A dedicated low-traffic dev bucket costs close to nothing at this scale and removes that risk.
Auth — this depends on an open question (also listed above): does "multiuser" mean the internal Asapsemi team (RBAC across roles: admin/analyst/viewer), or will external clients ever log in? If internal, Auth.js (free, self-hosted, full control of the RBAC/org model) is the better fit than Clerk, whose per-user pricing and managed-org model are built for customer-facing SaaS. If external client logins are actually on the roadmap, Clerk's managed org support earns its cost. Settle this before Phase 3 (multi-tenant hardening) rather than defaulting to whichever library is easiest to wire up first.
Observability — the full OpenTelemetry + Prometheus + Grafana stack is right for the AWS multi-user phase, but standing it up for solo local development is overhead without payoff. For the PC-first phase, structured JSON logging plus the sampling-health tables already called for above (convergence rate, confidence distribution, escalation rate) is enough to build against. Add the full stack when deploying to AWS for multiple users, not before.
ML training — the original proposal only says to avoid Python for the main workers (correct — Node stays right for the streaming/sampling core), but doesn't address the model-training work that's actually planned (Phase 4 above). The right shape is a hybrid: keep the whole platform in Node/TypeScript as proposed, and add one small, separate Python service — a FastAPI app, or even just scheduled training scripts — that reads features from the same PostgreSQL database (the historical sample-outcome data Phase 4 starts collecting immediately) and either writes predictions back to Postgres on a schedule or serves a small internal /predict endpoint the Fastify backend calls when computing per-pattern sampling budgets. scikit-learn/XGBoost/LightGBM are the natural choices, matching Phase 4. This keeps the core platform's language unchanged while giving the ML work proper tooling — training in Node, or rewriting the platform in Python for the model's sake, are both the wrong trade.
Local development setup (Mac + Windows)

Use Docker Compose so Mac and Windows developers get identical environments:

yaml
# docker-compose.yml (simplified)
services:
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_PASSWORD: password
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  # Use a real low-traffic S3 dev bucket instead of LocalStack (note 5 above)

Run Next.js, Fastify, and the workers directly on the host (Node 22 LTS). Use concurrently or a simple package.json script to start the API, workers, and frontend together. Piscina works natively on both Apple Silicon and Windows. For large sitemap testing, mount a local folder or point at the real S3 dev bucket. This gets to zero-friction local development on day one.

Note (found during M0 on a Windows dev machine): a natively-installed Postgres can hold the default 5432 port and shadow the Docker container, causing connections to silently reach the wrong server. Make the compose file's host ports overridable (POSTGRES_PORT/REDIS_PORT env vars, defaults unchanged) so a machine with a port conflict can set a local override (e.g. 5433) in its own .env without changing the shared defaults.

AWS deployment architecture

Start simple and scale later.

Phase 1 — MVP / early production:

Frontend, API, and workers: ECS Fargate (separate task definitions for the API and worker services; see note 1 on keeping the frontend here too rather than Amplify).
Database: Amazon RDS PostgreSQL, provisioned (not Aurora Serverless v2 — see note 3).
Redis: Amazon ElastiCache.
Storage: S3.
Load balancer: Application Load Balancer.
Secrets: AWS Secrets Manager.
CI/CD: GitHub Actions → ECR → ECS.

Later, once there's an actual scaling problem (100+ sites or heavy load):

Stay on ECS + Auto Scaling Groups if it keeps meeting needs — it's simpler and cheaper than Kubernetes for most teams; only move to EKS if finer control over worker-pool autoscaling becomes a real requirement, not a hypothetical one.
AWS Batch or Spot instances for very large one-off population scans.
SQS in front of specific job types only if a concrete durability gap in BullMQ shows up in practice — don't add it pre-emptively.
Why this stack fits

This matches the current direction — Next.js, Fastify, BullMQ, Redis, PostgreSQL, Piscina, and SAX streaming are already in place, so this is hardening, not a rewrite. It's local-first: everything runs on Mac and Windows with Docker Compose, no cloud required for development. Every component has a first-class managed AWS service, so the path to production doesn't require re-architecting. Fastify + BullMQ + Piscina + streaming SAX is a genuinely high-throughput combination for this specific workload. It's multi-tenancy ready — PostgreSQL (partitioned by site_id, with row-level security or schema-per-tenant as a later option) plus BullMQ queue isolation and Redis key namespacing (see Phase 3 above) covers the 650-site end state. And it's cost-controlled: ECS Fargate + provisioned RDS starts cheap, and only the worker fleet needs to scale as load grows.

What to avoid

NestJS is too heavy and opinionated for this shape of workload. Don't put the main workers on serverless (Lambda) — long-running sitemap processing and Piscina worker pools are a bad fit for Lambda's execution model. MongoDB isn't the right choice here — the workload leans on relational and statistical queries (window functions, CTEs) that Postgres is built for. Don't replace BullMQ — it remains the strongest Node queue for this. And don't treat "avoid Python" as blocking the ML roadmap — the fix is a separate small Python service (note 8), not avoiding Python everywhere or rewriting the platform in it.

Suggested project structure
/
├── apps/
│   ├── web/                 # Next.js frontend
│   ├── api/                 # Fastify API
│   └── worker/              # BullMQ workers + Piscina
├── packages/
│   ├── database/            # Prisma and/or Drizzle schema
│   ├── sampling/             # Bounded min-heap, Wilson interval, finite-population correction
│   ├── sitemap/              # SAX streaming parser + pattern extraction
│   ├── shared/                # Types, utils, constants
│   └── ml-client/             # Client for the Python training/inference service (note 8)
├── ml-service/                # Separate Python service: training + /predict endpoint
├── docker-compose.yml
└── infrastructure/            # Terraform or CDK for AWS

Use pnpm workspaces + Turborepo to manage this monorepo layout — the original proposal implies a monorepo but doesn't name the tooling; pnpm + Turborepo is the standard choice here, works identically on Mac and Windows, and keeps packages/sampling, packages/sitemap, and packages/ml-client properly isolated with fast incremental builds.

Frontend design tooling (in the coding assistant, not the product itself)

This is about what to plug into whatever coding assistant builds the Next.js frontend (Claude Code or similar) — not something the shipped product depends on. These tools solve two different problems — design taste (does the output look considered rather than generic) versus components (what gets installed into the codebase) — and it's worth keeping the two separate rather than picking one tool to do both.

Taste layer — pick one, don't run two at once, and Impeccable is the better fit here:

Impeccable (pbakaus/impeccable, open source) is the stronger choice for this specific project. Unlike a single automatic skill, it's a full design-vocabulary framework: one /impeccable skill with roughly 23 commands (init, shape, critique, polish, audit, typeset, colorize, animate, and more), backed by around 60 deterministic anti-pattern detectors (overused fonts, purple gradients, bounce easing, cards-in-cards, low-contrast gray text) and documented design decisions (PRODUCT.md/DESIGN.md) that keep a large surface area — a dashboard spanning 650 sites' worth of pattern health, confidence intervals, and impact scores — visually consistent as different people or sessions build different screens. Critically, its setup explicitly distinguishes "brand surfaces" (marketing/landing pages) from "product surfaces" (dashboards/tools/apps) and calibrates its checks accordingly — which is exactly the gap in Anthropic's own skill (next item). Install via npx impeccable install (auto-detects the Claude Code folder) or the plugin marketplace.
frontend-design (Anthropic's official Claude Code plugin) is a lighter, single automatic skill aimed at the same problem — steering away from generic "AI slop" (Inter font, purple gradients, rounded-corner three-box grids). It's worth knowing about, but it leans maximalist/bold by default with no equivalent "this is a dashboard, not a landing page" mode, so it needs to be explicitly and repeatedly steered toward a clean, information-dense enterprise style for this project. Given Impeccable already handles that distinction natively, install Impeccable instead of this one for the dashboard — there's little reason to run both, since two taste-layer skills active at once can give the coding assistant conflicting instructions.

Component layer — shadcn/ui MCP, not Magic UI, for this project:

shadcn/ui MCP (official, from ui.shadcn.com) is the one to install, because shadcn/ui is already the chosen component library in the stack above. It lets the coding assistant browse, search, and install real shadcn components and blocks — including shadcn's own dashboard blocks — directly into the codebase via natural language, and supports a private company registry later if a shared internal design system gets built. Install with pnpm dlx shadcn@latest mcp init --client claude, or configure manually via .mcp.json.
Magic UI MCP (magicuidesign/mcp, from magicui.design) adds animated marketing-style components — marquees, particle/grid backgrounds, animated beams — on top of shadcn/ui and Tailwind. Good for a public-facing landing or marketing page for the product, but a poor fit for this dashboard: those effects fight readability in a dense interface built around tables, health scores, and status badges. Superseded by docs/DESIGN.md, which names three specific, narrow uses for Magic UI in the actual product surface — see that document, which is more specific than this note and wins.
Note the name collision: "21st.dev Magic MCP" (21st-dev/magic-mcp) is a different, unrelated project — an AI-driven UI generator pulling from 10,000+ components across many different design systems, closer to a v0-style generator than a scoped component installer. Mixing it in alongside shadcn MCP risks visual inconsistency, since it isn't scoped to one design system. Not recommended here.

Recommended combination for this project: Impeccable (taste layer, set up as a "product surface"/dashboard from its init step, pointed at docs/DESIGN.md) + shadcn/ui MCP (components, including its dashboard blocks) + Tremor/Recharts for charts (already in the stack above). Skip frontend-design and 21st.dev Magic MCP for the core dashboard; Magic UI is used narrowly per docs/DESIGN.md §8, not generally.

Final recommendation

Stick with and harden the current direction: Next.js 15/16 + Fastify 5 + BullMQ + Redis + PostgreSQL 16 + Piscina + TypeScript for the platform, plus one small separate Python service for model training and inference once Phase 4 has enough historical data to train on. For the coding assistant building the frontend, pair Impeccable (design taste, set up for a product/dashboard surface) with the shadcn/ui MCP (components). This is the strongest combination for a pattern-aware, sampling-based SEO platform that needs to run locally today, look genuinely professional rather than templated, and scale to AWS with multiple users and, later, ML-driven sampling.