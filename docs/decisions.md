# Architecture Decision Records

One entry per real decision, newest appended at the bottom. Each records the
context, the decision, and what it costs — so a future reader can tell a
deliberate trade-off from an accident, and knows what would have to change to
revisit it.

Supersede rather than edit: if a decision changes, add a new ADR marking the old
one `Superseded by ADR-XXXX` and leave the original text intact. The reasoning
that turned out to be wrong is the most useful part of the record.

Related documents: `architecture-review-and-action-plan.md` (product direction
and phasing), `CODING_STANDARDS.md` (conventions), `../CLAUDE.md` (the rules an
agent must follow).

---

## ADR-0001 — Stratified confidence intervals from per-stratum Wilson bounds

**Status:** Accepted (implemented in M3)

**Context.** The architecture review asked for the Wilson score interval with
finite-population correction, in place of a naive normal approximation. Reading
the legacy code showed the situation was more specific than the review
described. `estimateFromObservations` in
`../Sitemap_Migration/backend/src/jobs/triageSampling.ts` already computes a
stratified estimate `Σ N_h · p̂_h`, and already applies the finite-population
correction `(1 − n_h/N_h)` per stratum. What it uses for the interval is a single
normal half-width, `1.96 · √variance`, and that degenerates exactly where it
matters: with zero observed hits, `p̂(1 − p̂) = 0`, so the variance is zero, the
half-width is zero, and the interval collapses to `[0, 0]`. The system reports
certainty that there are no errors on the basis of a 1% sample.

Wilson, however, is defined for a *single* binomial proportion. It is not a
drop-in replacement for a stratified total, so "use Wilson" does not by itself
specify an implementation.

**Decision.** Two layers.

1. Per stratum, compute the Wilson score interval on `p̂_h = hits_h / n_h`, then
   shrink each bound's distance from `p̂_h` by `√(1 − n_h/N_h)`. When
   `n_h = N_h` the interval collapses to the exact value, which is correct —
   that stratum is counted, not estimated.
2. For the stratified total, keep the point estimate `Σ N_h · p̂_h`, but form the
   interval as `[Σ N_h · wilsonLow_h, Σ N_h · wilsonHigh_h]` rather than from a
   single normal half-width.

**Consequences.** The interval is slightly conservative — wider than a perfectly
efficient stratified interval. That is the right direction of error when the
number is published to a client. It is never degenerate at `p̂ = 0` or `p̂ = 1`,
it is monotone as samples grow, and it can be verified against hand-computed
values in a test, which a combined-variance approach makes awkward. Summing
bounds treats strata as if their errors align, which they generally do not, so
the interval is a bound rather than a tight estimate; if that conservatism ever
costs a real decision, the alternative is a variance-combined interval with a
per-stratum continuity correction, and that would need a new ADR.

An estimator regression is easy to detect and worth alerting on: after this
change, no non-exhaustive sample (`n < N`) may produce `ci_low == ci_high`.

---

## ADR-0002 — Bounded min-heap by hash, not reservoir or threshold sampling

**Status:** Accepted (implemented in M3)

**Context.** The review proposed both "keep URLs where `hash(url) < threshold`"
and "streaming reservoir sampling" as if they were one technique. They are not.
Threshold sampling gives a sample size that varies around an expected value,
which is awkward against a hard floor of 30. Classic reservoir sampling gives an
exact size but cannot grow later without extra state. The legacy code contains
both shapes: triage draws "the first k by hash" (correct and reproducible), while
`extractPatternsJob.ts:427` runs an Algorithm-R reservoir seeded with
`Math.random()`, which is not reproducible across runs.

**Decision.** A bounded min-heap keyed by a stable hash — keep the K smallest
hashes seen in one streaming pass. Reuse the legacy `stableHash` (FNV-1a,
32-bit): dependency-free, well distributed, and already the reproducibility
basis the design wants. Entries store `(hash, file_id, loc_ordinal)` as three
parallel `Uint32Array`s — 12 bytes, no URL string — and the URL is resolved
later by a targeted re-read of that file at that ordinal.

**Consequences.** Exact sample size, one pass, and raising K yields a strict
superset of the previous draw, so expanding a sample never contradicts the
earlier one. Two further properties fall out that neither alternative has.
Memory is `patterns × K × 12 bytes` and independent of URL length: about 72 MB
for 5,000 patterns at K = 1,200, against roughly 600 MB if URL strings were
held. And min-heaps-by-hash **merge exactly** — the K smallest of a union is the
correct K smallest overall — so heap state can be flushed to Postgres mid-run
and merged on resume with no loss of correctness. A reservoir sample cannot be
merged this way, which is what makes the memory cap and file-granularity resume
in M2 safe rather than approximate.

