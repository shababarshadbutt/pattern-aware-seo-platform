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

Visual treatment comes from `DESIGN.md`, which is the source of truth for it:
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

---

## ADR-0013 — Confidence bands need two threshold pairs, not one

**Status:** Accepted (implemented in M3)

**Context.** The plan defines the confidence band from the interval's width
relative to the point estimate: under 20% is `confident`, at or above 50% is
`low`. That works for any ordinary estimate and breaks completely when nothing
was found.

With zero observed hits the point estimate is zero, so a ratio against it is
infinite and every clean pattern on the fleet classifies as `low`. That is not a
cosmetic problem. The M7 alert watches the share of patterns stuck at LOW
confidence, and it would fire on healthy sites — the signal would be worthless
within a week of switching it on.

The first attempt at a fix measured the zero-hit width against the population
instead and reused the same 20/50 cuts. That fails in the other direction: a
pattern where thirty probes found nothing has a ceiling of about 11% of its
population — 4,539 possible broken URLs out of 40,000 — and 11% is comfortably
inside the 20% cut, so it came back `confident`. A test written from the
product's point of view caught it.

**Decision.** Two threshold pairs, chosen because they bound two different
quantities.

- For an estimate above zero, width relative to the ESTIMATE: 20% / 50%.
  "Give or take half the estimate" is a statement about relative precision.
- For an estimate of zero, width relative to the POPULATION: 2% / 10%.
  "Up to this many could be broken and we would not know" is a statement about
  absolute exposure, and the numbers that read as tolerable are an order of
  magnitude smaller.

Calibrated against what the sample budget actually produces at zero hits: 400
probes leave a ceiling near 0.9% (`confident`), 100 leave 3.7%
(`approximate`), and 30 leave 11.3% (`low`).

**Consequences.** A clean pattern that was probed properly now reads as
confident, which is what makes the LOW-confidence alert meaningful. A clean
pattern probed thinly still reads as uncertain, which is correct — thirty
probes genuinely cannot distinguish zero from four thousand.

The cost is two pairs of numbers to keep calibrated instead of one, and the
zero-hit pair has to move if the sample budget moves. Both live in
`packages/shared` config alongside the sample sizes they are calibrated
against, so the relationship is at least visible.

A related finding worth recording, since it looks like a bug and is not: under
the default 400-probe first round, a mid-range error rate on a large pattern
lands at `approximate` and can never reach `confident` — reaching it on a 15%
rate would take roughly 1,900 probes. That is the correct trade. "Somewhere
around 13.5 million, likely between 10.7 and 16.9 million" is entirely
sufficient to rank a pattern first for attention, which is the decision the
number feeds, and 1,500 further requests at a client's origin would change
nothing.

---

## ADR-0014 — Impact Score severity weights

**Status:** Accepted. **Ratified by Shabab Arshad, 2026-09-02.**

**Context.** The Impact Score is `population × error probability × severity`.
The first two terms are measured; severity is a judgement about how much each
kind of failure actually costs a client, and the action plan has flagged it as
needing SEO/business input rather than an engineering guess since Phase 0.
`CLAUDE.md` states the rule directly: do not pick a plausible-looking static
table.

**Decision.** The ratified weights, with the reasoning for each:

| Class | Weight | Why |
|---|---|---|
| `gone` (410) | 1.0 | A definite, server-asserted loss of an indexed URL. |
| `not_found` (404) | 1.0 | Same practical outcome; the thing clients pay to find out about. |
| `soft_not_found` | 0.9 | Worse than a hard 404 for index quality — the URL can stay indexed pointing at a useless page — but it is a detection inference rather than a status the server asserted, so just below. |
| `server_error` (5xx) | 0.8 | Severe, but frequently transient; a sampled 5xx may say more about the moment than the URL. |
| `redirect_chain` | 0.4 | Multiple hops leak link equity and waste crawl budget. |
| `redirect_single` | 0.15 | Usually working as intended. Noted, not alarming. |
| `ok` (2xx) | 0 | Not a finding. |
| `blocked` | 0 | Not a finding either — an absence of measurement. |
| `unknown` | 0 | Refuses to invent a weight for an unclassified outcome. |

