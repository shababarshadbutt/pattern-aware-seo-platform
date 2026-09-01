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

---

## ADR-0010 — Composite primary keys on partitioned tables, and hand-completed migrations

**Status:** Accepted (implemented in M1)

**Context.** Two constraints collide in M1, and both are forced rather than
chosen.

First, Postgres requires a partitioned table's primary key to contain the
partition key. `pattern`, `sitemap_file`, `pattern_population`, `pattern_sample`,
`sample_observation` and `audit_snapshot` are all partitioned by `site_id`
(ADR-0003), so none of them can have `id` alone as its primary key. That
contradicts `CODING_STANDARDS.md` section 2.1, which says primary keys are
always `id`.

Second, Drizzle cannot express declarative partitioning. `drizzle-kit generate`
emits an ordinary `CREATE TABLE` for a table the schema says nothing special
about, because there is no way to say it.

**Decision.** Primary keys on partitioned tables are `(site_id, id)`. `id` stays
a UUID and stays unique in practice; what changes is that the database enforces
uniqueness per partition rather than globally. Foreign keys into these tables
carry both columns, which is why every child already has `site_id`.

Migrations are produced by `drizzle-kit generate` and then completed by hand:
the six `PARTITION BY LIST ("site_id")` clauses are added to the emitted SQL.
The generated snapshot stays authoritative for future diffs, because the
partition clause is invisible to Drizzle in both directions. `drizzle-kit push`
is never used on this project — it would recreate the partitioned tables as
ordinary ones and silently discard the partitioning.

**Consequences.** The composite key is not really a cost: carrying `site_id` on
every child row is what gives partition pruning something to prune on, so the
convention this breaks was working against the schema anyway. Update
`CODING_STANDARDS.md` section 2.1 to record the exception rather than leaving
the schema silently non-conforming.

The hand-edit is the real cost, and it is a genuine hazard: deleting and
regenerating `0000_init_schema.sql` would produce a schema that applies cleanly,
passes every type check, and is unpartitioned. Three things guard it — a banner
at the top of the migration, a test asserting each of the six tables reports
`relkind = 'p'` with `LIST (site_id)`, and a second test asserting the
`PARTITIONED_TABLES` constant matches what the database actually reports, so a
new partitioned table cannot be added without also being onboarded.

Considered and rejected: dropping partitioning in favour of row-level security
alone. RLS gives isolation but nothing for query performance, and the plan's
whole reason for partitioning from creation is that retrofitting it after 650
sites have data is the migration to avoid.

---

## ADR-0011 — Push invariants into the database when they can be expressed there

**Status:** Accepted (implemented in M1)

**Context.** The action plan names the estimator's degenerate interval as the
highest-value paging alert in the system: after ADR-0001, no sample that failed
to cover its population may produce `ci_low == ci_high`, and if one is ever
written the statistical core has regressed. An alert is a reasonable answer.
Writing the row and then telling someone about it is not the best available one.

The same question applies to several other rules M1 had to place somewhere: at
most one in-flight run per site, an evidence tier that matches actual sample
coverage, and an interval that contains its own point estimate.

**Decision.** Where an invariant can be stated as a constraint, it is a
constraint, not a convention, a code path, or an alert.

- `ck_audit_snapshot_no_degenerate_interval` makes the legacy estimator's exact
  defect unwritable, while still permitting the `n = N` case where the interval
  correctly collapses because that population was counted rather than estimated.
- `ck_audit_snapshot_evidence_tier_matches_coverage` enforces ADR-0008's three
  tiers at storage: a partial sample cannot be labelled `counted`, and a
  `blocked` row cannot smuggle in a non-zero estimate.
- `uq_sitemap_run_one_active_per_site`, a partial unique index, arbitrates the
  race that a check-then-insert loses — and the cost of losing it is two runs
  pointing traffic at one origin.
- Composite foreign keys into partitioned parents make an observation that
  references another site's pattern unrepresentable.

**Consequences.** These failures now surface as a failing insert during a test
run rather than as a client-facing number that was wrong for a week, and they
hold regardless of which service, script or future language wrote the row. The
cost is that the rules live in two places — SQL and the code that respects them
— and a legitimate future change means a migration rather than an edit. That is
the intended friction: these are the claims the product's credibility rests on.

