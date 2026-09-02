Pattern-Aware SEO Platform — Agent Guide

This file is read automatically by Claude Code (and should be treated as load-bearing by any other coding agent working in this repo). It tells you what this project is, what's already been decided, and what rules to follow so the codebase stays consistent instead of accumulating whatever style each session or contributor happens to reach for.

Read before making non-trivial changes
docs/architecture-review-and-action-plan.md — the why: the product direction, the phased build order (Phase 0 through 5), and a list of open decisions that haven't been made yet. Don't build ahead of the current phase without checking this. As of M5, this doc has amendment sections for Phase 0 (M0), Phase 1/3 (M1), Phase 1's streaming/pattern-extraction pieces (M2), Phase 1's confidence-math completion (M3), a post-M3 hardening pass, Phase 2's Impact Score (M4, plus a merge-time correction), and Phase 2's HTTP verification client (M5) — read to the end, not just the original text.
docs/CODING_STANDARDS.md — the how: full TypeScript/Node.js and PostgreSQL conventions. This file only summarizes the parts an agent is most likely to violate by default. Check there before assuming the general rule applies unmodified — it has accumulated several documented exceptions/gotchas by now (partitioned-table primary keys, the lint-tooling split, the legacy-algorithm-replacement precedent, sampling-hash-as-uniqueness-key, node-postgres numeric coercion).
docs/DESIGN.md — the UI spec: visual identity, tokens, component rules. Binding for anything touching apps/web.
docs/decisions.md — ADR log. Check here before re-litigating something already decided during implementation (tooling choices, version pins, schema exceptions, algorithm replacements, etc.) — as of M5 this includes at least ADR-0008, ADR-0010, ADR-0012, ADR-0013, ADR-0014 (Impact Score severity weights), and ADR-0016 (deferred host-strategy negotiation; the cost of deferring it is stated explicitly in the ADR, not just implied).

If a task touches something listed under "Open decisions" in the action plan (e.g. whether PopulationProfile duplicates existing tables, or the internal-vs-external auth question), stop and surface the decision instead of guessing. That discipline has now paid off twice — the Impact Score's severity weights (ADR-0014) and the decision to defer host-strategy negotiation as its own milestone rather than half-build it inside M5 (ADR-0016) were both surfaced rather than guessed.

Document precedence when two docs conflict

These docs were written at different times for different purposes, so a conflict between them is expected occasionally, not a sign something's broken. Resolve it in this order:

docs/decisions.md (ADRs) — the most recent, most specific, ground-truth record of what was actually implemented and why.
docs/DESIGN.md — wins over the architecture/tech-stack doc for anything about UI presentation, motion, or the frontend design-tooling recommendation.
docs/architecture-review-and-action-plan.md — the overall product/data-model/infra direction.
docs/CODING_STANDARDS.md — general code conventions; expect this one to accumulate documented exceptions as real tooling, schema, and algorithm decisions get made rather than being rewritten each time.

When a conflict surfaces, add an ADR recording which side won and why — don't just silently pick one.

What this is

A pattern-aware, sampling-based SEO intelligence platform. It does not crawl every URL on a site. It collapses a sitemap's URLs into a much smaller set of patterns, samples each pattern statistically (with proper confidence intervals, not guesses), and verifies health with targeted HTTP checks — the entire point is auditing a 90M-URL site without making 90M requests. Any change that reintroduces "just crawl everything" thinking is working against the product's actual differentiator.

The core entity model (landed in M1) is organization → site → sitemap_run → sitemap_file → pattern → pattern_population / pattern_sample → sample_observation, plus audit_snapshot and sampling_health. site exists independently of any one audit run. Don't reintroduce a run-rooted model even locally in new code. A compile-time query guard and a schema-level FK guard are two separate proofs of tenant isolation — see the Non-negotiable rules below; the schema-level one had a real gap, found and fixed post-M3 (migration 0002).