Three structural choices go with the numbers.

**No default table anywhere in the code.** `severityFor` throws
`MissingSeverityTableError` when none is supplied. The ratified set is exported
as `RATIFIED_SEVERITY_TABLE` — named for what it is, not as a fallback — and
nothing reaches for it implicitly. A default would be exactly the
plausible-looking guess the rule exists to prevent, and it would quietly become
the shipped answer the first time a caller forgot the argument.

**A refusal can never carry impact.** `blocked` and `unknown` weigh zero, and
`ck_audit_snapshot_refusal_has_no_impact` enforces it in the database as well.
A 403 is both a status code and a refusal; reading it as a client error would
put a crawler-blocking but perfectly healthy client at the top of the triage
queue, which is the most misleading thing this product could do. Legacy
migration `042` draws the same line.

**The weight is frozen with the claim.** `audit_snapshot` stores
`severity_class`, `severity_weight` and `impact_score` rather than recomputing
from the current table. These weights will be revised, and a claim published
under the old set has to stay reconstructible — reading the live table would
silently restate history.

**Consequences.** Ranking is on the point estimate weighted by severity, never
on an interval bound: a wide interval means thin evidence, not a big problem, so
ranking on the upper bound would put the least-understood patterns first and
invert the ordering.

Volume can outweigh severity, and that is intended. Fifty thousand redirect
chains outrank two hundred gone pages, because severity says how bad each URL
is while the score decides where an analyst looks first. It is pinned by a test,
because "worst finding" reads as "highest severity" and a future change might
quietly make it so.

Revising the table is a migration-free code change plus a new ADR, and it does
not alter any stored claim. What it does alter is the ordering of the queue, so
it needs the same sign-off this did.

---

## ADR-0015 — The HEAD→GET escalation cap is a budget, not a ratio

**Status:** Accepted (policy in M4; wired to the HTTP client when it lands)

**Context.** Verification is HEAD-first because a HEAD is cheap and answers
most questions, escalating to a GET only when the result is suspicious — a
method rejection, or a 2xx whose body needs sniffing for a soft-404. A pattern
where everything looks suspicious defeats that entirely: every probe costs a
HEAD plus a ranged GET, and the run quietly spends several times its budget.
The action plan asks for a cap.

The obvious form — escalations as a share of probes completed — does not work.
One escalation out of one probe is 100%, so the cap trips on the first probe and
needs an arbitrary warm-up floor before it becomes usable. That floor would then
be a second tuning knob with no principled value.

**Decision.** Measure against the PLANNED sample size instead, making it an
absolute budget from the first probe: 20% of a 400-probe sample is 80
escalations, and the first one is obviously fine. Rounded up and floored at one,
because a pattern permitted zero escalations cannot be verified at all and would
be flagged for review before doing any work.

Exceeding it flags the pattern for manual review rather than throttling or
continuing. The escalations are each individually justified; what the cap
notices is that this pattern is not answerable cheaply. That is a finding, not
a failure.

The policy is pure and synchronous, in `packages/sampling`, and the HTTP client
consults it. Phase 0 found the action plan's claim that GET bodies were
unbounded to be wrong — legacy already caps them at 64 KB for a soft-404 sniff
and 8 KB for a method-fallback re-probe, with a `Range` header so the server
does not transmit more than is read — so those values are ported rather than
invented.

**Consequences.** The cap is testable without an HTTP client, which is where
this class of bug hides. `estimatedRequestCost` is exported alongside it,
because "one check" is not one request and treating it as one under-counts the
platform request budget by exactly however much escalation is happening — which
is highest on the sites already in trouble.

---

## ADR-0016 — HTTP verification lives in its own package, with the profile ladder outside the probe

**Status:** Accepted (implemented in M5)

**Context.** M4 shipped the escalation cap as pure policy. Wiring it to a real
client raised two structural questions the legacy engine had already answered
the hard way, and one it answered differently from how it started.

**Decision.**