The cost is that resolving a sampled URL needs a second read of one file. Files
cap at 50,000 URLs, so that read is bounded and cheap, and it buys an order of
magnitude in memory.

---

## ADR-0003 — Partition large tables by `site_id` from creation

**Status:** Accepted (implemented in M1)

**Context.** The end state is 650 sites, some with tens of millions of URLs.
The legacy schema has no partitioning at all — `PARTITION` appears nowhere
across its 56 migrations — and partitioning a table that already holds data for
650 tenants is an expensive, risky migration.

**Decision.** `PARTITION BY LIST (site_id)` from the moment of creation on the
tables that grow large: `pattern`, `pattern_population`, `pattern_sample`,
`sample_observation`. Partitions are created as part of site onboarding.

**Consequences.** Cheap now, and it serves both multi-tenant isolation and query
performance. The cost is that site onboarding becomes a DDL operation, which
needs to be idempotent and covered by a test, and that queries must carry
`site_id` to get partition pruning — enforced by ADR-0004's scoping token rather
than by review.

---

## ADR-0004 — Remodel `session` as `organization → site → sitemap_run`, with compile-time tenant scoping

**Status:** Accepted (implemented in M1)

**Context.** The legacy model's root entity is `session`: one ad-hoc sitemap
migration run. There is no site entity and no tenant entity — `session_id` is
the only scope key in the schema. The product needs sites that are audited
repeatedly over time so trends exist, and an organization boundary so external
client logins can be added later without reshaping every table.

**Decision.** `organization → site → sitemap_run → sitemap_file → pattern → …`.
`sitemap_run` keeps the legacy per-run semantics; `site` supplies the recurring
identity the legacy schema lacks. `organization_id` exists on `site` from day
one even though only internal RBAC ships now.

Scoping is enforced by the type system: all database access lives in
`packages/database/src/repositories/`, and every repository function takes a
branded `SiteScope` token as its first argument, constructible only from an
authenticated request context or an explicit job context. An unscoped query is a
compile error.

**Consequences.** A cross-tenant leak becomes a build failure rather than
something a reviewer has to notice, and row-level security can be layered in
behind the same token in M7 without touching a call site. The cost is ceremony:
every query goes through a repository, and ad-hoc queries in application code
are not possible by design. Backfilling legacy data becomes non-trivial, since
site identity would have to be inferred from `sessions.base_url` — which is why
that backfill is optional (M9), not a dependency.

---

## ADR-0005 — Drizzle only; no Prisma

**Status:** Accepted

**Context.** The action plan permits Drizzle or Kysely for the sampling and
sitemap hot paths and leaves Prisma open for simple CRUD. But
`CODING_STANDARDS.md` section 2.4 also requires one tool to own the schema, and
two ORMs against one database means two migration histories and drift nobody
notices until it breaks.

**Decision.** Drizzle for everything, with Drizzle Kit as the single source of
truth for migrations. Drizzle's tagged-template SQL escape hatch covers the hash
filtering, CTEs, and window functions the sampling path needs; plain CRUD is
unremarkable in it.

**Consequences.** One schema, one migration history, one mental model. CRUD is
slightly more verbose than Prisma's client would be. Revisit only if a concrete
ergonomic problem shows up in dashboard/admin work — and if so, Prisma would
introspect the Drizzle-owned schema and never run a migration.

---

## ADR-0006 — Biome for lint and format, plus a two-rule ESLint pass

**Status:** Accepted (implemented in M0)

**Context.** `CODING_STANDARDS.md` section 4 says to pick one of Biome or
ESLint + Prettier and commit. It also names
`@typescript-eslint/no-floating-promises` explicitly — a type-aware rule Biome
cannot currently express.

**Decision.** Biome is the linter and formatter. A deliberately narrow
`eslint.config.mjs` runs exactly two type-aware rules, `no-floating-promises`
and `no-misused-promises`, using `projectService: true`.

**Consequences.** Near-instant lint and format across the monorepo from one
config, and the two rules that actually matter for an async-heavy worker are
still enforced. The cost is two tools in CI instead of one, and a standing rule
that this file must not grow: anything Biome can express belongs in
`biome.json`.

Three scope exclusions worth recording. Biome 2.5 cannot parse Tailwind v4's
`@theme` at-rule, so `apps/web/app/globals.css` is excluded from Biome; revisit
when Biome adds support. Next's generated `apps/web/next-env.d.ts` is also
excluded. And framework files that must use a default export (Next `page.tsx`,
`layout.tsx`, config files) have `noDefaultExport` disabled by override rather
than by scattered per-file suppression comments.

---

## ADR-0007 — Audit and intelligence only; the fix-and-publish workflow stays out

**Status:** Accepted

**Context.** The legacy tool does two distinct jobs: it *finds* sitemap problems
and it *fixes and republishes* sitemaps (pattern renames, redirect rule
derivation, bulk replace, transform dry-run, zip export, S3/SFTP publish, the
cleaner). The architecture plan describes only the first.