As of M2, single-pass streaming ingestion is real and benchmarked (10,000,000 URLs, 681 MB peak RSS against a 1,536 MB budget, ~41,600 URLs/s, byte-identical resume). Pattern extraction does not faithfully port the legacy algorithm — see ADR-0012.

As of M3, the confidence-math layer is real: Wilson score intervals with finite-population correction, and adaptive sample expansion wired to the min-heap's expansion bounds (ADR-0013).

As of M4, the Impact Score (severityFor, ADR-0014) is real, with no default severity table in code. A merge-time correction: the GSC-traffic-factor hook, documented as arriving "as one multiplication," could not actually have been used as documented — a multiplier above 1 could push impact_score past the estimate it weights, violating audit_snapshot's ck_audit_snapshot_impact_sane CHECK constraint. Neither the hook nor the constraint showed this in isolation, only their interaction. Bounded to (0, 1] before merge — traffic can only de-weight an impact score, never amplify it. Keep this in mind for any future scoring multiplier: check it against ck_audit_snapshot_impact_sane, don't just check it in isolation.

As of M5, the HTTP verification client's core policy is real: HEAD-first with GET-on-suspicious, the escalation cap from M4 wired in for real against the planned sample size (not a naive per-check counter — see Non-negotiable rules below), and rate limiting charged per request. Host-strategy negotiation (distinguishing "this host blocks everyone" from "this host blocks this specific request profile") is deliberately deferred — see ADR-0016 and the Milestone log below — not yet decided whether it's the immediate next milestone or comes after pipeline orchestration.

Repo layout
apps/
  web/       Next.js frontend (dashboard) — still just the M0 scaffold; no real dashboard screens yet
             (deliberately last, per Phase 5 — see the action plan)
  api/       Fastify API
  worker/    BullMQ workers + Piscina pools
packages/
  database/   Schema shared by api + worker. Compile-time tenant-scoped query guard (opaque `Database`
              type, single entry point, `compile-guards.test.ts`) plus a schema-level FK guard — every
              table referencing a tenant-scoped parent constrains `(site_id, parent_id)` as a pair, not
              the parent id alone (migration `0002`, `isolation.test.ts`). `sample_observation` is unique
              on the URL, not `url_hash` — see the Non-negotiable rules below before adding a new
              uniqueness constraint on a hash column. `audit_snapshot` has a `ck_audit_snapshot_impact_sane`
              CHECK — any new scoring multiplier must be checked against it, not just against its own logic.
  sampling/   Bounded min-heap-by-hash sampling (M2), Wilson score confidence intervals + finite-population
              correction + adaptive sample expansion (M3, ADR-0013), the Impact Score / `severityFor` and
              the bounded GSC-traffic multiplier (M4, ADR-0014).
  http/       HTTP verification client (landed M5, PR #8, 55 mocked tests — deliberately mocked, not run
              against real servers, since a suite that probes real servers is exactly the behavior the
              limiter and breaker exist to prevent). HEAD-first, GET-on-suspicious, escalation cap charged
              against the planned sample size, rate limit charged per request (not per logical check — see
              Non-negotiable rules). Host-strategy negotiation is NOT implemented here yet — deferred per
              ADR-0016; a host currently reported "blocked" may only be blocking one request profile, not
              all of them. The profile ladder is owned by the caller, not this package, by design.
  sitemap/    Streaming SAX parser + pattern extraction (prefix trie, ADR-0012). Large adversarial
              synthetic corpus test (10M-URL scale) required alongside unit tests — see
              `docs/CODING_STANDARDS.md` §1.10.
  shared/     Shared types, utils, constants (zod-validated startup config, logger, domain error hierarchy)
  ml-client/  Client for the ml-service prediction endpoint
ml-service/   Separate Python service (model training + /predict) — see rule below
infrastructure/  Terraform/CDK for AWS
docs/         Architecture plan, coding standards, design spec, ADR log
Commands
bash
docker compose up -d        # Postgres 16 + Redis (ports overridable via POSTGRES_PORT/REDIS_PORT)
pnpm install
pnpm dev                    # runs web + api + worker together (from repo root)
pnpm --filter <app> dev     # run just one app, e.g. pnpm --filter worker dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test