**A new package, `packages/verification`.** Probing someone else's origin,
pacing that traffic and deciding what a response means are distinct from
anything already here, and the policy in `packages/sampling` must stay
independently testable from the client enforcing it.

**The rate limit is charged per REQUEST, not per check.** One check is not one
request: a 2xx costs a HEAD plus a ranged soft-404 GET, a 3xx costs a HEAD plus
a follow-up HEAD, and only a hard 404 costs one. Legacy metered per check and
measured **49.17 req/s against a 25 req/s ceiling** — very nearly double,
invisible at higher latency only because concurrency capped throughput first.
Every outbound call here acquires a slot first, and `verifyPattern` reports
requests sent separately from probes made, because the platform budget is
denominated in requests.

**The profile ladder belongs to the caller.** The probe is a dumb executor: it
tries what it is given, in order, and stops at the first real measurement. Rung
ordering belongs to a per-host strategy that knows which rung a host answered
on; putting it in the probe as well would give two modules an opinion about
escalation, which is how they drift. The two-attempt ceiling is enforced in the
probe regardless, so no caller can widen it.

**The default ladder is ONE rung, and host-strategy negotiation is deferred.**
Escalating to a browser profile per URL is what legacy did before it learned
better: a host that refuses everything makes a 1.3-million-URL population pay
~2.6 million requests to learn one fact 1.3 million times, which at 25 req/s is
days of wall clock for no information. Until a per-host strategy exists that
negotiates once and remembers, a host refusing the honest profile is reported
BLOCKED — true and cheap — rather than retried into the ground.

That is a named gap rather than an oversight. Its cost: a site that would answer
a browser profile is currently reported blocked, and nothing distinguishes
"refuses everyone" from "refuses this profile". Closing it needs a host-profile
table, a rung ladder and a Redis-backed hot copy, which is a milestone rather
than a corner of this one.

**Consequences.** The limiter is in-memory and process-global, so the effective
rate multiplies by worker-container count. Correct for local development and a
single worker; a Redis-backed limiter is required before running more, and is
already scoped for multi-tenant hardening. Stated in the code rather than left
to be discovered.

Redirects are deliberately not followed. The destination comes from the first
response's `Location` header, so following would spend a request for something
already in hand — and would hide the hop count, which is the finding a redirect
chain is weighted four times a single hop for (ADR-0014).

---

## ADR-0017 — The soft-404 body match requires "404" as a whole word

**Status:** Accepted (implemented in M5)

**Context.** Legacy matches every soft-404 signal against the body with a plain
substring test, and one of those signals is the bare string `404`. On the sites
this product audits, part numbers and SKUs are full of digits: a healthy product
page for `SKU-40412`, or one listing `404` in a table of measurements, matches.

Legacy already applies the opposite rule one layer over, in its URL heuristic —
"conservative on the bare 404 signal (standalone token only) so an arbitrary
part number containing digits is never flagged" — so the reasoning is its own,
just never carried into the body matcher.

**Decision.** `404` matches as a whole word; every other signal stays a
substring match. The other phrases ("page not found", "no results") are long
enough that an accidental match is not a realistic concern.

**Consequences.** This matters more here than it did in legacy, which is why it
is worth deviating for: a soft-404 now carries severity 0.9 (ADR-0014) and feeds
the impact score directly. A false positive does not merely mislabel one URL —
it inflates a published number and pushes a healthy pattern up the triage queue,
which is the specific failure the whole evidence model exists to prevent.

The short-body signal is kept as-is: a 200 under a kilobyte is treated as
suspicious, because a near-empty product page is a not-found page that forgot to
say so. Worth knowing when writing fixtures — a terse stub body is classified
soft-404 on that signal alone, which is correct behaviour and briefly looked
like a bug while writing these tests.

## ADR-0018 — Sitemap files move between stages through a store interface

**Status:** Accepted (implemented in M6)

**Context.** The pipeline's stages are separate BullMQ jobs. The worker that
downloads a sitemap file is not necessarily the one that parses it, and is very
unlikely to be the one that resolves a sample candidate out of it later. A local
path is therefore not a shared address.