**Decision.** The new platform builds the audit and intelligence side.
Fix-and-republish is out of scope. `pattern_shape_rules` and `shapeStrata` are
artifacts of the fix workflow and are not ported.

**Consequences.** Far smaller scope and a faster path to something that earns
its keep. The open question this leaves is deliberate and tracked: "audit only"
plus "legacy frozen after cutover" means the fix workflow has no owner. Working
assumption — the legacy tool stays available in frozen form for fixing after
audit moves here. That has to be settled before legacy is genuinely retired; it
does not block M0–M7.

---

## ADR-0008 — An estimate may never be rendered without its interval

**Status:** Accepted (component lands in M5/D2)

**Context.** The legacy backend computes `ci_low` and `ci_high`, persists them in
`verify_triage_runs.result`, and never shows them:
`frontend/components/pattern-verify-panel.tsx:695` renders `~${estimate}`, the
point estimate alone. The product's central claim — that a sampled answer comes
with a stated uncertainty — is invisible in its own interface. Meanwhile the
legacy UI gets something else right, and worth keeping: an explicit vocabulary
separating sampled, estimated, and verified numbers, with `~` reserved for
extrapolations and never applied to a counted population.

**Decision.** Three evidence tiers, and one rendering contract.

- **Counted** (`n = N`, or a population count): a plain number. No `~`, no
  interval.
- **Estimated** (`n < N`): the `~` prefix *and* the interval, always.
- **Blocked** (the host refused; there is no measurement): its own visual
  channel, never rendered as a health number. A WAF block is not a site defect.

A single `<Estimate>` component is the only sanctioned way to render a sampled
number. It requires `{ point, low, high, n, N }`, so an interval-less estimate is
a type error, and a CI test asserts no page formats a sampled figure outside it.
The confidence-band thresholds are the same constants the adaptive expansion
trigger uses (`CONFIDENCE_*` in `packages/shared/src/config.ts`), defined once.

Visual treatment comes from `../DESIGN.md`, which is the source of truth for it:
the three tiers and the confidence bands are coloured from the existing
`--status-*` tokens rather than a new palette. Low confidence maps to
`--status-unknown`, whose own definition reads *"insufficient sampling
confidence"* — and deliberately **not** to `--status-critical`, because a wide
interval is an absence of evidence rather than bad news about the site. That is
the same distinction as `BLOCKED` versus `BROKEN`.

**Consequences.** The failure mode cannot recur silently — it becomes a compile
error and a failing test rather than an omission. This is the same approach as
ADR-0004's `SiteScope` token, applied to the other thing that must never quietly
go wrong. The cost is that every number-bearing surface must know its evidence
tier, which means the API returns tiers rather than bare numbers. Sharing the
band thresholds with the expansion trigger is deliberate: if they diverged, the
interface would flag patterns the engine considers settled.

---

## ADR-0009 — Enforce the design system in the token layer, not by review

**Status:** Accepted (implemented in M0)

**Context.** `DESIGN.md` is unusually specific for a design document: section 9
is a list of *bans* rather than preferences — no purple/indigo/violet accent, no
gradients, no capsule badges, no drop shadows for elevation, no corner radius
above 10px, no Inter or Roboto, no non-tabular numerals in a data column. Section
5 states the intent directly: the radius ban is "enforced by simply not having a
larger radius token available." A ban that lives only in a document is a ban that
survives until the first deadline.

**Decision.** `apps/web/app/globals.css` **resets** Tailwind's default `--color-*`,
`--radius-*`, `--font-*`, and `--text-*` namespaces to `initial`, then defines
only the values `DESIGN.md` specifies. Tailwind's default palette and radius
scale therefore do not exist in this project: `bg-indigo-500` and `rounded-2xl`
generate nothing.

Two supporting choices. The runtime palette lives in
`:root[data-theme="dark"|"light"]` with dark as the unconditional default, and
`@theme inline` maps semantic utilities onto those variables so a theme switch is
a single attribute change. And Switzer, the specified UI sans, is **not**
stopgapped: it is not on Google Fonts and its files are not vendored yet, so
`--font-switzer` is left unset with a system fallback rather than substituting
Inter or Roboto, both banned by name.

**Consequences.** The most common drift path — someone reaching for a familiar
Tailwind class under pressure — stops compiling to anything, which is a much
better failure than a shipped screen nobody audits. The cost is that adding a
legitimately new value means editing `DESIGN.md` and the token layer together,
which is the intended friction. Anything genuinely one-off still has Tailwind's
arbitrary-value syntax as an escape hatch, so this constrains defaults rather
than making exceptions impossible; `/impeccable audit` against `DESIGN.md` is the
backstop for those.