Run pnpm dev from the repo root, not from inside an app folder. cp .env.example .env && pnpm dev is verified working as of the post-M3 hardening pass — check .env.example still passes its own env validation if a fresh clone breaks on step one.

Non-negotiable project rules

These come out of a specific architecture review and its critique (see the action plan doc for the full reasoning) — they are not arbitrary preferences, and deviating from them reintroduces problems that were already identified and fixed once.

No ORDER BY random() for sampling, ever, on tables that can grow large. Use the bounded min-heap-by-hash approach in packages/sampling — implemented and benchmarked at 10M-URL scale as of M2.
Confidence math must use the Wilson score interval with finite-population correction, not a naive normal approximation. Implemented in M3 (ADR-0013) — Wilson interval, FPC, adaptive expansion, two-threshold-pair confidence-band classification, epsilon-clamped at p̂ = 1. Don't recompute it ad hoc elsewhere.
Impact scoring: severityFor has no baked-in default severity table — a missing table throws (ADR-0014, ratified by the project owner). A refusal (HTTP 403) can never carry a nonzero impact score, enforced at the database level. Volume can outweigh severity class in the score (50,000 redirect chains outrank 200 gone pages) — deliberate, pinned by a test. Any scoring multiplier (e.g. the GSC-traffic-factor hook) must be range-checked against ck_audit_snapshot_impact_sane, not just validated in isolation — the M4 merge-time bug was exactly a hook and a constraint that were each individually fine but broke on interaction. The traffic multiplier is bounded to (0, 1]: traffic can de-weight an impact score, never amplify it.
HTTP verification is HEAD-first, GET only on suspicious results, GET body fetches size-capped. Implemented for real in M5 (packages/http): the escalation cap is a budget charged against the planned sample size, not a ratio against work already done (a ratio trips on the first probe) and not a naive per-check counter — 20% of a 30-URL plan means 30 HEADs plus 6 sniffs, not 60 total requests, because a single "check" that escalates costs two real requests (a HEAD plus a GET sniff), and the cap has to account for that or it silently permits double the intended request volume. Rate limiting is charged per request, not per logical check — this was a real, measured defect in the legacy engine: it metered per check and actually sustained ~49.17 req/s against a nominal 25 req/s ceiling, because it undercounted every escalated check as one unit of load instead of two. Don't reintroduce per-check metering anywhere a HEAD→GET escalation can occur.
Host-strategy negotiation is deliberately not yet built (ADR-0016) — a host that would respond fine to a browser-profile request is currently reported as simply "blocked," with no way to distinguish "refuses everyone" from "refuses this specific request profile." Don't paper over this by guessing at a workaround inside packages/http — the real fix needs a host-profile table, a rung ladder of profiles to try, and a Redis-backed hot copy for request-time lookups, which ADR-0016 scopes as its own milestone, not a corner of M5. The request-profile ladder itself is owned by the caller of packages/http, not the package — that's what let M5 defer host negotiation cleanly instead of half-building it.
Never materialize a full URL population in memory or in a single query result. M2's benchmark (681 MB peak RSS for 10M URLs) is direct evidence this is holding in practice.
A run that completes without throwing is not necessarily a run that succeeded. Any code path that can "succeed" with an empty or suspicious result must signal that explicitly (structured warn log at minimum). Instances found so far: an HTML error page parsing as valid, URL-less XML (M2); a CLI silently no-opping on bad input, a finalize() claiming false idempotency (post-M3); an empty sampling plan returning flag_for_review instead of recognizing there's nothing to review (M4) — same defect class each time, not a new one; check for it by default in new code.
Multi-tenant isolation has two layers, and each needs its own proof. Compile-time query guard (compile-guards.test.ts) plus schema-level FK pairing ((site_id, parent_id), isolation.test.ts) — see "What this is" above. BullMQ queue/Redis namespacing and connection-pool budgeting are still pending, not yet built.
Query layer split: Drizzle or Kysely (not Prisma) for packages/sampling, packages/sitemap, packages/http. Drizzle Kit is the migration source of truth but can't generate PARTITION BY DDL (hand-completed, three guards — see docs/CODING_STANDARDS.md §2.4) and has shown constraint-ordering bugs on ordinary migrations too (migration 0002 needed hand-reordering). Never run drizzle-kit push against this schema.
Never make a uniqueness constraint out of a hash chosen for its sampling distribution properties. Fixed in M2 (migration 0001) for sample_observation — see docs/CODING_STANDARDS.md §2.2.
"Port the legacy algorithm" does not mean reproduce a proven defect, but legacy is also where real operational lessons come from — the per-check-vs-per-request rate-limiting defect above was found by studying legacy's actual measured behavior, not guessed. Replace a legacy defect only when a large adversarial test (not a hand fixture) demonstrates it, validate the replacement against the same corpus, and record an ADR (ADR-0012 is the model).
ML work lives in ml-service/ (Python), never inlined into the Node platform.
Don't reach for: NestJS, Lambda for the main workers, MongoDB, SQS in front of BullMQ, or EKS.
Don't add a new PopulationProfile-style entity without first checking whether pattern_shape_rules, structureClusters, or shapeStrata already cover it — still an open decision as of M5.
Don't guess severity weights, escalation policy numbers, or any other business-facing constant. Surface it instead — see ADR-0014 and ADR-0016 for the pattern to follow.
Don't half-build a deferred scope inside an unrelated milestone. Host-strategy negotiation could have been bolted onto M5 as a partial workaround; instead it was named, costed, and deferred as ADR-0016. Prefer naming a real gap over quietly working around it.
Coding standards (see docs/CODING_STANDARDS.md for full detail)