Three options were weighed. Pinning a run's stages to one worker is simplest but
undercuts the per-stage queue design and breaks the moment ECS runs two tasks.
Re-fetching on demand needs no storage at all but is actively unsafe:
ordinal-based resolution requires byte-stable files, and a sitemap regenerated
between parse and resolve maps ordinals to different URLs with nothing to signal
it.

**Decision.** Stages take a `SitemapFileStore` interface — `put`, `open`,
`stat`, `removeRun` — with a local-disk implementation now and an S3 one in M8.
No stage learns which it got. `sitemap_file` records `storage_key` and
`content_digest` (migration 0004).

Writes go to a temporary sibling and rename into place. Rename on one filesystem
is atomic, so a process killed mid-download leaves nothing rather than a
truncated file. Truncation is the dangerous outcome: a short sitemap still
parses, so it would read as a legitimately smaller population and every count
downstream would be quietly wrong. A missing file is the safer failure, and
every stage already handles it.

**Consequences.** One small abstraction, and the pipeline does not change when
S3 lands. The digest is recorded but is deliberately not the guard on
resolution — see ADR-0019.

## ADR-0019 — Candidate resolution re-hashes the URL rather than verifying the file digest

**Status:** Accepted (implemented in M6)

**Context.** The sampler stores a 12-byte `(hash, fileId, ordinal)` triple
instead of a URL string, which is what keeps a 5,000-pattern site's sample state
in tens of megabytes. Verification needs real URLs, so the file is re-read and
counted back to the ordinal. This is the seam where an error is invisible
everywhere downstream: probe the wrong URL, and the observation is recorded
against the right candidate with a wrong result. Nothing about that looks like a
failure.

**Decision.** Every resolved URL is re-hashed and compared against the hash the
sampler stored; a mismatch is fatal. The stored file digest is *not* the guard.

A digest proves the bytes are unchanged, which is only a proxy for what matters:
that this ordinal still holds the URL that was hashed. Re-hashing tests that
directly and per candidate. It is also strictly more useful — a sitemap
regenerated with the same URLs in the same order is a digest mismatch but a
correct resolution, while a shifted URL is caught either way. Resolution can
therefore stop at the last wanted ordinal instead of reading a 10 MB file to
verify a digest for twelve URLs.

A file that ends before its sampled ordinals is also fatal. Resolving what it
can and returning a short list would shrink the sample without shrinking `n`,
inflating every interval computed from it while looking like an ordinary
success.

**Consequences.** The digest stays useful for a different and cheaper question —
has this site's sitemap changed since the last run? — rather than being
load-bearing here.

Resolution records its failure and throws *after* the stream rather than from
inside the callback. `streamLocs` rewrites any error into a preamble error when
junk was stripped and parsing then failed, which is right for parse errors and
would have silently turned a hash mismatch into a misleading "non-recoverable
preamble" report. Confirmed by reverting to the naive version and watching the
test fail with the wrong error type. Both features are individually correct;
only their composition was wrong.

## ADR-0020 — impact_score is numeric, not bigint

**Status:** Accepted (implemented in M6, migration 0006)

**Context.** `impact_score` shipped in M4 as `bigint`. The score is
`point_estimate × severity_weight`, and severity is a weight in (0, 1], so the
product is fractional by construction: three gone URLs at severity 0.9 is 2.7.
Nothing had ever written an `audit_snapshot` row before the pipeline existed, so
the mismatch surfaced the first time the estimate stage ran end to end, as
`invalid input syntax for type bigint: "2.7"`.

**Decision.** The column becomes `numeric(20, 3)`. The obvious alternative —
rounding at the write — is worse than the bug: a 3-URL pattern at severity 0.15
scores 0.45 and rounds to zero, ranking a real finding as no finding at all.
Losing small findings in a rounding step is the same failure the whole
per-pattern architecture exists to prevent, one layer down.

**Consequences.** `numeric` arrives from node-postgres as a string, so the
repository coerces it in one place on the way out rather than at each read — one
of which would eventually compare a string to a number and sort "9" above "10".
Ordering stays numeric because it happens in SQL on the column.

## ADR-0021 — A spent escalation allowance reduces coverage; it does not flag for review