The constraints are asserted directly in `constraints.test.ts`, by name rather
than by error message, so a test also fails if some *other* constraint catches
the row first — which would mean the guard under test is not the one doing the
work.

---

## ADR-0012 — Group patterns with a prefix trie, not per-position counters

**Status:** Accepted (implemented in M2)

**Context.** The build plan says to port the legacy engine's pattern extraction.
Doing so faithfully and then running it against a synthetic corpus modelled on
the shapes real sitemaps contain produced this:

```
16,477  /part/{param}
 9,660  /{param}/{param}/{param}     <- three unrelated families merged
 2,946  /{param}                     <- /about, /contact, /terms, /privacy
   917  /catalog/{param}/{param}/detail/{param}
```

A third of the site in a pattern that describes nothing. Note what does *not*
happen: the run succeeds, the population count is exactly right, and no error is
raised. Everything downstream — sampling, the confidence interval, the impact
score — would then be computed about a group whose members have nothing in
common, and the numbers would look entirely reasonable.

Two independent causes, both inherent to the algorithm rather than to the port:

1. **`PARAM_SEGMENT_MIN_OBSERVED_URLS = 3`.** The first three URLs through any
   slot are almost always three different values, so the ratio test sees 100%
   distinct and parameterises immediately. That is what merges the static pages.
2. **One counter per path POSITION, shared by every URL on the site.**
   Everything at position 0 is pooled regardless of what follows it, so a site
   with a few hundred top-level sections tips that position over the threshold
   and drags `/shop/...` and `/legacy/...` along with `/section-N/...`. Both the
   incremental and batch legacy code paths do this.

**Decision.** Replace position counters with a prefix trie, and decide
parameterisation per node.

- **The floor moves from 3 to 30**, matching the sampling minimum used
  everywhere else in the project — below roughly thirty observations a
  proportion says nothing, and that reasoning applies here too.
- **Crowded siblings are collapsed by shape, not merely by count.** The corpus
  root has 311 children; collapsing them wholesale just rebuilds the
  mega-pattern one level down. So children are fingerprinted by the shape of
  their own subtrees and only groups of genuinely interchangeable siblings
  collapse. Three hundred children that all continue with `page/…` are one
  variable slot; the `shop` beside them is not.
- **The real decision is deferred to the end of the pass.** Mid-stream collapse
  is a memory guard with a high threshold, nothing more. A fingerprint taken
  while the trie is filling reflects how much of a subtree happened to have
  arrived rather than its shape, and a wrong collapse is unrecoverable because
  the merged children have lost their names.

Same corpus, after:

```
16,477  /part/{param}
 2,992  /{param}/page/{param}
 2,340  /search
 1,224  /shop/bearings/{param}      (and four sibling categories)
   618  /legacy/discontinued/{param}
   211  /catalog/parts/{param}/detail/{param}   (and four siblings)
   136  /about                       (and four sibling static pages)
```

Nineteen patterns, each one a real family.

**Consequences.** This is the largest deviation from "port the legacy engine" in
the project so far, and it is worth being plain about the trade. The legacy
algorithm is in production across 650 sites, so its output is what the team has
been reading; patterns will not be identical after this change, and on a site
with many top-level sections they will differ a lot — for the better, but
differently. A side-by-side on a real site before cutover is worth the time.

The trie costs more memory than position counters, because literal nodes are
held until they collapse. Fanout per node is bounded by the safety threshold and
depth by path length, so it stays proportional to patterns rather than URLs, and
the benchmark asserts that. Merging two tries re-runs the collapse decisions,
which is what lets parallel workers and a resumed run agree with a single pass.

Three bugs were found and fixed while building this, all by the synthetic
corpus and all invisible to unit tests written against small inputs: a partial
collapse routed surviving literal siblings into the variable branch and made
them unreachable; a bottom-up rebuild never revisited the subtree it had just
merged; and nodes created moments before a collapse fingerprinted as leaves and
were stranded. Each produced plausible-looking output. That is the argument for
keeping the corpus adversarial rather than tidy.