The essentials an agent must not violate by default:

TypeScript strict mode everywhere; no any — use unknown and narrow it.
Named exports only; no default exports. ESM only, no require().
All async code uses async/await; no unhandled/floating promises.
Structured logging (pino) — no stray console.log in application code.
Every table/column/index snake_case; every FK <singular_table>_id; every table has created_at/updated_at. Partitioned tables use composite PK (site_id, id) (ADR-0010). Any FK to a tenant-scoped table constrains (site_id, parent_id) as a pair (migration 0002).
All SQL parameterized, never string-concatenated.
Every non-trivial exported function gets a short TSDoc comment on why.
Env vars validated once at startup via zod, fail-fast, all errors reported together. Keep .env.example itself passing that validation.
Statistical and business invariants that must never silently hold a wrong value get a database CHECK constraint, not just an application assertion — ck_audit_snapshot_impact_sane is the model; check any new scoring path against existing CHECKs, not just its own logic, before merging.
Tree/trie/streaming-aggregation code needs a large adversarial synthetic corpus test, not just small fixtures (docs/CODING_STANDARDS.md §1.10).
Never put a uniqueness constraint on a hash column chosen for sampling/bucketing distribution.
Statistical code validated against reference values should check those values against an external, published source, not just re-derive them from the same reasoning as the implementation.
Don't trust a driver's declared return type over its actual runtime behavior for numeric aggregates — sum(...)::bigint comes back as a JS string from node-postgres, not a number. Cast/parse explicitly at the query boundary.
Code that talks to real external hosts (packages/http) gets a fully mocked test suite by default — a test suite that actually hits real servers reproduces exactly the load behavior the rate limiter and circuit breaker exist to prevent. Mock at the transport boundary, not by stubbing out the logic being tested.
When adding a rate limit or budget over something that can escalate into more than one real unit of work (e.g. a HEAD that escalates to a GET), charge the budget/limit per actual unit of work performed, never per logical "check" — undercounting escalated work was a real, measured defect in the legacy engine (see Non-negotiable rules above).
Workflow expectations
Check which Phase (0–5) a task belongs to in the action plan before starting.
When a change touches an open decision, say so explicitly rather than picking an answer silently.
Update docs/architecture-review-and-action-plan.md and record ADRs in docs/decisions.md when a real decision gets made — prefer dated amendments over rewriting original text.
Never commit .env, credentials, or AWS/SFTP keys.
New logic in packages/sampling, packages/http (confidence math, sampling, HTTP policy, scoring) needs tests — this is the part of the system a wrong-but-plausible answer is most costly and hardest to eyeball-review. Same standard for tenant-isolation tests (compile-guards.test.ts, isolation.test.ts).
Before merging a schema migration, confirm it doesn't fight a native/local install shadowing a Docker service on the same default port.
Before replacing a ported algorithm, validate the replacement against the same corpus and write the ADR.
Before merging any PR, confirm the actual GitHub Actions run went green by reading the job logs for anything touching a service container, not just the badge — and confirm the workflow actually triggers on the branch you think it does (the post-M3 pass found develop had no push trigger at all for a while). Also confirm Copilot Code Review (or whatever automated review is configured) actually ran — as of M4/M5, Copilot silently stopped auto-running after PR #4, and an explicit reviewer request didn't take either. Don't assume "no findings" means "clean" if the tool never actually ran; check for its output explicitly, and if it's silent, either fix it or do the equivalent manual pass yourself and say so (as M4's merge did) rather than silently treating an unreviewed diff as reviewed.
When two features are each individually correct but interact badly (the M4 GSC-multiplier/CHECK-constraint case), the way to catch it is to test the interaction directly — probe the actual combination with real numbers, don't just unit-test each side in isolation.
Git conventions
Conventional Commits: feat:, fix:, chore:, docs:, refactor:, test:, perf:.
Branch names: feat/<short-description>, fix/<short-description>, or phase-<n>/<short-description> (or phase-<n>/m<milestone>-<short-description>). Each milestone branches off the tip of the previous one, PRs stack the same way, merge bottom-up into develop. A cross-cutting fix touching multiple already-merged milestones can go directly against develop as one consolidated PR instead of threading through the original stack.
Don't push directly to main. develop is the integration branch; main is promoted via its own develop → main PR once develop holds a verified set of milestones — this is a deliberate, separate call each time, not automatic. main was promoted for the first time on 2026-09-02 (PR #7, merge commit 5b6ff28) — it now carries M0–M3 plus the post-M3 hardening pass, verified with its own fresh pull_request CI run (16 steps, job logs read to confirm constraints.test.ts/isolation.test.ts/schema.test.ts actually ran against real Postgres, not just the badge). main does NOT yet have M4 or M5 — those are merged into develop (79930e8 for M4) and open as PR #8 (M5) respectively; another develop → main cycle is needed to promote them, and when to run it is an open call (see Open decisions in the architecture doc).
Keep an unrelated large-diff change in its own commit/PR, separate from feature work.
Open PRs and confirm CI actually runs green in GitHub's environment — reading job logs for service-container-touching tests, and confirming the workflow triggers on the branch you expect (see the develop push-trigger gap found post-M3). Copilot Code Review coverage gap, found at M4: it auto-ran on PRs #1–#4 but not #5, #6, or #7, and an explicit reviewer request on a later PR didn't take either — cause not yet diagnosed. Given it found 9 real issues out of 9 flagged in the one pass it did run, this is worth fixing rather than shrugging off; until it's confirmed working again, treat "Copilot has no comments" on a PR as "Copilot may not have run," not as a clean bill of health, and do a manual pass for the same defect classes it's caught before (interaction bugs between individually-correct features, doc/behavior mismatches, silent-success-on-bad-input) as M4's merge did.
Milestone log
M0 (Phase 0 foundation) — complete. Tooling/enforcement, real workspace packages, packages/shared, initial apps/web scaffold, docs/decisions.md established.
M1 (Phase 1 schema/tenancy foundation) — complete; one correction found post-M3. Core entity model, degenerate-interval CHECK constraint, compile-time tenant isolation (compile-guards.test.ts), composite (site_id, id) PKs (ADR-0010). Correction (post-M3, migration 0002): schema-level cross-tenant FK gap closed — see Non-negotiable rules above.
M2 (Phase 1 streaming ingestion + pattern extraction) — complete. 10M-URL corpus benchmark (681 MB peak RSS, ~41,600 URLs/s, byte-identical resume). Legacy pattern-extraction defect found and replaced (ADR-0012). Sampling-hash uniqueness-constraint bug found and fixed (migration 0001).
M3 (Phase 1 confidence math) — complete. Wilson score intervals, FPC, adaptive expansion (ADR-0013). Epsilon-clamp fix, two hand-computed reference corrections, two-threshold-pair confidence-band classification.
Post-M3 hardening pass (PR #5) — complete, 2026-09-02. Nine Copilot findings, all real: the M1 cross-tenant FK gap (the significant one), a broken .env.example (AUTH_SECRET=""), a node-postgres numeric-coercion bug, and six smaller defects. Also found and fixed: develop had no push-trigger CI run at all. PRs #1–#5 merged bottom-up into develop (b5a5998).
main promoted — complete, 2026-09-02 (PR #7, merge 5b6ff28). First promotion since the original scaffold; main now carries M0–M3 plus the hardening pass. Own pull_request CI run, 16 steps green, job logs read directly to confirm the Postgres-backed test suites actually executed. main does not yet have M4 or M5.
M4 (Phase 2 opening — Impact Score) — complete, merged as 79930e8. severityFor with no default severity table (ADR-0014, ratified by the project owner: 410/404-first ranking). A refusal (403) can never carry impact, enforced at the database level. Volume can outweigh severity class in the score, deliberately, pinned by a test. Copilot did not review this PR (auto-run stopped after PR #4, cause undiagnosed) — a manual pass for the same defect classes found: the GSC-traffic-factor hook could push impact_score past ck_audit_snapshot_impact_sane's bound in combination with a large-enough multiplier, even though the hook and the constraint were each individually correct — bounded to (0, 1] before merge, so the multiplier can only de-weight, never amplify; an empty sampling plan returning flag_for_review instead of recognizing there was nothing to review; and two smaller doc/behavior mismatches. Fresh push-triggered CI run on develop confirmed green post-merge.
M5 (Phase 2 — HTTP verification client) — open as PR #8, CI green, not yet merged. 55 tests, all mocked at the transport boundary — deliberate, since a suite hitting real servers would reproduce the exact load the rate limiter/breaker exist to prevent. Delivered: HEAD-first/GET-on-suspicious verification; the M4 escalation-cap policy wired in for real, charged against the planned sample size and correctly accounting for escalated checks costing two requests (HEAD + GET sniff), not one — 20% of a 30-URL plan is 30 HEADs plus 6 sniffs, not 60 total; rate limiting charged per actual request, not per logical check — fixing a real, measured legacy defect (legacy sustained ~49.17 req/s against a nominal 25 req/s ceiling by undercounting escalated checks). The request-profile ladder is owned by the caller of packages/http, not the package itself, which is what let host-strategy negotiation be cleanly deferred rather than half-built: a host that would respond to a browser profile is currently just reported "blocked," with no way to distinguish "refuses everyone" from "refuses this profile." Recorded as ADR-0016, with the cost of deferring (needs a host-profile table, a rung ladder, and a Redis-backed hot copy — a milestone, not a corner of this one) stated explicitly rather than left implicit. Two open calls before/around merging this: (1) whether the host-strategy-negotiation milestone comes immediately next or waits behind pipeline orchestration work, and (2) whether/how to get Copilot Code Review running again given its 9-for-9 hit rate on the one pass it completed. Both flagged for the project owner, not decided unilaterally.