**Status:** Accepted (supersedes part of ADR-0015; implemented in M6)

**Context.** M4 defined the GET-escalation cap and M5 wired it in. When the
allowance was spent, `decideEscalation` returned `flag_for_review` and
`verifyPattern` set a `needs_review / GET_ESCALATION_CAP` verdict.

The end-to-end run showed that this inverts the signal. A healthy 200 wants a
soft-404 sniff, so a pattern that is *entirely healthy* escalates on every URL
and always spends its allowance. A pattern that is *entirely gone* — 410, with
nothing to sniff — never escalates at all. Measured on the fixture site:

| pattern | health | escalated | old verdict |
| --- | --- | --- | --- |
| `/product/{param}` | 100% healthy | 6/30 (cap) | needs_review |
| `/article/{param}` | 100% healthy | 6/30 (cap) | needs_review |
| `/legacy/{param}` | 100% gone | 0 | measured |

So every healthy pattern was flagged for a human and the one dead pattern came
back clean. At 650 sites that makes the flag meaningless and buries the
host-level problems it exists to surface — and the SLI "patterns requiring
review" would read ~100% permanently.

Both features are individually correct, and M5's own comment already argued the
right answer: "a suppressed sniff still yields a usable status from the HEAD —
what is lost is soft-404 detection on that URL, which is the honest trade for
not doubling the request cost." Only the verdict disagreed with it.

**Decision.** A spent allowance suppresses the optional sniff and the pattern
stays `measured`. What the cap cost is reported as a number: `soft404Sniffed`
and `soft404Suppressed` on the verify result. `needs_review` is reserved for
`HEAD_NOT_SUPPORTED` — a host that cannot be measured the cheap way, which is a
genuine finding for a person.

`decideEscalation`'s decision was renamed from `flag_for_review /
GET_ESCALATION_CAP` to `suppress_escalation / ESCALATION_BUDGET_SPENT`, because
the old name described a consequence that no longer happens. Its consumer always
did the right thing with the decision; only the name lied.

The rejected alternative was raising `HTTP_MAX_GET_ESCALATION_FRACTION` toward
1.0 so healthy patterns fit under it. That leaves the semantics alone but
doubles the request cost of the common case — the exact spend the cap exists to
prevent — and halves how many sites a fleet cycle buys.

**Consequences.** Low soft-404 coverage is now an input to sampling harder
(M3's expansion) rather than a reason to send a human to look at a healthy
pattern. The verdict union lost `GET_ESCALATION_CAP`, which is a breaking change
to `PatternVerdict`; M5's tests were updated with the reasoning recorded in
them.

## ADR-0022 — One BullMQ worker set per site, attached while a run is in flight

**Status:** Accepted (implemented in M6)

**Context.** Queue names are `{tier}:{siteId}:{stage}` so one site's job volume
cannot starve another's. BullMQ has no wildcard consumer, so something must hold
a `Worker` per queue — and five stages across 650 sites is 3,250 workers, which
no single process can hold.

**Decision.** The worker supervises a set of per-site pipelines and attaches only
to sites with a run in flight. The request budget allows roughly twenty site
audits a day, so that is about a hundred workers rather than three thousand.

Stage concurrency defaults to one per site: ingest holds a pattern trie and
per-pattern sample heaps for a whole site, and two concurrent ingests would
double that against a memory budget sized for one. Verification's parallelism
belongs to the per-host rate limiter, not to job concurrency — four concurrent
verify jobs would not send requests faster, they would queue inside the limiter.

The rate limiter and circuit breaker are constructed **once per process** and
shared by every site. Both key on host, and their state only means anything
shared: two sites behind the same CDN host must draw on the same per-host
allowance, or the origin sees double the agreed rate.

**Consequences.** A fleet that outgrows this needs a queue-per-tier with
per-site fairness inside it (BullMQ's group support, or a scheduler); that is a
decision to take with real numbers rather than pre-emptively, and the ceiling is
stated in the code rather than left to be discovered.

Fleet-wide auto-attach is deliberately **not** wired. It needs a read across
every organization, and every repository read is scoped by construction
(ADR-0004) — correctly, since that is what makes a cross-tenant query a compile
error. Granting the worker a fleet-wide read is a real decision about the tenant
boundary, not a convenience to add while wiring queues, so a run is attached
explicitly for now.

## ADR-0023 — `packages/database/testing`: a second, narrow, test-only entry point

**Date:** 2026-09-03
**Status:** Accepted

### Context

`packages/database` publishes exactly one entry point (`.`) by design, and
`compile-guards.test.ts` asserts it. That single door is what makes ADR-0004's
guarantee structural rather than advisory: `internalDatabase` exists inside the
package, and nothing outside can reach it because no published path leads there.

Two consumers then needed a *migrated* Postgres in their own suites —
`packages/pipeline` at M6, and `apps/api` here, whose route tests are meaningless
against a mock (the thing under test is the boundary between the routes and the
scoped repository layer). M6 solved it by duplicating a harness inside
`packages/pipeline`, which meant migration-running boilerplate was on its way to
being reinvented once per package.

`docs/CODING_STANDARDS.md` §1.4 recorded the decision to fix this properly on
2026-09-02, with two conditions attached. This ADR is the implementation the
standard asked for.

### Decision

Add a second export subpath, `./testing`, exposing a migrated-pool factory
(`createTestDatabase`) for use from test files only.

`.` is unchanged and no less restrictive than before. The harness hands back the
same opaque `Database`, so a test can create and drop a database and still
cannot write an unscoped query — the compile-time guarantee is untouched. What
the subpath grants is the ability to *get* a real migrated database, not the
ability to bypass scoping.

Both conditions from §1.4 are enforced by tests rather than by review:

1. The exports-map guard now asserts the exact sanctioned set,
   `[".", "./testing"]`, so a third entry point is a failing test rather than
   something a reviewer must notice.
2. A second guard asserts `./testing` is imported only from test files and never
   from `apps/*/src`. The harness opens its own `pg` client to create and drop
   databases — proportionate in a test, completely inappropriate in a request
   path, and the difference was a convention until something checked it.

`apps/api`'s tests therefore live in `apps/api/test/` rather than beside the
source, which satisfies "never from `apps/*/src`" literally instead of by
argument.

### Consequences

`packages/pipeline/src/test-harness.ts` is deleted, along with the `pg`
devDependency it needed. One harness, one place migrations get run in tests.

The first version of the import guard searched for the bare specifier anywhere in
a file and flagged `apps/api/vitest.config.ts`, whose docblock *explains* this
rule — a comment describing the constraint read as a violation of it. It now
matches import syntax. Worth recording because it is the failure mode of every
grep-shaped guard: verify such a check both ways, on a planted violation and on a
file that merely mentions the thing.

## ADR-0024 — Impact's interval is derived, not stored

**Date:** 2026-09-03
**Status:** Accepted

### Context

ADR-0008 forbids rendering an estimate without its interval. `impact_score` is
`point_estimate x severity_weight` — a weighted count of URLs — so it is exactly
as estimated as the count it derives from, and it was being rendered as a bare
figure with no `~` and no interval, identically whether the evidence tier was
`counted` or `estimated`.

`scoreImpact` already computes `scoreLow`/`scoreHigh` for this purpose, and its
own doc says so: "the bounds are carried through so the interface can show the
range beside the score, which is the honest presentation." They were computed and
then dropped on the floor, because `audit_snapshot` stores only the point.

### Decision

Derive the bounds in the API rather than adding columns:

    impactLow  = ci_low  x severity_weight
    impactHigh = ci_high x severity_weight

Every input is already on the row. `severity_weight` was written to
`audit_snapshot` but never selected, which is what made the derivation look
impossible; it and `confidence_level` are now projected (and coerced from
node-postgres's numeric-as-string).

The confidence band is reused rather than recomputed. Scaling a point and both of
its bounds by the same constant cannot change the interval's width relative to
its point, so the band is invariant under weighting — recomputing it would be
arithmetic that can only agree.

### Consequences

No migration, and no second place for the same number to drift. The alternative —
persisting `impact_low`/`impact_high` — would store three values that must always
satisfy a fixed relationship, which is the shape of a constraint waiting to be
violated by a partial write.

The trade-off is that a future change to how impact is weighted (ADR-0014's note
that traffic amplification would need its own column and a revised constraint)
must update this derivation too. That is a smaller surface than a migration plus
a backfill plus a CHECK.

## ADR-0025 — The API validates with zod through a Fastify type provider

**Date:** 2026-09-03
**Status:** Accepted

### Context

The first API routes were typed with Fastify's route generics and nothing else.
That is a compile-time claim with no runtime check: `request.params.siteId` was
typed `string` and flowed straight into a Postgres `uuid` comparison. A non-UUID
path segment produced SQLSTATE `22P02` and, because no error handler was
registered, Fastify serialized the driver error — raw query text and column list
— to the client as a 500.

Two failures in one response: the wrong status, and an information leak.

### Decision

Validate with zod via `fastify-type-provider-zod`, so one schema per route drives
both the runtime check and the handler's types. zod is already this project's
validation tool (`packages/shared`'s startup config, the pipeline's job
payloads), so this is one idiom rather than a second dialect alongside JSON
Schema.

Responses are serialized through declared schemas too. Unknown keys are stripped,
which means adding a column to a table does not silently start publishing it —
`organization_id` and `site_id` stop crossing the wire on rows with no use for
them.

Two typing details worth recording, because both cost time:

- Date fields are a union of string and Date, **not** a `.transform()`. A
  transform makes zod's input and output types differ, and the provider types a
  reply by its *output* — so a transformed schema demands the handler already
  return strings while every repository returns `Date`. JSON serialization
  renders a `Date` as an ISO string regardless.
- Every array is `.readonly()`. The repositories return `readonly T[]`
  deliberately, and unlike a readonly *property*, a readonly array is not
  assignable to a mutable one.

### Consequences

A malformed id is a 400 naming the offending field, before any query runs. One
error envelope covers validation failures, domain errors, unknown routes and
unhandled exceptions; anything that might carry internals is logged server-side
and never serialized.

A response schema that drifts from reality now fails loudly rather than
publishing the wrong shape quietly — the correct direction for this project, and
why every route has a test against a real database.

## ADR-0026 — The API acts as one organization, under a *system* scope, until auth exists

**Date:** 2026-09-03
**Status:** Accepted (superseded when session auth lands)

### Context

There is no login yet; auth was deliberately deferred so the evidence screens
could be built against real data first. But every repository call requires an
`OrganizationScope` or `SiteScope`, by construction — there is no unscoped path.
Something has to produce one.

The first implementation used `authenticatedOrganizationScope`, which stamps
`origin: "request"`. That value means "a session asserted this membership", and
`scope.ts` documents it as the caller vouching for the session. Nothing here can
vouch for anything: the organization comes from `DEFAULT_ORGANIZATION_SLUG`.
Every audit log line would have attributed a hardcoded identity to a user.

### Decision

Resolve the configured slug once and wrap it in `systemOrganizationScope`, whose
`origin: "system"` is true. `scope.ts` describes that constructor as deliberately
the most awkward of the three names, so platform-internal authority stands out in
a diff — exactly the property wanted for a placeholder.

The scope is threaded through as a parameter, never read from a global inside a
repository, so when session auth lands `resolveDefaultOrgScope` is the only thing
replaced and no call site changes shape.

### Consequences

Two things are explicitly *not* granted by this. Scoping is still enforced: the
API cannot read across organizations, and the route tests prove a site id
belonging to another organization returns 404 rather than that tenant's rows.
And the membership check `siteScopeWithin` cannot perform — that a site belongs
to the organization the scope names — is now performed by every route taking a
`siteId`, via `findSiteById`, which filters on both ids.

Left open, and to remove when auth lands: CORS is `origin: true` and must narrow
to a configured list; `DEFAULT_ORGANIZATION_SLUG` defaults to the demo
organization, so a production boot resolves to demo data rather than failing —
acceptable while nothing is deployed, wrong the moment something is.
