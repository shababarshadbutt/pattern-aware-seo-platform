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

---

## ADR-0027 — The Google Stitch design supersedes the instrument-panel spec

**Date:** 2026-09-04
**Status:** Accepted; its RAIL-LABEL clause superseded by ADR-0039
(2026-09-07), which renames "Crawls" to "Analyses" at the owner's direction
after an external review reached the same objection independently. Everything
else here — the palette, the type, the namespace reset, dark-only, and the four
things a redesign did not get to change — stands. The unreachability note in the
Consequences below is also now moot: the design is vendored at
`docs/design-source/` (ADR-0038).

### Context

`docs/DESIGN.md` described a "glass cockpit instrument panel" identity: amber
accent, hairline borders, no card chrome, Switzer as the UI face, and an
explicit ban list (§9) naming purple/indigo accents, KPI card rows, capsule
badges and drop shadows.

Two things were true about it. It was coherent and structurally enforced —
`apps/web/app/globals.css` resets Tailwind's colour, radius, font and font-size
namespaces to nothing, so an off-spec utility does not compile. And it was not
what shipped: Switzer is not on Google Fonts, its files were never vendored, so
`--font-switzer` stayed unset and every screen fell back to system sans. The
largest visual gap between the app and its own spec was a font that was never
there.

The project owner designed a replacement in Google Stitch (project
`12137181229897682385`, 13 desktop screens) and decided it supersedes
`docs/DESIGN.md` rather than being reconciled with it.

### Decision

The Stitch design is the product's visual identity. `docs/DESIGN.md` is
rewritten to describe it, including a §9 that bans what the new identity
rejects rather than what the old one did.

Values are transcribed from the `tailwind.config` in Stitch's own generated
HTML, not sampled from a screenshot. Palette is Material 3 dark; accent is
indigo, in two strictly separate roles — `--accent` `#4f46e5` is a fill (never
text, at 4.0:1 against the page) and `--accent-text` `#c3c0ff` is the tint for
accented text. Radius becomes 2/4/8/12. Type is Geist + JetBrains Mono, both
served self-hosted by `next/font/google`, which is what finally makes the UI
face real.

Three decisions inside this one, each made deliberately:

- **Dark only.** Every Stitch screen is `html class="dark"` and its config
  carries no light ramp, so the previous spec's fully-designed light palette
  and the `data-theme` switch are retired rather than half-kept. A future light
  mode is a palette to design, not a switch someone forgot to wire.
- **The namespace reset survives the values it protected.** The technique is
  independent of which design it enforces, and it is the reason a spec stays
  true: drift becomes a build error rather than something a reviewer must
  notice. Only the surviving token set changed.
- **The rail mirrors Stitch's navigation exactly** — Overview, Projects,
  Crawls, Issues, Tools, Analytics — at the owner's explicit direction, after
  the conflict was raised and reaffirmed. Recorded plainly because it is a real
  tension: "Crawls" is a crawler product's language, and this platform's whole
  differentiator is that it samples patterns instead of crawling every URL
  (CLAUDE.md, non-negotiable rules). The label is presentational. A screen
  built under that item must still not acquire crawl-everything behaviour, and
  `components/app-shell.tsx` carries that warning next to the list. Only
  Overview has a screen; the rest render disabled rather than link to a 404.

### What is explicitly NOT superseded

A visual redesign is the most natural way for a correctness fix to be undone
quietly, so these carry forward unchanged, and each has a test that fails if it
does not:

- **ADR-0008's rendering contract.** Every sampled figure renders through
  `<Estimate>` with its `~` and interval. `lib/adr-0008-guard.test.ts` hardcodes
  `components/estimate.tsx` as the sole permitted adapter — that file must not
  be renamed or moved, or the guard passes while checking a convention nothing
  follows.
- **The tone mapping in `lib/status.ts` is product logic, not decoration.**
  Only the colours the four tones resolve to changed. `patternStatusTone`
  still maps `blocked` to `unknown`, not `critical`: a host refusing us is not
  a site defect.
- **The confidence band is said, not only coloured** — the band word renders
  beside the interval, so it survives a screenshot, a print, and a reader who
  cannot separate the hues.
- **Tabular numerals in every data column**, applied at the element level via
  `[data-numeric]` rather than left to each cell.

### Consequences

Warning is no longer the accent colour. Under the amber accent the two were
deliberately the same token; with an indigo accent they are independent, and
`--status-warning` carries its own amber.

The previous spec's §7 rejected the "row of 4 KPI cards" layout by name. The
Stitch design uses it, so `StatCards` replaces the hairline `StatStrip`.

The design covers 13 screens for a broader, more conventional SEO product —
redirect analysis, Core Web Vitals, internal links, structured data — of which
three have a counterpart today (overview → sites list, sitemap analyzer → site
detail, issue detail → pattern evidence). The other ten are reference for
future work, not a commitment to build them.

Stitch's own MCP server is registered at local scope, but Node cannot reach
`stitch.googleapis.com` from this machine: TLS inspection presents a certificate
Windows trusts and Node does not, so `curl` succeeds where the MCP client fails.
The design was pulled over `curl` against the same JSON-RPC endpoint. Anyone
re-pulling it needs either that workaround or the inspecting proxy's root CA in
`NODE_EXTRA_CA_CERTS`.

---

## ADR-0028 — Fleet reads are organization-scoped, and get their ids from the scope

**Date:** 2026-09-04
**Status:** Accepted; its PROJECTS verdict superseded by
ADR-0037 (2026-09-07), which built the fleet portfolio once the owner supplied
the screen — it is not the sites list this ADR took it for. The cross-site query
design recorded here stands and ADR-0037 extends it with two more queries.

### Context

The navigation rail adopted with the Stitch design (ADR-0027) has six items, of
which one had a screen. The other five were rendered disabled, which was the
recorded decision — but on the running app five items that did nothing on click
were indistinguishable from five broken links, and were reported as a bug.

Looking at what sat behind each one, they were not equivalent. `Issues` and
`Crawls` had working, tested queries that had simply never been exposed:
`listSnapshotsByImpact`, `listRuns`, `listSamplingHealth`,
`countPatternsByStatus`. `Tools`, `Analytics` and the design's remaining screens
— Core Web Vitals, internal links, structured data, redirect analysis, content
audit — have no schema, no pipeline stage and no data, so a screen for them
would have to invent numbers. `Projects` is the design's name for the sites
list, which `Overview` already is.

Every existing query takes a `SiteScope`. A rail item has no site selected, so
these screens are inherently organization-level: "which of my sites is worst".

### Decision

Build `/issues` and `/runs` on real data. Leave `Projects`, `Tools` and
`Analytics` disabled, now with a visible `SOON` marker so the absence reads as
a stated fact rather than a failed click.

Two new queries — `listOrganizationSnapshotsByImpact` and
`listOrganizationRuns` — are the only ones in `packages/database` that
deliberately span more than one site.

**They resolve their site ids from the `OrganizationScope`, via a
package-internal `organizationSiteIds`, rather than filtering by joining
`site.organization_id`.** Two reasons, and the performance one is not the
important one:

- **Pruning.** `audit_snapshot` and `sitemap_run` are partitioned by `site_id`,
  and their indexes are site-leading: `idx_audit_snapshot_site_impact` on
  `(site_id, impact_score DESC NULLS LAST)`, `idx_sitemap_run_site_started` on
  `(site_id, started_at DESC NULLS LAST)`. An organization filter reached
  through a join prunes no partitions. An explicit id list prunes — `EXPLAIN`
  confirms only the named sites' partitions are touched.
- **The tenant boundary becomes structural.** The only site ids a caller can
  obtain come from its own scope, so the query cannot reach another tenant's
  rows even if its predicate were wrong. Contrast the pattern routes, where a
  caller supplies `siteId` and `assertSiteInOrg` is therefore load-bearing —
  the defect M7 found was exactly that check being absent.

### This is cross-SITE, not cross-ORGANIZATION

The distinction is the whole point, and it must not erode. These reads span
every site *within one organization*. The fleet-wide auto-attach question the
action plan leaves open is a cross-**organization** read, and nothing here
moves toward it: no function accepts an organization id from a caller, and
neither route takes one.

### Consequences

`GET /issues` and `GET /runs` are the first routes whose result set is not
bounded by something in the URL — a site's patterns are bounded by the site, a
pattern's findings by the pattern, but "every site's worst findings" grows with
the fleet. So `limit` is validated and capped at 200 at the edge rather than
left to a repository default.

Findings on `/issues` carry impact's interval, like every other surface: impact
is `point_estimate × severity_weight` and ADR-0008 does not exempt it.
`withImpactBounds` moved out of `routes/patterns.ts` into `findings.ts` so both
routes share one derivation — `schemas.ts` had been documenting it as living
there while no such file existed.

The demo seed now creates two sites. With one, both fleet screens render a
one-row table that is indistinguishable from a broken cross-site query; the
second site is what makes the difference observable, the same reason the
cross-tenant tests use real rows rather than empty ones. Both new isolation
tests were confirmed load-bearing by removing the tenant filter and watching
them fail.

Ranking stays on `impact_score`, never on an interval bound. Ranking on an
upper bound floats the least-understood patterns to the top, because a wide
interval means thin evidence rather than a big problem.

### Correction: the ordering is NOT index-satisfied across sites

The first draft of this ADR claimed the id list also let Postgres merge the
per-partition indexes into globally sorted output. **`EXPLAIN` disproves that**,
and it is recorded here rather than quietly edited out, because the wrong
version is the plausible-sounding one.

What was measured, on the seeded database:

- `site_id = <one constant>` with `ORDER BY impact_score DESC NULLS LAST` → a
  plain `Index Scan` the `LIMIT` stops early. No sort. This is the good plan.
- `site_id = ANY(<array>)` → **`Bitmap Index Scan`** per partition plus a
  `Sort`, even with `enable_seqscan = off`. A bitmap scan never preserves index
  order, so no merge is possible. Pruning still works; the ordering does not.

So the fleet query prunes correctly and then sorts what it matched. That is
correct at any scale and cheap at this one. The fix when a fleet makes it
matter is **top-k per site** — one index-ordered `LIMIT n` query per partition,
merged in application code — which is a different query shape rather than a
tweak, and is not worth its round trips for the handful of sites that exist
today. The limitation is commented at the query.

Chasing this down found a real pre-existing defect. `ORDER BY x DESC` means
`DESC NULLS FIRST`, while both indexes are `DESC NULLS LAST` — a mismatch that
stops the index satisfying the ordering at all. `listRuns` already got this
right for `started_at`; `listSnapshotsByImpact` did not, so **even its
single-site query was sorting every matching row instead of walking the index**.
`impact_score` is `NOT NULL`, so spelling out `NULLS LAST` cannot change a
result — it only lets the index be used. Both queries now do.

The rail item that opens `/runs` still says **Crawls** — the Stitch label, kept
at the owner's direction (ADR-0027) — while the route and page say "Runs",
because `sitemap_run` is the entity and a run samples rather than crawls. The
label/title mismatch is deliberate: the alternative is teaching the reader a
crawl-everything model of the product on the screen that shows its URL counts.

## ADR-0029 — Screens for the data that already existed: run detail, per-site findings, per-pattern file distribution

**Date:** 2026-09-04
**Status:** Accepted
**Context:** D3a, prompted by a coverage audit of the Stitch design against what is built.

### What the audit found

Three of the eight navigation-rail items lead anywhere. Two of the five that do
not — Tools and Analytics — have no schema, no pipeline stage and no data, so a
screen for them would have to invent numbers; that stays true and they stay
disabled. But the audit's real finding was not about the rail. It was that the
database already held, and the pipeline already wrote, a substantial amount of
measured data that **no HTTP route and therefore no screen could reach**:

- **`sitemap_file`: the entire table.** Every column — ordinal, filename, parse
  status, URL count, byte size, digest, `parse_error` — written by the ingest
  stage and readable by nothing. `listSitemapFiles` existed and was called only
  inside `packages/pipeline`.
- **`pattern_population`: the entire table.** `listPatternFiles` and
  `sumPatternPopulation` had no caller outside a test.
- **`sampling_health`: seven of its nine figures.** The API had always sent
  them and the web client had always typed them; the site overview rendered
  exactly two.
- **`listSnapshotsByImpact`** — a site's own findings, worst first — reachable
  only from the finalize stage, so the only route into a finding was the
  fleet-wide `/issues` list.
- **`countPatternsByStatus`** and **`countObservations`**: the same shape.

None of this needed a schema change or a new pipeline stage. It needed routes
and screens, which is what this ADR records.

### Decision 1 — A run is addressed by its id alone, scoped through the organization

`GET /runs/:runId` carries no `siteId`, because the fleet list it is reached
from carries none either and the rail's Crawls item should stay current when the
reader drills in. That removes the `findSiteById` membership check every other
id-bearing route makes, so the boundary moves into a new
`findOrganizationRunById`, which resolves the run against the site ids
`organizationSiteIds` returns for the caller's own scope — the same technique,
and for the same two reasons, as ADR-0028's fleet queries. A lookup on `id`
alone would have been wrong twice over: `sitemap_run` is partitioned by
`site_id`, so an unqualified id scans every partition, and it would return
another tenant's run.

This is also what makes the route's `siteScopeWithin(orgScope, run.siteId)`
safe, and the distinction is worth stating because getting it wrong is the M7
defect: building a `SiteScope` from a **caller-supplied** id skips a check
nobody performs. Here the id was never supplied — it came back from a query that
can only see this organization's runs. The check happened; it happened in the
lookup.

The isolation test was confirmed load-bearing by deleting the
`inArray(siteId, ...)` predicate: exactly one test fails, and it fails by
returning the rival tenant's run.

### Decision 2 — Two read queries gained a join, so their rows are legible

`listSnapshotsByImpact` and `listPatternFiles` each returned rows identified
only by a UUID — a finding whose pattern is `b2f5e6cb-...` is not actionable, and
a population row naming `sitemap_file_id` tells a reader nothing. Both now join
the row they reference, on **both** key columns (`site_id` paired with `id`),
which is what keeps the join inside one partition under ADR-0010's composite
primary keys and is the pairing the post-M3 hardening pass added FKs for. The
fleet query already did exactly this; these two now match it rather than
inventing a second approach.

`listSnapshotsByImpact`'s new return type is `SiteSnapshotRow` — the site name
deliberately does **not** travel, unlike the fleet shape, because the screen is
the site.

### Decision 3 — A capped list must disclose its cap

`listIssues(limit?)` and `listRuns(limit?)` had accepted a limit that no caller
ever passed, so both fleet screens silently truncated at the API's default of 50
while their KPI cards counted `rows.length` and labelled it as the fleet. A card
reading "50 findings" that means "at least 50" is the manufactured-precision
failure DESIGN.md section 9 bans, arrived at by a different route than the one
that ban was written for. Until there is real pagination (D3), the screens pass
the maximum the API allows, prefix every derived figure with a greater-or-equal
sign when the page is full, label the count "(page)", and say so in a line under
the cards.

The same rule produced `fileCount` on the run detail. `listSitemapFiles` gained
an **optional** limit — unset by default, because the pipeline's own callers
need the whole list and `finalize` would otherwise judge a run on its first page
— and the route pairs its 200-file page with a real `countSitemapFiles`. Not
with `sitemap_run.total_files`, which is a progress counter a stage writes: the
two disagreeing is a fact worth surfacing, and the screen says so when they do.

### Decision 4 — A parsed file with zero URLs is not a success

Found by screenshotting the new run detail against seeded data, not by a test.
`legacy-sitemap.xml` had `parse_status = 'parsed'` and `url_count = 0`, and the
screen rendered it green with a healthy row accent, identical to a file holding
5,700 URLs. That is precisely the indistinguishability the non-negotiable rules
and standards section 1.5 forbid — an HTML error page parses as perfectly valid,
URL-less XML, which is how M2 found this the first time — and exposing the table
for the first time reintroduced it visually.

`parse_status` cannot express it, because the parse genuinely succeeded. So
`sitemapFileTone(status, urlCount)` decides the tone from both, and the row
carries a `NO URLS` marker beside the status. `fileParseStatusTone` is kept
separate and still maps `failed` to critical and `skipped` to warning — a file
we could not read leaves the run's populations **short**, so its counts are
wrong rather than merely partial, while a skipped file undercounts by somebody's
choice. Tests cover all three, including that a zero count does not soften a
real failure.

### Decision 5 — Projects stays disabled; the rail's dead route match is gone

ADR-0028 already ruled Projects a duplicate of Overview, and that stands. But
Overview's `match` array listed `/sites`, and there is no `/sites` page — a
dormant 404 waiting for the first person to trim a URL by hand. It is now
`/sites/`, the drill-down's real prefix, which cannot be reached without a site
id. The same class of latent lie the `SOON` marker exists to fix.

### What this deliberately does not do

The API remains **read-only** — seven GET routes, now nine, and no mutation
anywhere. Nothing in the UI can start a run, onboard a site or dismiss a
finding, and that is unchanged rather than overlooked: a write path needs auth
to scope it, and auth is still deferred (ADR-0026). Tools, Analytics, Settings
and the design's other screens stay disabled for the reason ADR-0028 gave. The
D3 interaction debt — slide-over, Cmd+K, j/k navigation, density toggle,
sparklines — is untouched, and real pagination belongs with it.

Two documentation findings from the audit, recorded because they will otherwise
be rediscovered. `docs/DESIGN.md` asserts the Stitch design has 13 desktop
screens but never enumerates them — only eight are recoverable by name from this
log and the action plan, and five are unrecorded anywhere. And the six deferred
interaction features are **not in the current DESIGN.md at all**: they belonged
to the superseded instrument-panel spec and survive only as a debt list, which
is why "the three Magic UI motion moments" now contradicts DESIGN.md section 8,
where decorative animation is banned.

## ADR-0030 — The Settings screen reports which limits are actually enforced

> **Superseded in part by ADR-0031 (2026-09-05).** The screen composition this ADR describes was invented rather than transcribed, and the real Stitch design is a per-project form. The config mask, the enforcement manifest and its bidirectional guard — the substance below — all stand.

**Date:** 2026-09-05
**Status:** Accepted
**Context:** D3b, prompted by "check if the Settings screen is completed".

### What checking it found

Settings was a disabled footer rail item with a `SOON` badge, no route and no
stub — and no document has ever described what the screen should contain.
`docs/DESIGN.md` mentioned Settings once, only to say it appears in the rail. So
its scope was a decision to make rather than a spec to recover.

Making that decision turned up the reason it was worth doing now. **Twelve of
the platform's twenty-three configured operational limits are applied by
nothing.** Validated at startup, held in one auditable schema whose own docblock
says every number in it "bounds something that costs real money or points real
traffic at somebody else's production web server" — and then consumed by no
code:

- The five HTTP budgets (`HTTP_PLATFORM_DAILY_REQUEST_CAP`,
  `HTTP_PER_SITE_DAILY_REQUEST_CAP`, `HTTP_BUDGET_WARN_FRACTION`,
  `HTTP_BUDGET_HALT_FRACTION`, `HTTP_MAX_GET_ESCALATION_FRACTION`). There is no
  per-site or platform request counter anywhere — no table, no Redis key — so
  nothing can charge a daily cap against anything, and the warn/halt fractions
  are fractions of an uncounted cap. The escalation fraction loses to the
  hardcoded `DEFAULT_ESCALATION_BUDGET` because `stages/verify.ts` never passes
  a budget through.
- The three `POPULATION_*` thresholds.
- **The four `CONFIDENCE_*` band widths** — found by the guard below rather than
  by reading, and the most consequential of the twelve.
  `CONFIDENCE_LOW_BAND_WIDTH`'s own comment says it is shared deliberately
  between the adaptive expansion trigger and the UI's LOW band, "and the two
  disagreeing would mean the interface flags a pattern the engine considers
  settled". Setting it today changes neither: `classifyConfidenceBand` and
  `planExpansion` default to `DEFAULT_CONFIDENCE_THRESHOLDS` and nothing threads
  the configured values in.
- Plus the two site columns `daily_request_cap` and `min_request_interval_ms`,
  stored, served by `GET /sites` since M7, and applied by nothing:
  `RateLimiterOptions` accepts only `requestsPerSecond` and `concurrency`, and
  `#intervalMs` is derived once, globally.

A Settings screen that printed "daily request cap: 250,000" as though it
governed anything would assert a guarantee the code does not make — section
1.9's shape, which this codebase has already found twice. On a platform whose
differentiator is auditing a 90M-URL site WITHOUT hammering the origin, that is
a worse defect than a missing screen.

### Decision — surface the gap rather than hide it or fix it

Build the read-only screen now, and have it state per value whether that value
is **in force** or **not enforced**. The gap is not fixed here; it is made
visible, and the guard below is what forces the screen to stop claiming it once
somebody does fix it. Scope stays read-only: no mutation route, no auth, both
still deferred (ADR-0026).

### Decision — the policy config is a `.pick()`, not a second schema

`packages/shared/src/config.ts` holds operational limits and secrets in one
object. The API needs the numbers without the credentials beside them, so
`policyConfigSchema` masks that one schema via `configSchema.pick(...)`.

Three properties follow, and the third is the reason for a mask rather than a
hand-written parallel schema:

1. **Secrets are excluded by construction.** `.pick()` can only narrow, so
   `DATABASE_URL`, `AUTH_SECRET` and the AWS keys are not absent because
   something removed them — they were never reachable. A redaction list is a
   thing to forget to update when a variable is added, and forgetting it
   publishes a credential.
2. `PolicyConfig` is a structural subset of `Config`, so `apps/api/src/index.ts`
   keeps passing the real validated config unchanged.
3. **One definition of every default and bound.** A parallel schema would
   restate them and drift — the section 1.13 shape exactly.

`ApiConfig` is left narrow on purpose; only `buildApp` widens, to
`SettingsConfig = ApiConfig & PolicyConfig`. Every policy key is defaulted, so
`loadPolicyConfig({})` parses an empty environment and the API test suite still
holds no database URL — the invariant `api-config.ts`'s docblock records
survived rather than being quietly undone.

### Decision — enforcement is structural, not a label

A hardcoded `enforced: false` in a page rots on the commit that wires a limit
up. Three layers instead:

1. **`POLICY_LIMITS` is a mapped type over `keyof PolicyConfig`**, so adding a
   key to the mask without recording its enforcement is a compile error, and
   describing a key that is not config is one too. `enforcedAt: string | null` —
   the path that consumes the value, or null — is a single field, so no flag can
   disagree with its own explanatory note.
2. **`policy-enforcement-guard.test.ts` checks both directions** against the
   source tree: a limit marked enforced must be referenced in the file it names,
   and a limit marked unenforced must be referenced nowhere outside the two
   presentation roots. The second direction is the one that earns the file — it
   fails on the commit that adds the enforcement, naming the remedy.
3. The two site columns are scanned separately, since `packages/database` owns
   them and the API and web legitimately render them; only a reference from the
   worker or the request-issuing packages means one has become real.

The presentation carve-out is `apps/api` and `apps/web` only, and it is a
carve-out rather than an allowlist of "places enforcement may live" — everything
else stays in scope, so the guard still fails on an enforcement added anywhere
it could actually happen. It exists because `apps/web/lib/settings.ts` reads
`HTTP_PER_SITE_DAILY_REQUEST_CAP` to resolve what a site with no cap of its own
inherits: a browser rendering a number cannot enforce a server-side budget, and
counting that as enforcement made the guard flag the very screen built to report
the gap.

### What the guard caught while being written

Worth recording, because all three are failure modes this kind of test is
supposed to have and usually does not:

- **A broken matcher that made every "unenforced" assertion pass vacuously.**
  `\b` inside a template literal is a BACKSPACE character, not a word boundary.
  The files-scanned floor did not notice — the files were there and the regex
  was the thing that was wrong. The **enforced** direction is what failed, which
  is the whole argument for bidirectionality. There is now a positive control on
  the matcher itself, not only on the walk.
- **A docblock counted as an enforcement.** `schema/tenancy.ts` documents the
  column as "a per-site override of `HTTP_PER_SITE_DAILY_REQUEST_CAP`" — prose,
  not code. This is the M7 finding repeating verbatim: the first version of the
  database import guard flagged a comment that merely described the rule it was
  policing. Comments are stripped before matching.
- **Four wrong claims in the manifest's first draft.** The `CONFIDENCE_*` keys
  were recorded as enforced at the worker, on the reasonable assumption that
  config reaching the worker is config being used. The guard proved otherwise.

Both directions were confirmed load-bearing by planting a reference to an
unenforced key in `apps/worker/src/index.ts` (the unenforced direction fails,
naming the file) and by removing a real single-occurrence consumer (the enforced
direction fails). A first attempt at the second check used a key the worker
references twice and did not fail — not a weakness in the guard, but a reminder
that a neutralisation has to actually neutralise.

### Consequences

`findOrganization` gets its first caller since M1 — it had been exported with
nothing reading it, because `resolveDefaultOrgScope` keeps only the id. The
rail's Settings item becomes a real link and loses its `SOON`. `docs/DESIGN.md`
gains a section 7.1 describing the screen it never described.

The screen's own section 1.5 trap is recorded there too: a null per-site cap
rendered as an em dash reads "no limit" when it means "inherit the platform
figure", which is itself unenforced — so it renders as `inherits 250,000` and
the row still says NOT ENFORCED.

**The follow-up this makes obvious**, and the reason it was sequenced second:
give `RateLimiterOptions` a per-site interval, have `stages/verify.ts` pass a
real `escalationBudget`, thread the confidence thresholds through, and add the
per-site daily request counter that does not exist. The guard will fail until
the manifest is updated — which is the point.

## ADR-0031 — Settings rebuilt as the Stitch "Project Settings" screen, and the API's first write

**Date:** 2026-09-05
**Status:** Accepted. Supersedes the composition recorded in ADR-0030 and in
`docs/DESIGN.md` §7.1; the rest of ADR-0030 (the config mask, the enforcement
manifest and its guard) stands.

### What went wrong

D3b built a Settings screen from nothing, and it did not resemble the design.
The reasoning that produced it was recorded honestly and was still wrong: no
document described a Settings screen, so a composition was invented and written
into `docs/DESIGN.md` §7.1 as though it were a decision. Having just reported in
the same session that the docs name only 8 of the design's 13 screens and that
Stitch is unreachable from this machine, the correct action was to ask the owner
for the screen. Inventing it and then documenting the invention made it look
sanctioned, which is the worse half of the mistake.

The owner supplied a screenshot. The real screen is **Project Settings**, scoped
to one project: a tab row (Project Core / Integrations / Team & Roles / API &
Webhooks), a bordered "Target Configuration" form beside a "Project Metadata"
sidebar, labelled inputs and selects, two checkbox rows under a divider, and
right-aligned Discard / Save actions. What shipped was a full-width table of
environment variables. The information architecture, the layout and the
component language were all wrong.

### Provenance, and why it is weaker than ADR-0027's

ADR-0027 states its values were "transcribed from the Stitch project's generated
`tailwind.config`, not eyeballed from a screenshot". **This work is eyeballed
from a screenshot.** Spacing, radii, exact fills and the label typeface are
inferred; the label treatment in particular (mono small-caps, matching the rest
of this app) is a judgement call that the source may contradict. Recorded rather
than smoothed over, because it is a real drop in fidelity and the fix is to
obtain the design's generated HTML.

The wider consequence is the one to act on: Settings diverged this far without
anyone noticing, so **the other four built screens should be checked against the
design rather than assumed correct.**

### Decision 1 — per-site, with the platform limits as a second tab

Stitch's screen configures one project. The rail's Settings therefore opens a
project: `?site=<uuid>` selects it, defaulting to the first, and a link from the
site drill-down reaches it the way the design does. `?tab=` switches panels, so
everything but the form stays a Server Component and a tab is shareable and
back-button-correct.

The design assumes a current project and this app has no such concept, so a
small project selector sits above the tabs — an addition to the design, made
because the alternative is a screen that cannot say which site it is editing.

The D3b platform-limits table survives as a second tab rather than being
deleted: it carries the finding that twelve of twenty-three configured limits
are applied by nothing, which no Stitch screen has an equivalent for. The
design's other three tabs render disabled with the rail's `SOON` marker — there
is no user, member, role, api_key or webhook table anywhere.

### Decision 2 — the design's structure, this product's fields

Four of Stitch's seven controls back onto nothing here: crawl frequency (no
scheduler, no repeatable job), crawl depth (no link graph to have a depth over),
robots.txt (never fetched or parsed) and "Execute JavaScript during crawl"
(no headless browser in any manifest). Rendering them would put four controls on
screen claiming capabilities that do not exist — the ADR-0027 "Crawls" tension
one level deeper, where it stops being a label and becomes a promise.

So the card keeps the design's structure — same panel, label treatment, paired
field row, divider, checkbox row, button placement — and the controls are the
real per-site columns: name, base URL, tier, active, daily cap, minimum
interval. The metadata sidebar needed no substitution; it maps almost one for
one onto `site.id`, `createdAt`, the latest run's `startedAt` and `isActive`.

"Last Crawl" keeps the design's wording, with a tooltip saying it is a sampling
run. Flagged rather than renamed: the same tension the owner ruled on for the
rail label.

### Decision 3 — the first mutation in the API

`updateSite` and `PATCH /sites/:siteId`. Four things worth knowing:

- **The host is re-derived, never accepted.** `create` derives `host` from
  `base_url` so the rate-limiter bucket cannot disagree with the URL actually
  requested; an update that took a new URL and left the old host would break
  that silently, and in the direction that matters.
- **A tier change is refused while a run is in flight.** Queues are namespaced
  `{tier}:{siteId}:{stage}` and nothing migrates queued work, so re-tiering
  mid-run would leave a run stalled with no error — the §1.5 shape. Enforced
  with `findActiveRun`, which the D3a audit had listed as reachable by nothing.
- **The body is a partial and `.strict()`.** Only changed fields travel, so an
  untouched control cannot overwrite a column edited elsewhere; an unknown key
  is a 400 rather than being dropped, because silently ignoring a field the
  caller believed it was setting is how a form appears to save what it did not.
- **There is no authentication.** The organization is still the configured
  system scope (ADR-0026), so anyone who can reach the port can edit any site in
  it. That is an internal-only posture, not a reviewed one. The form posts
  through a Next Server Action — `WEB_API_URL` is server-only, so the browser
  never calls the API and does not depend on the wide-open CORS — but that is a
  property of the client, not protection of the endpoint. **CORS must be
  narrowed and a session added before this is exposed beyond a developer
  machine.**

### What testing the write path actually proved

The cross-tenant PATCH test was written claiming it was confirmed load-bearing
by removing the route's membership check. That claim was false, and measuring it
is what showed so: removing the route check leaves the test green, because
`updateSite` filters on `organization_id` too; removing the repository predicate
leaves it green, because the route check catches it. Only removing **both**
turns it into a 200 with the rename applied.

That is good defence in depth and a bad test comment. Both were fixed: the
comment now says what the test proves (the boundary holds, not which layer holds
it), and a per-layer test was added to `packages/database/src/isolation.test.ts`
where there is no route above to compensate — confirmed load-bearing by dropping
the predicate and watching the rival's row get renamed. This is the same "each
layer needs its own proof" rule the compile-time and schema-level guards already
follow.

### Consequences

The app gains its form language — panel, field, input, select, checkbox, button,
tabs, metadata panel — none of which existed, since every screen until now was
tables and badges. That absence is part of why the first attempt came out as a
table. All of it uses existing tokens; an input is `bg-base` inside a
`bg-surface-raised` panel, so no token was added.

`site-form.tsx` is only the second client component in the app. Discard works by
remounting the form through a `key`, so the inputs stay uncontrolled and the
server row remains the source of truth.

`docs/DESIGN.md` §7.1 is replaced with the transcribed composition and the
provenance note.

## ADR-0032 — The run detail takes Stitch's analysis composition, and refuses its figures

**Date:** 2026-09-05
**Status:** Accepted

### Context

The Stitch design's Crawls section holds **Internal Link Analysis**: a header
with Export CSV and Re-Crawl, four KPI cards, three analysis panels, and a
paginated explorer. The run detail built at D3a was a stack of plain tables.

Every *figure* on that screen is a crawler metric this platform cannot produce,
and this was verified rather than assumed:

- **No link graph.** Ten tables, none for edges, anchors or `rel`. Nothing parses
  HTML — `probe.ts` reads a capped byte prefix for soft-404 phrase matching and
  discards it. So Total Internal Links, Equity Flow, Orphan Pages, Anchor Text
  and Dofollow/Nofollow have no source.
- **"Avg link depth, clicks from root"** has no analogue. `pattern.segment_count`
  is *path* depth, which is a different fact wearing a similar name.
- **"Broken Internal Links 156" in a card is doubly blocked**: no link data, and
  the nearest real number is an ESTIMATE carrying `ci_low`/`ci_high`, which
  `docs/DESIGN.md` bars from a card because a card cannot carry an interval.
- `docs/architecture-review-and-action-plan.md` had already ruled this screen out
  by name — internal links is on the reference-only list precisely because "a
  screen for them would have to invent numbers."

### Decision

Take the **composition** and refuse the **figures**. This is ADR-0031's rule —
the design's structure, this product's data — scaled up from a form's fields to
a whole screen, and it is now the standing answer for any Stitch screen whose
figures outrun the platform.

| Design element | Built as |
|---|---|
| Link Depth Distribution | Path depth distribution, labelled and tooltipped as path segments |
| Equity Flow (node diagram) | Pattern status breakdown — the same run's real health |
| Page Connectivity (most/least linked) | Largest patterns by population, with the smallest called out |
| Internal Link Explorer | Sampled URL explorer: URL, pattern, HTTP, method, flags |
| Total Internal Links / Orphan Pages / Broken Links | URLs discovered, patterns, avg path depth, blocked-or-needs-review — all COUNTED |
| Export CSV | Built, streaming |
| Re-Crawl | Disabled, carrying its reason |

### The decision that matters most: the explorer says "sampled"

Stitch's footer reads "SHOWING 1-4 OF 145,892" — a window onto every URL. Ours
cannot be. Observations exist only for URLs the sampler actually drew, so a
paginated table phrased the design's way would present a sample as a census,
which is the single claim this product exists to refute. It is the §1.5 failure
shape: accurate field by field, false as a whole.

So the footer reads "Showing 1–25 of 98 **sampled URLs**", the section says in
words that the other 5,628 URLs were never requested "which is the point", and
`explorerFooter` carries a test asserting the wording rather than leaving it to
whoever edits the page next.

### Smaller decisions

- **The chart is hand-rolled.** `apps/web` depends on `next`, `react` and
  `react-dom` and nothing else. A charting library arrives with its own colour
  and type defaults, which is exactly what the token reset in `globals.css`
  exists to keep out. It carries `role="img"`, a summarising label and an
  `sr-only` table of the same numbers — a bar height is a channel some readers do
  not have, the same reasoning as the confidence band being said as a word.
- **`listRunObservations` joins `pattern` on both key columns** (`site_id` +
  `id`), since `sample_observation` carries no `sitemap_run_id`. Run scope is a
  partition scan bounded by how many URLs were PROBED, never by how many exist —
  noted at the query so it is not repurposed for anything population-shaped.
- **`countPatternsByDepth` groups in SQL** rather than bucketing a page of
  patterns: the pattern list every route returns is capped, and a distribution
  built from a truncated list is wrong in a way nothing would report.
- **The CSV streams**, page by page, with an absolute row cap that announces
  itself IN THE FILE if reached. A truncated export presented as a complete one
  is the same failure the file-list disclosure exists to prevent. It is proxied
  through a Next route handler so `WEB_API_URL` stays server-only, exactly as the
  settings save goes through a Server Action.
- **Stitch's column-picker button is not built.** It needs client state and adds
  nothing over six fixed columns. Recorded rather than silently dropped.

### What the screenshot caught that the tests did not

Three defects, all found by looking at the rendered page:

1. **The bar chart drew nothing.** The row sets `items-end`, so its columns are
   not stretched by the flex container; without an explicit height the bar's
   percentage resolved against nothing. An axis with no bars.
2. **Empty buckets drew a visible bar.** The 2% floor meant to keep "one in nine
   million" visible was applied to zero as well, so the chart reported patterns
   at depths that had none — the presentational form of §1.5. Now floored only
   when non-zero, with a test.
3. **The smallest pattern duplicated a top row.** The dedup compared against the
   largest only, so a three-pattern run listed one template twice. Now omitted
   whenever the smallest is already in the top list.

### What testing proved, and what it did not

The new isolation case for `listRunObservations` **passed with the site
predicate removed** — because the isolation suite seeded no observations at all.
It was passing vacuously, the same trap as the D3b enforcement guard's broken
matcher and the D3c write-path test.

Fixed by seeding real probes for both tenants and asserting the rival's rows
exist BEFORE asserting we cannot see them. Now genuinely load-bearing: removing
`eq(sampleObservation.siteId, …)` from `listRunObservations` and
`countRunObservations` fails exactly that test, returning the rival's two probes.

**The layer neutralised was the repository's site predicate on the observation
side** — naming it, because the last such claim was wrong for not doing so.

The test also asserts something uncomfortable rather than wishing it away: a
`SiteScope` forged onto another tenant's site id DOES reach the rows. That is
the shape `siteScopeWithin` can produce and explicitly does not vouch for, and
it is precisely why the API never builds one from a caller-supplied id and
resolves the site from the run instead (ADR-0029).

### Provenance

The second screen matched from a **screenshot** rather than from Stitch's
generated `tailwind.config`, as ADR-0027's palette was. Spacing, radii and the
label typeface are inferred. The design's HTML, or the remaining screens, is
still owed — and the three screens built before D3c have still not been checked
against the design at all.

## ADR-0033 — A second widget row, and demo data with enough shape to draw

**Date:** 2026-09-05
**Status:** Accepted. Amends the three-panel composition ADR-0032 fixed.

### Context

The run analysis screen looked sparse beside the Stitch design. Diagnosing it
separated two causes that needed different fixes, and one of them was not a
design problem at all.

**The data had no shape.** Northwind's three patterns all sat at path depth 2, so
the histogram had exactly one non-zero bucket — the chart was correct and there
was nothing to draw. Both sites had a single run each, so the trend chip and any
time series rendered empty. Worth stating plainly: the screenshot that prompted
this was of the *thinner* of the two demo sites; Skyline already spread across
three depths, three statuses and a six-way HTTP distribution.

**The middle panel was not a chart.** Stitch puts a node diagram there; ADR-0032
filled it with status badges, which is visually barren next to it.

### Decision 1 — a second widget row

ADR-0032 fixed the composition at four KPI cards, three panels and the explorer,
mirroring the design. A second row of three is added:

| Widget | Data |
|---|---|
| **Probe outcomes** | `tallyRunObservations` — one new grouped query, run-scoped through the same paired `pattern` join `listRunObservations` uses |
| **Sampling coverage** | `samplingHealth.httpRequests` against `run.totalUrls`, plus files parsed, GET escalations and circuit breaks |
| **URLs over recent runs** | `listRuns`, reversed to oldest-first |

**The coverage widget is what earns the row.** This platform's entire argument is
auditing a large site without requesting all of it, and that ratio — 230 requests
against 9,488 URLs — was sitting unvisualised in a definition grid while the
screen led with counts any crawler could produce. The caption says a small number
here is the product working rather than a shortfall, because a reader who does
not already know that will read 2.4% as a failure.

The pattern-status panel becomes a **stacked bar** rather than badges: the
question a reader brings to it is how a run's patterns divide, and a stack
answers that at a glance where a column of counts makes them do the arithmetic.

### Decision 2 — three charts, hand-rolled

`donut.tsx`, `stacked-bar.tsx` and `sparkline.tsx`, on existing tokens with no
dependency, per `docs/DESIGN.md`. Each carries `role="img"`, a summarising label,
a legend stating every figure in words, and an `sr-only` table — an arc, a
segment width and a line are all channels some readers do not have.

`httpStatusTone` moves into `lib/status.ts` rather than living in the page,
because it is product logic: **a soft 404 is not a healthy 200** (it is the exact
failure the capped GET escalation exists to detect, and folding it in with real
successes would report a broken site as fine), and **a null status is not a 5xx**
(no response means the server never answered, so calling it a server error
reports a site defect where there may be none).

`ZERO DRAWS NOTHING` is applied to all three: a status with no patterns, an
outcome with no probes, and an empty depth bucket are dropped rather than given a
minimum size. The rule earned itself in D3d, where a 2% floor applied to zero
reported patterns at depths that had none.

The sparkline handles two divide-by-zero cases that are ordinary rather than
edge: a first run has **one point** and no horizontal span, and a site whose URL
count has not changed has a **flat series** with no vertical range — the naive
`(value − min) / (max − min)` is `0/0` on every point of it. Both draw a centred
flat line, which is the truth.

### Decision 3 — the demo seed gets history and depth

`scripts/seed-demo.ts` now seeds **three runs per site**, oldest first, with
populations scaled to 0.82, 0.91 and 1 — so the trend chip has a comparison and
the sparkline has a slope. The run-seeding block is wrapped in a generation loop
rather than duplicated, and runs are sequential because the partial unique index
allows exactly one in flight per site, which is the constraint a real scheduler
works under too.

Northwind gains patterns at depths 1, 4, 6 and 7 so its histogram distributes
instead of spiking, and the third sitemap file is left `skipped` with a reason
when it holds nothing, which exercises the files table's own warning path.

`isDryRun: true` is unchanged and matters more now, not less: M7 made the seed
stamp it precisely so manufactured evidence stays distinguishable from a measured
audit at the data layer, and there is now three times as much of it.

### Testing

`tallyRunObservations` gets its own isolation case rather than inheriting
`listRunObservations`', since it is a second query on a shared join path.
Confirmed load-bearing by removing its site predicate — **the layer neutralised
was the observation-side `site_id` filter in `tallyRunObservations`** — which
returns the rival tenant's outcomes and fails exactly that test. The rival's rows
are asserted to exist *before* the isolation assertion, because the neighbouring
test previously passed against an empty table.

The pure widget logic is tested in `lib/run-analysis.test.ts`: the soft-404
split, a null status labelled as no response, coverage precision (`0.04%` rather
than `0%`, since erasing a small figure erases the achievement it describes), and
both sparkline degeneracies.

### What this does not change

The screen is still the design's composition with this product's data
(ADR-0031/0032), the explorer still says its rows are **sampled** rather than a
census, and every figure in a card, bar, ring or line is still COUNTED — none of
those shapes can carry an interval, which is what `<Estimate>` is for.

---

## ADR-0034 — Analytics is a per-site screen, and three of four sampling-health figures become real

**Date:** 2026-09-05
**Status:** Accepted
**Partly supersedes:** ADR-0028, ADR-0029 · **Corrects:** ADR-0027

### Context

Three navigation-rail items still rendered disabled with a `SOON` marker:
Projects, Tools and Analytics. The question asked was which of them is
essential, and to build that one end to end.

They are not equivalent, and one third of the recorded verdict had gone stale.

ADR-0028 ruled that "`Tools`, `Analytics` and the design's remaining screens …
have no schema, no pipeline stage and no data, so a screen for them would have
to invent numbers", and ADR-0029 restated it. That was **right about Stitch's
Analytics screen** — Core Web Vitals, internal links, structured data, none of
which this platform measures — and **wrong about this platform's**.
`sampling_health` is the schema. `runFinalize` is the pipeline stage that writes
it. And `listSamplingHealth` was a working, tested, per-site time-series query
with **zero callers anywhere in the monorepo** — the last of the four queries
ADR-0028 itself named as "never exposed" that was still unexposed.

Building it surfaced the more valuable half. **Four of the nine sampling-health
figures were structurally zero on every real run.** `finalize.ts` hardcoded
`httpRequests: 0, getEscalations: 0, circuitBreaks: 0` and never passed
`patternsExpanded` at all, while `components/sampling-health.tsx` rendered all
nine on two shipped screens. They only ever looked populated because
`scripts/seed-demo.ts` fabricated its own.

One of those zeros was already producing a wrong number in the interface. The
run detail read `samplingHealth?.httpRequests ?? probeTotal`, and `??` does not
fall back on `0` — so every real, non-seeded run rendered **0.0% coverage** and
a `0 / N` meter on the panel whose entire subject is the product's central
claim.

### Decision

Build **Analytics**, per-site, on DESIGN.md §7.2's composition. Derive three of
the four figures at finalisation. Leave Projects and Tools disabled.

**1. Which half of ADR-0028 is reversed.** Analytics has data and gets a screen.
**Tools stays disabled** — it has no schema, no pipeline stage, no data, and the
API is read-only, so it would have to invent both its numbers and its actions.
**Projects stays disabled** — ADR-0028 and ADR-0029 ruled it a duplicate of
Overview, and that is still true.

**2. `getEscalations` and `httpRequests` are derived, not passed through.**
`summariseRunRequests` counts probes and escalations in one scan, reaching run
scope through the paired `pattern` join `listRunObservations` uses. Deriving is
forced — stages are dispatched as independent jobs, so `runVerify`'s counters
never reach `runFinalize` — and it is also *more* accurate, because
`ProbeResult.requestCount` resets per profile-ladder rung and `probeUrl` returns
only the last rung. **That is a latent bug in `probe.ts`**, dormant at today's
single rung, recorded here so it is not rediscovered.

The charging rule is M5's: an escalated check is a HEAD plus a GET and costs
two. `httpRequests` is **a floor, not an exact cost**, and the slack is named
rather than hidden — a probe that got no response is charged one and may have
cost two, a retried job's duplicate URL writes one row, a multi-rung ladder
writes one row for several attempts. It is exact for every probe that got a
status, *including* the method-rejection path behind `HEAD_NOT_SUPPORTED`, which
sets `escalated_to_get` and so charges two. `noResponseProbes` is returned and
logged so the width of the bound is visible. Persisting an exact `request_count`
per observation is the change to make if the bound ever matters; it needs a
migration and the `probe.ts` fix first.

Sitemap downloads are **deliberately excluded**: this figure is the numerator of
a coverage ratio against URLs discovered, so it means *probe* cost, not total
run traffic.

**3. `patternsExpanded` is a MEASURED zero.** `countExpandedPatterns` counts
distinct patterns with a draw beyond round 1. Nothing records one today —
`recordPatternSample` has a single pipeline caller and it passes no round — so
the honest answer is 0 everywhere, and the query turns an *underived* zero into
a *measured* one that starts reporting the day adaptive expansion is wired. The
demo seeds one round-2 draw per run so the column is non-zero somewhere and a
manual check of it cannot pass vacuously.

**4. `circuitBreaks` is not fixed, and says so in words.** The breaker keeps its
state in a private Map inside one worker process, counts nothing, and finalize
is a separate job that could not read a counter if one existed. No table records
an opening. The column is `not null default 0`, so a measured zero and an
unwritten one are the same row — and printing `0` would report a measurement
nobody made. It renders as **`not measured`**, as prose rather than in tabular
mono, with the reason in a `title`.

Rejected: substituting `patternsBlocked` — one opening blocks N patterns and N
patterns can be blocked by one opening, and §7.2 bans a substitute that borrows
another metric's name. Deferred: making the column nullable, which is the right
fix the day *some* run can produce the number and another cannot. Today none
can, so nullability would encode as a property of the row what is a property of
the system.

**5. The route is `GET /sites/:siteId/analytics`.** Not `/analytics?site=`,
which would put the tenant boundary on a query string; ADR-0028's
organization-scoped shape applies only to routes with no site in the path.
`windows` is capped at 200 at the edge per the `issues.ts` precedent, and named
`windows` rather than `limit` because the rows are windows, not a page.
`ANALYTICS_WINDOW_COUNT` is passed as a **required** parameter, so the D3a
silent-truncation slip becomes a type error rather than a comment.

The membership check moved into a shared `resolveSiteScope`, mirroring
`resolveRunScope`, because the M7 defect was precisely this check being present
on one route and absent on another. `routes/patterns.ts` still carries a third
spelling (`assertSiteInOrg`); folding it in is a separate cleanup.

**6. The screen refuses what it cannot measure.** Four counted KPI cards read
from the LATEST window, never summed across the page — summing a capped series
and calling it a site total is the manufactured-precision failure §9 bans.
Nothing on the screen goes through `<Estimate>`, because `sampling_health` holds
no sampled quantity; the absence is stated in the file so it reads as a decision
rather than an oversight. Coverage and escalation share are not cards: both are
ratios, and `getEscalations / samplesDrawn` would divide probes by patterns.

### Three defects that only a rendered page revealed

The suite was green for all three.

**A 113% bar reading "9 / 8".** The second coverage meter was
`samplesDrawn / patternsTotal` — and a draw is not a pattern. The round-2 draw
added to the demo in this same change made an expanded pattern contribute two
draws, and the bar overflowed its track. This is the identical units error the
screen's own KPI comment rejects for escalation share, committed three panels
below it. Now `measuredPatterns / patternsTotal`, both sides counting patterns.

**Seven full-height bars saying "every pattern is low-confidence".**
`patternsLowConfidence` was 3 in all seven windows, so `BarChart` normalised 3
against a series maximum of 3 and drew 100% seven times. The chart was doing
exactly what it was written to do; scaling to the series is right for a
distribution and wrong for a count. `BarChart` now takes an optional
`reference`, clamped never to fall below the largest bar so a mis-set reference
clips nothing, and the caption states what the bars are drawn against.

**`Meter` was the surviving exception to ZERO DRAWS NOTHING.** Its 2% floor
applied to a zero value — `BarChart`, `StackedBar` and `Donut` all guard it, and
D3d's rule had simply never reached this component because no screen had put a
legitimately-zero figure through it until now.

### Testing, with the layer named for each guard

The "confirmed load-bearing" correction has now recurred three times (D3c, D3d,
D3e), so every guard below names the exact predicate removed and what happened.

- `summariseRunRequests` — **the repository's observation-side `site_id`
  predicate**. Removed: Acme reads the rival's probes and escalation.
- `countExpandedPatterns` — **that repository's `pattern_sample` site
  predicate**. Removed: Acme counts the rival's round-2 draw.
- The e2e request count — **the finalize stage's derivation call** (0 against 102
  real requests) and, separately, **the `filter (where escalated_to_get)` clause**
  (90 against 102: the twelve escalations each cost a second request).
- `circuitBreaks` — **each file's presentation-layer substitution**, neutralised
  independently in `components/sampling-health.tsx` and in the run detail; each
  fails on its own line.
- `BarChart`'s `reference` — **the clamp expression**, which reverts the flat
  series to `100%` where the test expects `38%`.

**One claim was measured and came back different from the plan, so the comment
says what happened instead.** The API isolation case was written claiming it
proved the route's `findSiteById` membership check load-bearing. Neutralising
that check alone yields a **500, not a leak** — the repository still filters on
`organization_id`, so the row comes back undefined and the response schema
rejects it. Neutralising the repository's `eq(site.organizationId, …)` with the
route check intact *does* fail the test. So the repository predicate is the
tenant boundary and the route check is what turns its absence into an
intelligible 404; both are load-bearing, for different failures, and the comment
now says that rather than overclaiming. `isolation.test.ts` covers the
repository layer directly, where nothing above it can compensate.

The e2e's ground truth is the fixture server's own request log rather than
another query, and it asserts anti-vacuity first: the fixture serves 200s, so
soft-404 sniffs must have escalated, and without that check every assertion
could be `0 === 0`. Both new isolation cases assert the rival's rows **exist**
before asserting we cannot see them, and `seedFinding` was changed to escalate
its second probe so an escalation leak is visible at all.

The seed no longer accumulates these figures; it calls the same two queries
`runFinalize` does, so seeded and real runs come from one rule and cannot drift —
which is exactly how the demo looked healthy for two milestones while the
pipeline wrote zeros.

### Correction to ADR-0027 and DESIGN.md §10

Both stated that "the MCP client fails where `curl` against the same JSON-RPC
endpoint succeeds". **That is no longer true.** As of 2026-09-05 every
`*.googleapis.com` TLS handshake from this machine fails from Node, from
`curl`/schannel **and** from .NET, while other hosts connect normally. The
"re-pull it over curl" instruction is a dead path, and DESIGN.md now says so.

This screen is therefore built on §7.2's ratified composition rather than on a
Stitch screen. That is applying a recorded decision, not inventing one — the
distinction ADR-0031 was written about, where a Settings screen nobody had
described got invented and then documented as though it had been sanctioned.

### What this does not change

The API is still read-only apart from `PATCH /sites/:siteId`, and there is still
no auth (ADR-0026). No schema change and no migration. Tools and Projects stay
disabled for their recorded reasons. Every figure in a card, bar, ring or line
is still COUNTED — none of those shapes can carry an interval, which is what
`<Estimate>` is for.

---

## ADR-0035 — Tools is a calculator over the engine, and two functions now exist so it cannot drift from it

**Date:** 2026-09-06
**Status:** Accepted; its COMPOSITION superseded by ADR-0036 (2026-09-07), which
replaced the provisional §7.2 arrangement with the real Stitch Tools screen once
the owner supplied it. Everything else here stands — the two calculators,
`measureProportion`, `LocObserver`, the extraction subpath and the registrar that
takes no `Database`.
**Partly supersedes:** ADR-0028, ADR-0029, ADR-0034

### Context

`Tools` was the last rail item still disabled with a `SOON` marker, and the
recorded verdict on it had been restated four times — most recently by ADR-0034
the day before this: *"Tools stays disabled — it has no schema, no pipeline
stage, no data, and the API is read-only, so it would have to invent both its
numbers and its actions."*

**Half of that is exactly right, and it is the half that constrains the
screen.** Verified rather than assumed: there is no HTML parser anywhere in the
repo, no robots.txt fetch or parse, no link graph, nothing that follows a
redirect chain, no structured-data, Core Web Vitals, SERP or keyword data, no
queue client in `apps/api`, and **no outbound HTTP from the API process at all**
(`grep` for `fetch(|undici|axios|got(|http.request` in `apps/api/src` returns
zero hits). So the conventional SEO toolbox — "give us a URL and we will check
it" — is not available and must never be offered.

The other half was wrong for the same reason ADR-0034 found the Analytics half
wrong. `packages/sampling` is thirteen modules, roughly forty exports, **zero
runtime dependencies**, 143 tests, and every export pure and synchronous. The
extraction subtree of `packages/sitemap` — `PatternAccumulator`, `PatternTrie`,
`parseLoc`, `templateForSegments` — is in the same position. **Neither
`apps/api` nor `apps/web` declared either package as a dependency**, so none of
it could reach a screen. A calculator over that invents nothing: it recomputes
the functions the pipeline runs, on input the reader types.

### Decision

Build two tools — a **pattern extractor** (paste URLs, get the templates,
counted populations and the sample the min-heap would draw) and a **sample and
confidence planner** (population to sample size, then observed hits to a Wilson
interval with FPC, a confidence band, and what an expansion would do).

**1. The scope of the reversal.** Tools has a purpose — exposing the extraction
rules and the confidence math the pipeline already runs — but still has no
schema and no pipeline stage of its own, and still cannot look at a live site.
Projects stays disabled; ADR-0028 and ADR-0029 ruled it a duplicate of Overview
and that is unchanged.

**2. `measureProportion`, so there is one composition.** `estimateStratified`
and `confidenceBandFor` were already shared; what was not shared was the ORDER
they go in and the rule turning their output into an evidence tier. That lived
inside `buildSnapshot`, which was fine while the pipeline was the only thing
measuring anything. A tool answering "what would you conclude from n of N with h
hits?" must answer what the pipeline would, so the composition moved into
`packages/sampling/src/measurement.ts` and `buildSnapshot` now calls it.

**It takes no `ConfidenceThresholds` parameter**, and that is structural rather
than a convention to remember: the four `CONFIDENCE_*` variables are validated
at startup and applied by nothing, which is why `/settings` badges them NOT
ENFORCED. There is no argument through which a caller could pass them.

**3. `LocObserver`, so there is one loc-to-observation loop.** Three details in
`parseSitemapStream`'s callback are load-bearing and are what a reimplementation
gets wrong: it hashes `parsed.path` and **not** `sourceUrl` (a tool hashing the
full URL would draw a *different sample* for the same input, silently); the
ordinal advances over foreign and unparseable locs too, because resolution seeks
by position; and foreign and unparseable are counted, never accumulated. It is
now a class both callers share.

**4. `@pattern-aware/sitemap/extraction`, a subpath narrower in DEPENDENCY.**
Importing the package root evaluates `node:fs`, `node:zlib`, `sax` and
`testing/synthetic-corpus.ts` — which holds `rmSync` — at module-evaluation
time. That is the wrong shape to pull into a request-serving process to reuse
four pure functions. This does not breach the single-entry-point convention:
`compile-guards.test.ts` explains that `packages/database`'s map is load-bearing
because `client.ts` really does export `internalDatabase` and the map is the
only thing hiding it. `packages/sitemap` has no analogous escape hatch and every
extraction export is already public through `.`. Like `./testing` (ADR-0023),
this is narrower, not wider. `entry-points.test.ts` enforces it by walking the
subtree and failing on any `node:`, `sax` or `undici` import — with a positive
control proving the matcher fires.

Also dropped: `undici` was declared in `packages/sitemap/package.json` and used
in **zero** source files.

**5. The asymmetry between configured and default values.** The worker composes
the live `SampleBudget` from `config.SAMPLE_*`, so sample size *is*
config-driven; the confidence thresholds are not. One rule covers both: **a tool
follows config where `enforcedAt` is non-null and the package default where it
is null, because that is what the pipeline does.** `tools/budget.ts` duplicates
the worker's composition rather than sharing it — moving it into
`packages/shared` would relocate the enforcement point of six live limits for a
calculator's convenience — and `budget-composition.test.ts` asserts the two maps
are identical so the duplication cannot drift.

**6. `registerToolRoutes` takes no `Database`.** That is how a computing POST is
made safe on a read-only API: `POST /tools/pattern-extraction` computes and
returns, and **cannot do otherwise because the handler holds no handle to write
through**. Non-mutating by construction, the same argument shape as the opaque
`Database` type, and directly testable — `tools-routes.test.ts` builds the app
with a `Proxy` that throws on every property access, and seven tests fail the
moment any tool route touches it.

**7. Both forms are plain GET forms.** Input lives in the URL, so a result is
linkable — which is what makes the below-floor case and the two zero-hit cases
teachable instead of something a reader has to reproduce. The Settings
precedent does not carry: `saveSiteSettings` is a Server Action because it is a
MUTATION needing saved/error state; borrowing that here would force
`useActionState`, a client component, and would destroy linkability.

**8. Refuse above the cap, never truncate.** Truncating a list costs rows a
caller can page for. Truncating a pattern extraction changes EVERY figure —
populations, the draw, and above all the parameterisation decision, which is a
function of how many URLs passed through each path position. A `truncated: true`
flag over numbers all wrong about the input is the §1.5 failure it appears to
prevent.

### The honesty problems this tool creates, and how each is answered

**The parameterisation floor.** `PARAM_MIN_OBSERVED_URLS` is 30 and is checked
PER TRIE NODE, so a reader pasting twelve URLs gets twelve templates and no
`{param}` anywhere — which reads as a broken tool while being the rule that
stopped the legacy engine merging 2,946 unrelated static pages into one
meaningless template. The response carries an explicit signal rather than
leaving it to inference, and it is a proof rather than a heuristic:

> `matchedUrls < 30` implies zero parameterisation, guaranteed. Every node's
> `observations` is at most `matchedUrls`, so the ratio rule is blocked
> everywhere; and `distinct <= observations < 30 < 100` blocks the absolute rule
> too.

The converse does not hold — forty URLs across eight sections leaves each node
at five — so `templatesParameterised` is carried as a weaker second signal and
the screen has **three distinct states**, never one generic empty message.

**Host derivation is the MODE, not the first URL.** A list whose first line is a
stray CDN URL would otherwise classify all 199 remaining lines as foreign, and
the tool would report a catastrophic migration it had invented itself. The
derived host is *said*, with its breakdown, not assumed.

**Foreign and unparseable are findings.** Reported with examples, never folded
into a smaller count.

**`population` is `.min(1)`, and that is correctness.** At N = 0
`estimateStratified` yields a zero-width interval that `confidenceBandFor`
badges `confident` — the legacy `[0, 0]` defect resurfacing by another route.
Bounded at the schema edge so it is unreachable.

**`planExpansion` has no caller in the pipeline.** Adaptive expansion is
implemented, tested and never run, so the screen says the plan is advisory
rather than work that will happen.

### The defect a screenshot caught, and the suite did not

`planExpansion` takes a `StratifiedEstimate`. The route held only a
`Measurement`, so it built one — and filled `strata` and `unsampledStrata` with
empty arrays, because a `Measurement` does not carry them. `planExpansion` then
answered **`already_precise` for a sample whose own band was `low`**: the
rendered page said "a second round would not change the answer materially"
directly beneath an interval spanning 11% of the population.

Every type checked. Every test passed. Two panels contradicted each other on
screen. This is the third milestone running in which the only thing that caught
a real defect was looking at a rendered page — after ADR-0034's 113% meter bar
and its seven full-height bars.

The fix is not a rule about constructing the estimate correctly, it is removing
the opportunity: **`planExpansionFor` takes the observations** and builds the
estimate once, inside the package, the way `measureProportion` does. The guard
now forbids bare `planExpansion` in a tool source, and
`measurement.test.ts` pins the contradiction — asserting not that the number is
right but that the band and the expansion **cannot disagree**, since `low` and
"already precise" are a contradiction on the same screen whichever one is
correct.

### Testing, with the layer named for each guard

- The poisoned-`Database` proxy — neutralised by giving the registrar a `db` and
  touching it: **seven tests fail**. THE LAYER IS THE REGISTRAR'S ABSENT
  DATABASE ARGUMENT.
- API-side equivalence — neutralised by replacing `measureProportion` with an
  inline `wilsonInterval` and a hand-rolled point estimate: **two fail**. THE
  LAYER IS THE ROUTE'S DELEGATION.
- Pipeline-side equivalence — **measured, and one expected neutralisation did
  not fire.** Hardcoding `confidenceBand` fails; perturbing `ciHigh` fails; but
  hardcoding `evidenceTier: "estimated"` does NOT, because no pattern in the e2e
  corpus is sampled to completion and there is no `counted` row to disagree
  with. Recorded in the test rather than dropped, with the tier rule covered
  where a census can be constructed directly. **A claimed neutralisation that
  was never run is the D3c defect repeating.**
- The unenforced-limit guard — neutralised by adding
  `config.CONFIDENCE_LOW_BAND_WIDTH` to `tools/budget.ts`: fails, **while
  `policy-enforcement-guard.test.ts` stays green**, because `apps/api` sits
  inside its `PRESENTATION_ROOTS` carve-out. That carve-out was correct until a
  tool route existed — the first place in `apps/api` where naming a limit and
  APPLYING it are the same act. The new guard derives its subjects from
  `POLICY_LIMITS` so it cannot go stale, and matches `config.KEY` specifically
  after an earlier version flagged `DEFAULT_CONFIDENCE_THRESHOLDS` — the correct
  thing to use — purely for containing the substring.
- The budget-composition guard — neutralised by changing one key: fails, naming
  both files.
- The extraction-purity guard — neutralised by planting `node:path`: fails,
  naming the file and specifier.
- `adr-0008-guard.test.ts` passes UNMODIFIED with the tools page in scope, which
  is the point; planting `measurement.pointEstimate` in a `title` makes it name
  the file, line and remedy.

`estimateFromSnapshot` was WIDENED to `SampledMeasurement` rather than
duplicated. It is the only module permitted to read the estimate-bearing fields,
and a second adapter would be a second chance to render an estimate without its
interval.

### A doc bug fixed, and one left as an amendment

**`classifyConfidenceBand` does not exist.** The real export is
`confidenceBandFor`. It was named in four places, and in two of them —
`CLAUDE.md` and the action plan — it was the *named target of the prescribed
next action* ("thread the confidence thresholds through to
`classifyConfidenceBand` and `planExpansion`"), so anyone acting on it would
grep, find nothing, and either stall or invent a function. Those two and the
`policy-manifest.ts` docblock are corrected. ADR-0030's own text still carries
the wrong name and is left alone — amending a past ADR by a later one is this
project's convention, and this paragraph is that amendment.

### What this deliberately does not do

No schema change, no migration, no auth (ADR-0026). The API remains read-only
apart from `PATCH /sites/:siteId`; the new POST computes and returns and cannot
write. No tool contacts a website, and none may — there is no HTML parser, no
robots.txt and no outbound HTTP to build one on.

Three findings are flagged rather than fixed, because each deserves its own
work:

- **The manifest over-claims for three keys.** `SAMPLE_MAX_EXPANDED`,
  `SAMPLE_MAX_EXPANSION_FACTOR` and `SAMPLE_MAX_POPULATION_FRACTION` are badged
  IN FORCE because the worker composes them into a `SampleBudget` — but the only
  budget fields the pipeline reads are `minSample` and `maxFirstRound`, via
  `firstRoundSampleSize`. The three expansion ceilings are composed, passed, and
  consumed by nothing. The guard checks *references*, not *reachability*.
- **`apps/web/lib/**` is outside the ADR-0008 guard's scan** — `tsxFilesUnder`
  is called only with `"app"` and `"components"`, so a helper in `lib/` could
  format a sampled figure unseen.
- **`packages/sitemap` publishes its `rmSync`-holding fixture generator from the
  production barrel.** The `./extraction` subpath routes around it rather than
  fixing it.

### The composition is provisional

`docs/DESIGN.md` names Tools exactly once, in the rail's item list, and
describes no screen. It is not among the eight Stitch screens recoverable by
name, and Stitch is unreachable from this machine (ADR-0034). The owner has said
they will supply the design; until then the arrangement follows §7.2's ratified
analysis composition — applying a recorded decision rather than inventing one —
and `app/tools/page.tsx` says so in its header. ADR-0031 is why this is marked
as a placeholder instead of documented as though it were sanctioned.

---

## ADR-0036 — The Tools screen is rebuilt on the real Stitch design, and the seven tools this platform cannot offer are cards rather than omissions

**Date:** 2026-09-07
**Status:** Accepted
**Supersedes in part:** ADR-0035 (its composition only — the two calculators, `measureProportion`, `LocObserver` and the no-`Database` registrar all stand)

### Context

ADR-0035 built Tools one day earlier and said plainly that its arrangement was a
placeholder: *"`docs/DESIGN.md` names Tools once, as a rail label, describes no
screen, and Stitch is unreachable, so §7.2 is borrowed as a placeholder pending
the owner's design (ADR-0031's rule)."*

The owner has now supplied the screen. It is not §7.2's analysis composition and
does not resemble it: a meta strip, a title with header actions, a search-and-
category filter bar, a **featured hero panel** for a single tool, then three
category sections of three utility cards each, then a status strip.

**This is the good case of ADR-0031's rule.** That ADR was written after a
Settings screen was INVENTED because no document described one, and then written
into `DESIGN.md` as though the invention were a decision. The rule it set —
*when a binding design cannot be read, ask for it; do not fill the gap and
document the filling* — was followed here: ADR-0035 marked its arrangement
provisional in the ADR, in `DESIGN.md` §7.2 and in the page's own docblock, so
when the design arrived there was nothing to unpick and no false sanction to
retract.

### The design problem

**The design ships nine utilities. This platform has two.** Seven of the nine
need capabilities that were verified absent rather than assumed so, re-confirming
ADR-0035's audit: no HTML parser anywhere in the repo, no headless browser, no
link graph, no robots.txt fetch or rule parser, nothing that follows a redirect,
and **no outbound HTTP from `apps/api` at all**.

The design leads with an **"Instant Single URL Live Inspector"** — paste a URL,
get its status, canonical and index directives. That is the single thing this
screen must never offer, and not only for want of a fetch client: verification
runs in the worker behind a rate limiter and a circuit breaker against a sample
the pipeline planned, and an on-demand fetch triggered by a web request would
bypass both, which is the behaviour those two exist to prevent.

### Decision

**Take the composition; refuse the figures** — ADR-0031's rule for a form's
fields, and ADR-0032's for a whole screen, applied to a catalogue.

**1. The seven impossible tools are rendered as cards, not omitted.** A nine-card
grid cut to two says nothing about why. Each unavailable card names the missing
capability in the card body, and the section holding the three live-inspection
tools carries `NOT AVAILABLE — NO OUTBOUND HTTP` as its own label. A reader
learns what this platform does not do, which is worth more than a tidy grid —
and the design's own hero tool sits first in that section, so the product's
central refusal is stated where the design puts its loudest promise.

**2. The catalogue is data, and a test enforces the honesty in both directions.**
`lib/tools-catalog.ts` holds the nine entries; `tools-catalog.test.ts` fails if
an unavailable tool carries no `unavailableReason` (or one under 40 characters),
and if a launchable tool points anywhere but a route this app serves. **Confirmed
load-bearing by deleting `unavailableReason` from the live URL inspector** — the
layer neutralised is the catalogue entry itself, and two tests fail and name it,
while the card still renders and still says "Unavailable" and simply stops saying
why. Nothing else in the suite notices.

**3. The header's count says what a reader can run.** `countLaunchable()` returns
4, not 9, and the section chips read "1 of 3 available" rather than the design's
"3 Tools". A count of the grid is §1.9's shape: a label asserting a guarantee the
code does not make.

**4. `toolAvailabilityTone` joins `lib/status.ts`, and unavailable is `unknown`.**
Not `critical`: a capability deliberately never built is not a defect, and seven
red cards report a broken product to anyone who reads the grid before the text —
the same inversion `patternStatusTone` already carries a warning about, where a
host refusing us was being called critical. `advisory` is a warning, for the
expansion planner: real, tested, and run by no pipeline stage.

**5. The hero holds the loaded tool, and its tiles appear only after a
computation.** The design's four tiles are an inspection's results. Rendering
them as dashes or zeros before the reader has submitted anything borrows the
"it ran" state for a screen where nothing has — zero draws nothing (DESIGN.md
§9). Tiles carry counted figures and the confidence BAND NAME; the estimate and
its interval stay in `<Estimate>`, which ADR-0008's guard makes the only adapter.

**6. Functionality added is deliberately minimal.** The catalogue search and
category pills are plain GET links and a GET form over static data — no new
endpoint, no new query, no schema change, no mutation. The one genuinely new
affordance is the `#api-endpoints` panel, which documents the two routes that
already exist. `Batch execution` is drawn from the design and rendered inert
with its reason, per §7.2's header-action rule.

### Consequences

Ten GET routes and one PATCH, unchanged. No migration, no schema change, no new
dependency. `DESIGN.md` gains §7.3 and §7.2 stops describing Tools as
provisional.

**A defect a screenshot caught and no test did, the fourth milestone running** —
though a smaller one than its predecessors: `--text-2xs` is 11px on a **12px**
line-height, correct for a badge and cramped for a wrapping paragraph, and the
planner's hint additionally mixed a mono span into an 11px sans line, where the
two faces at one size do not read as one size. Both fixed, and the token note is
recorded in §7.3 because `components/form.tsx`'s `Field` hint had the same
latent problem on the Settings screen.

**Still owed, unchanged from ADR-0035:** the twelve configured-but-unenforced
operational limits (ADR-0030) remain unenforced and remain reported; `Projects`
stays disabled as ADR-0028 and ADR-0029 ruled; there is still no auth
(ADR-0026); and the three screens built before ADR-0031 have still never been
checked against the design. Newly owed: the design's Tools screen shows a rail
with a plan/quota meter and a `Documentation` item, and a top bar with a global
search, a bell and an avatar — none of which have anything behind them, and none
of which were built for that reason.

---

## ADR-0037 — Projects is a fleet portfolio, not a second sites list; and the health score is refused rather than invented

**Date:** 2026-09-07
**Status:** Accepted
**Supersedes in part:** ADR-0028 (its Projects verdict only — the cross-site query design it records stands and is extended here)

### Context

`Projects` was the last rail item still disabled on a recorded verdict rather
than for want of data, and that verdict had been restated three times. ADR-0028
put it plainly: *"Projects is the design's name for the sites list, which
Overview already is."* ADR-0029 and ADR-0035 both re-affirmed it while ruling on
their own screens.

**That was right on the evidence available and wrong once the evidence
changed.** The owner supplied the Stitch "Projects Portfolio" screen, and it is
not a sites list. It is a fleet view with four KPI cards over the whole account,
three filters, a paginated table pairing each domain with its latest run and its
findings, per-row quick actions, a CSV export and the app's onboarding action.
Overview's table is five columns of `site` and nothing else.

And underneath it, the same gap ADR-0034 found for Analytics: **the data existed
and no route could reach it.** `createSite` had exactly one caller in the repo —
the seed script. The fleet needed one query per site to answer "what is each
site's latest run", which is the shape that works at eighteen sites and stops
working with nobody noticing.

### Decision

Build the portfolio end to end: two new organization-scoped aggregates, a read
model route, a CSV export, the API's first CREATE, and the screen.

**1. The health score is refused, and the refusal is on the screen.** Stitch
shows `94/100` per project and `Avg. Technical Health 88.4/100` in a card. This
platform computes no such number anywhere — not in `packages/sampling`, not in
the estimate stage, not in any column. A composite invented in a serializer
would be the most confident-looking figure on the page and the only one with no
definition, no test, and no way for a reader to check it; worse, any honest
version would be derived from ESTIMATES, and DESIGN.md forbids a card carrying a
sampled figure because a card cannot carry an interval.

So the column carries **counted findings** — a severity bar plus "35 critical of
42" — and the intro paragraph says the score is absent rather than leaving a
reader to guess which card absorbed it. Two more figures are renamed for the
same reason: `Total Crawled Pages` becomes **urls discovered** (this platform
samples a population, it does not request all of it) and its "99.4% indexable"
is dropped outright (there is no indexability signal anywhere). The CSV column is
`urls_discovered` too, because a spreadsheet outlives the screen that made it.

**2. `latestRunPerSite` and `countOrganizationSnapshotsBySeverity`**, both
`DISTINCT ON`/`GROUP BY` in one pass, both resolving their site ids through
`organizationSiteIds` exactly as ADR-0028's two fleet lists do. They **resolve
the ids themselves rather than accepting the page's**, which is the more
expensive call and the only one that keeps the tenant boundary structural: a
function that reads whatever site ids it is handed is a function whose safety
depends on its caller.

Each got its own isolation case rather than inheriting the neighbour's — the D3e
rule, since a second query on a shared boundary is a second place to get it
wrong — and each asserts the rival tenant's rows EXIST before asserting they
cannot be seen, per the D3d finding that an isolation test seeding nothing
passes against an empty table. **Both confirmed load-bearing by removing the
`inArray` predicate in the query itself**: `latestRunPerSite`'s failure returns
the rival's site as an extra map entry, and the severity count's returns the
rival's rows in ours. Named, per the D3c correction.

**3. `POST /sites` — the API's first CREATE.** `GET /projects` is the read model
and `POST /sites` is where you create one, because "Projects" is the design's
label and `site` is the entity: the same split `Crawls` → `/runs` already makes.
Onboarding creates the row and its table partitions in one transaction
(ADR-0003), and `host` is derived from `base_url` rather than accepted, so the
bucket the outbound rate limiter throttles on cannot disagree with the URL
actually requested — both properties of `createSite`, which is why the body has
no `host` field.

**A REAL DEFECT THIS EXPOSED, found by the new route's own test.** `createSite`
never mapped `uq_site_organization_host`: with one caller that guards against
re-seeding, a duplicate host had never been reached, so the violation propagated
raw. Onboarding a domain that is already monitored is the single most ordinary
mistake this endpoint will see, and it was answering **500**. `updateSite`
already mapped the same constraint; the create path simply never had. Confirmed
by removing the mapping — the test reports 500 instead of 409.

**4. Fleet totals are computed over the fleet, never the page**, and sent as a
separate `totals` object so the screen cannot accidentally sum its rows. This is
the D3a defect asserted so it cannot return: both fleet screens once counted a
page of 50 and labelled it the total. A filter reaches the totals as well as the
rows, or the cards describe a different set from the table beneath them. The CSV
export likewise ignores `limit`/`offset` while honouring the filters — a file
named "portfolio" containing one page is a truncated export presented as
complete.

**5. Four run states, not two**, in `lib/projects.ts` with `projectRunTone` in
`lib/status.ts`. `never_run`, `in_flight`, `no_urls`, `measured`. A project
onboarded ten minutes ago and a project whose run found nothing both render as
zeros unless something says otherwise; `never run` and `not measured` are said
in words, and a completed run that discovered zero URLs takes a `no urls` badge,
because an HTML error page parses as valid URL-less XML and `status` cannot
express it. `never_run` is `unknown`, not a warning — no measurement yet is not
trouble. **Run health and measurement stay separate**: a `failed` run that
discovered 12 URLs is still `measured`, because the status badge already carries
the failure and reporting it twice would hide the counts the row does hold.

### Consequences

Twelve GET routes and two mutations. No migration, no schema change, no new
dependency. `DESIGN.md` gains §7.4; ADR-0028's Projects verdict is superseded
and its cross-site query design is extended by two more queries.

**Verified against the running app, including the state that had never
rendered**: a project was created through the real endpoint, the row came back
grey-accented with `not measured`, `—`, `—` and `never run` while the fleet's
`urls discovered` correctly did not move, and the site was then soft-deleted.
Filters, the empty-filtered state and the CSV export were each driven end to end
through the Next proxy.

**Two screenshot findings, neither caught by a test.** The severity breakdown
printed in full wrapped to three lines and made every row tall, so the visible
text is now the two figures a reader scanning a fleet compares, with the full
breakdown in the hover and an `sr-only` line — the "never the only channel" rule
kept without the row height. And the column headers wrapped, which is cosmetic
but pushed the header to double height; `whitespace-nowrap` fixes it safely
because the table already scrolls inside its own container.

**Owed, and recorded rather than decided in passing: Overview's table is now a
strict subset of this screen.** ADR-0028 called Projects the duplicate; the
relationship is now the other way round. Folding it in, or re-scoping Overview
to a fleet dashboard, is a decision about what the landing screen is for — the
page carries a link and a comment saying so. Also unchanged: no auth
(ADR-0026), so anyone who can reach the port can now CREATE a site and its
partitions, which needs CORS narrowed and a session before it leaves a
developer machine; the twelve configured-but-unenforced limits (ADR-0030) are
still unenforced; and there is still no scheduler, which is why the cadence
filter and the per-row run-now action are drawn inert with their reasons.

---

## ADR-0038 — Pattern Intelligence: the run's patterns ranked for triage, and why the rollup is not `scorePatternImpact`

**Date:** 2026-09-07
**Status:** Accepted

### Context

An external reviewer assessed the Stitch design and produced a 25-point verdict.
Checked against the built app rather than the mockups, most of it was already
answered: "Total Crawled Pages" is already `urls discovered` with a
not-requested tooltip (ADR-0037), the internal-link figures were refused
(ADR-0032), the explorer footer already says "sampled URLs" and a test asserts
it, and seven of the nine Tools cards already name the capability they lack
(ADR-0036). Several more of its recommendations — Content Analysis, TF-IDF
clusters, a redirect analyzer, Core Web Vitals, GSC Intelligence, structured
data, and a live single-URL Page Audit — need capabilities verified absent here:
no HTML parser, no headless browser, no link graph, no `googleapis`/CrUX client,
and **no outbound HTTP from `apps/api` at all**.

One finding survived and was the strongest in the review: **there is no pattern
explorer.** The data existed and nothing could reach it. `scorePatternImpact`
and `compareByImpact` in `packages/sampling` had zero callers; the route
`GET /sites/:siteId/patterns` existed and no screen consumed it; and the site
detail's pattern table showed population and status but no evidence at all —
the estimated affected count, the sample behind it and the worst finding were
reachable only by opening one pattern at a time. This is the ADR-0034 gap
again: written, tested, and reachable by nothing.

### Decision

A per-site, per-run ranked pattern explorer at
`/sites/[siteId]/patterns` — a list page that never existed — over a widened
`GET /sites/:siteId/patterns`.

**Composition from the Stitch "Sitemap Analyzer" screen**
(`docs/design-source/sitemap_analyzer/`). All 18 vendored screens were checked
and none is pattern-shaped; `url_explorer_detail` is page-level audit (title
tags, H1, inbound links, HTTP headers — every one a blocked capability). Rather
than invent a composition, which is the D3c failure ADR-0031 records, this takes
the design's population screen and refuses its figures. Recorded as DESIGN.md
§7.5, including the three refusals: no "Indexability 94%" (nothing measures
index state), one `urls discovered` card rather than the Search Console
submitted/discovered pair, and `parsed at` rather than "Last Modified", because
`sitemap_file.parsed_at` is when WE parsed it.

**Ranked and paged in SQL.** `listPatternsRanked` groups `audit_snapshot` by
pattern and orders on the summed `impact_score`, LEFT JOINed so a pattern with
no published finding still appears — the load-bearing choice, since `blocked`,
`needs_review` and `unsampled` patterns have no snapshot row at all and an inner
join would silently drop exactly the patterns a triage screen exists to surface.
Summing in the route instead would rank whatever page happened to be fetched,
which is the defect `countPatternsByDepth` already avoids. Ties break on `id` so
the order is total and rows cannot swap between loads.

**The rollup is NOT `scorePatternImpact`, and this is the decision worth
carrying.** That function computes exactly this shape and was the obvious reuse.
It takes a probe outcome plus a fresh `StratifiedEstimate` and derives the
weight from the severity table **in force now**. A stored `audit_snapshot`
carries the weight that was in force **when it was published**, deliberately,
because weights are business decisions that get revised and a historical claim
has to stay reconstructible against the ones that produced it (ADR-0014).
Re-scoring at read time would silently restate old findings under new weights.
Reaching that function at all would also mean rebuilding a `StratifiedEstimate`
these rows do not carry — no per-stratum breakdown, no `isSoft404` — which is
the invent-the-missing-part defect ADR-0035 records, where the invented part
decides the answer.

So `rollUpPatternImpact` lives in `apps/api/src/findings.ts` beside
`withImpactBounds`, repeats the arithmetic, and shares the CLASSIFICATION:
`isAbsenceOfEvidence` is a pure function of the severity class with nothing to
invent. A test asserts the two agree wherever the stored weights match the
current table, so the duplication cannot drift into a second, quieter answer.
`compareByImpact` gets its first caller as the assertion that the SQL ordering
and the package's documented total order are one rule, not two.

**The rollup is SHAPED as a measurement.** Its fields are exactly
`auditSnapshotSummary`'s — `impactScore`, `impactLow`, `impactHigh`,
`evidenceTier`, `confidenceBand`, `sampleSize`, `populationCount` — so the web's
existing `impactFromSnapshot` renders it with no second adapter, and
`lib/adr-0008-guard.test.ts` already polices those names. A rollup with its own
field names would have been a sampled figure the guard could not see.
`impactFromSnapshot` was widened to the seven fields it actually reads rather
than duplicated, the same move `estimateFromSnapshot` documents.

### Consequences

Three states are kept apart, in the API and on the screen: **nothing published**
(no snapshot row — the `impact` field is absent), **every finding an absence of
evidence** (`evidenceTier: "blocked"`), and **measured at zero** (a real zero).
All three render as "0" unless something says otherwise, and collapsing the
middle into the last reports a host refusing us as a clean bill of health.

`rankScore` — the bare summed impact the SQL orders by — never leaves the API.
It is a point value with no bounds. `adr-0008-guard.test.ts` gained a second,
STRICTER rule for it: a name no module may read, **the adapter included**, since
an adapter that learned to format it would satisfy every other check in that
file while rendering an interval-less estimate.

There is no run-wide "estimated affected URLs" figure. Summing intervals across
patterns is a statistical choice this screen does not make, and summing the
visible page would be D3a's defect with a new label.

No rail item: this is a per-site drill-down reached from the site overview and
the breadcrumb trail, and Overview's `match` already owns the `/sites/` prefix.

Both new queries got their own isolation case (the D3e rule — a second query on
a shared join path does not inherit its neighbour's), each asserting the rival
tenant's rows EXIST before asserting we cannot see them (the D3d rule), and each
confirmed load-bearing by removing **that specific query's site predicate** (the
D3c rule: name the layer). `listPatternsRanked` returns the rival's pattern
without `eq(pattern.siteId, ...)`; `listSnapshotsByPatterns` returns the rival's
claims without `eq(auditSnapshot.siteId, ...)`. Separately, removing the route's
`assertSiteInOrg` makes the API answer 200 with the rival's template in the body
— **the layer neutralised there is the route's membership check**, and it is
load-bearing for a different failure than the repository predicates are.

One fixture finding worth keeping: the first draft seeded a `blocked` claim with
`observed_count: 30`, and the database refused it —
`ck_audit_snapshot_evidence_tier_matches_coverage` requires a blocked claim to
carry `observed_count = 0` and `point_estimate = 0`. A refusal means the host
would not let us look, so there is nothing observed to report. The schema
caught a fixture that would have tested a claim the platform cannot make.

Unchanged: no auth (ADR-0026), no migration, no schema change, and the API is
still eleven GETs plus the two writes ADR-0037 added.

---

## ADR-0039 — The rail says "Analyses", not the design's "Crawls"

**Date:** 2026-09-07
**Status:** Accepted. Supersedes ADR-0027's rail-label clause; the rest of
ADR-0027 stands.

### Context

ADR-0027 fixed the navigation rail to the Stitch design's item list exactly —
Overview, Projects, Crawls, Issues, Tools, Analytics — at the project owner's
explicit direction, **after the conflict was raised and reaffirmed**. It
recorded the tension plainly rather than smoothing it over: "Crawls" is a
crawler product's language, and this platform's whole differentiator is that it
collapses a sitemap into patterns and probes a statistical sample of each. The
label was held as presentational, with a warning comment beside the item list
and a compensating tooltip on Settings' "Last Crawl" row.

An external design review reached the same conclusion independently, listing
ten terminology changes of which this was the first. That is two separate
readers arriving at the same objection, which is different evidence from the
implementer raising it once.

The audit that followed found the visible surface was already almost clean:
exactly **two** user-visible strings used the word as product language — the
rail item and Settings' "Last Crawl" — while every page heading behind it
already said "Runs" or "Sampling Analysis", and one string was a deliberate
negation ("sampled, never fully crawled"). The remaining hits were third-party
terminology (robots.txt `Crawl-delay`), an unbuilt tool's description, and an
icon identifier.

### Decision

The rail item becomes **"Analyses"** and Settings' metadata row becomes **"Last
Analysis"**, at the owner's direction. The item order still follows the design;
one label deliberately does not.

`components/nav-rail.test.tsx` asserts it, because a comment is not enforcement:
the rail is the most-read text in the app and the easiest place for crawler
language to drift back during an unrelated restyle. The guard checks the label
by name, scans every rail label for crawler words with the remedy in the failure
message, and asserts that no item points at a route that does not exist — the
dormant-404 class the `SOON` marker and the `/sites/` prefix fix already exist
for. Confirmed load-bearing by reverting the label: three tests fail.

### Consequences

**"Analyses" now sits directly above "Analytics" in the same rail**, and they
are different screens — a run's sampling passes, and per-site estimator health.
This was raised before the change was made and the owner chose "Analyses" over
"Runs", which was the alternative offered and which matches both the page's own
`<h1>` and the `sitemap_run` entity. A test asserts the two items stay separate
and correctly pointed, so if they are ever confused the fix is a better name for
one of them rather than a quiet return to crawler language. If the pairing reads
badly in use, "Runs" remains the fallback.

The `CrawlIcon` export keeps its name. It is an internal identifier for a
cloud-download glyph, never rendered as text, and renaming it would be churn
across five call sites with no reader-visible effect.

Three references to "Crawls" survive in comments, all of them deliberately
naming the DESIGN's label in order to explain why the app does not use it.

## ADR-0040 — The pipeline is made self-driving through BullMQ, and the queue namespace's separator turns out to have never worked

**Date:** 2026-09-08
**Status:** Accepted.

### Context

An architecture audit found that, despite `packages/pipeline`'s five stages and
`apps/worker`'s per-site `SitePipeline` being well-built and individually
tested, nothing had ever driven a run through them end to end in production.
Two hand-offs were missing outright — `discover` never enqueued `ingest`, and
nothing enqueued `finalize` after the last pattern's `estimate` completed — and
`attachSite()` had no caller anywhere, so a worker process started and idled
forever. The only thing that could run all five stages was `scripts/live-run.ts`,
a manual script that deliberately bypasses Redis and BullMQ and says so in its
own header comment. Separately, `verify` and `estimate` had no guard against
BullMQ's at-least-once redelivery (only `ingest` did), and the schema's
`heartbeat_at`/`idx_sitemap_run_heartbeat` stale-run recovery path had never been
implemented — `heartbeatRun()` existed, exported, and uncalled.

Closing these gaps required building the first real integration test of
`SitePipeline` against an actual Redis — a test that had never existed. It
failed immediately, on `Queue` construction, for a reason unrelated to anything
this session set out to fix: **BullMQ throws `"Queue name cannot contain :"`,
because `:` is the delimiter BullMQ's own Redis keys use internally**
(`bull:{queueName}:wait`, etc.). This project's queue namespace has been
documented as `{tier}:{siteId}:{stage}` since M5, praised repeatedly in the
milestone log as real and well-tested, and asserted by pure-string unit tests
in `queue-names.test.ts` — none of which could have caught this, because none
of them ever constructed a real BullMQ `Queue`. `packages/pipeline`'s own e2e
suite is deliberately Redis-free by design. As far as this audit could
determine, no `SitePipeline` had ever been attached to a real Redis before this
session's test did it, and the entire namespacing scheme would have failed on
the very first site any real deployment ever tried to attach.

### Decision

**The queue-name separator changes from `:` to `.`.** `queueName()` and
`parseQueueName()` in `packages/pipeline/src/queue-names.ts` now join
`{tier}.{siteId}.{stage}`; `queue-names.test.ts` gained a regression asserting
no name this function produces can contain `:`, so this cannot silently
regress back to the delimiter BullMQ forbids. UUIDs cannot contain `.`, so the
same collision-freedom argument the original design made for `:` still holds.
Every prose description of the `:`-separated scheme elsewhere in this codebase
(`CLAUDE.md`, milestone-log entries, docblocks not touched by this change) is
left as the historical record it now is rather than rewritten.

**Stage self-chaining is completed using the existing injected-`enqueue`
pattern, not a new mechanism.** `discover` now calls `deps.enqueue("ingest",
...)` on success and `finishRun(..., "degraded")` directly when a parsed index
names no children — moving `scripts/live-run.ts`'s manual decision into the
stage itself, so the script and the queue-driven path are one code path, not
two that can drift. The `estimate → finalize` hand-off is a genuine fan-in, not
a 1:1 hand-off: a new `checkRunCompletion` helper
(`packages/pipeline/src/stages/finalize-trigger.ts`) compares a live count of
patterns in a terminal status (`measured`/`blocked`/`needs_review`) against
`sitemap_run.total_patterns`, and enqueues `finalize` once they match. It is
called from `estimate`'s own success path (the common case) and from
`verify`'s fully-unresolvable early return, which is the one way a pattern can
reach a terminal status without ever enqueuing `estimate`. `ingest` itself
enqueues `finalize` directly when it draws zero samples at all, since no
downstream job would otherwise exist to notice completion. The comparison is
safe without a distributed lock only because `estimate`'s `Worker` runs at
concurrency 1 per site (`SitePipeline.start()` now throws if that is ever
raised without a matching change to the completion check) — recorded as a
load-bearing invariant, not merely a resource limit.

**Idempotency is enforced by making redelivery a safe no-op, following the
pattern `ingest`'s `IngestAlreadyAggregatedError` guard already established,**
not by trying to prevent redelivery. `verify` now checks
`countObservations(patternSampleId)` before probing and skips straight to
re-enqueuing `estimate` if a prior attempt already wrote observations — the
real cost redelivery risks here is sending the same HTTP requests at the
client's origin a second time, not a database inconsistency.
`audit_snapshot` gained `uq_audit_snapshot_sample_status`, a unique index on
`(site_id, pattern_sample_id, http_status)` — the natural key `estimate`
already writes one row per, per its own docblock ("ONE SNAPSHOT ROW PER
OUTCOME") — and `insertAuditSnapshot` upserts on it with `ON CONFLICT DO
NOTHING`, reading back the existing row on conflict rather than treating it as
an error, mirroring `recordPatternSample`'s existing shape.

**A site is attached and a run started through one new queue,
`ATTACH_REQUESTS_QUEUE`, not through a fleet-wide poll.** `attachSite()`'s own
docblock had already named the correct shape: "a run is attached explicitly,
which is what the API will call." Building that required deciding how "the
API" reaches into a separate worker process, and the answer is a small control
message — `{organizationId, siteId, tier, sitemapRunId, sitemapUrl, baseUrl,
expectedHost}` — posted by the new `POST /sites/:siteId/runs` route and
consumed by a single `Worker` the worker process runs alongside its per-site
pipelines. Its handler calls `attachSite()` (a no-op if already attached) and
then `SitePipeline.startRun()`, in that order, which is what guarantees a
`discover` job is never enqueued before something is listening for it.
Deliberately NOT a periodic `listSites()` sweep: `CLAUDE.md`'s own
non-negotiable rules flag fleet-wide auto-attach as needing a cross-organization
read that has been repeatedly, deliberately left undecided, and every message
on this queue already names the one site it is about — no enumeration, no new
scope, nothing for the worker to decide on its own. `startRun` itself still
runs synchronously in the API request, ahead of the queue message, so
`uq_sitemap_run_one_active_per_site` arbitrates a race between two requests
rather than two attach messages both trying to start a run.

**`POST /sites/:siteId/runs`'s dependency on Redis is injected as its own
parameter, `runTrigger?: RunTrigger`, not folded into `SettingsConfig`.**
`REDIS_URL` has no default, and `api-config.ts`'s docblock already records
twice why widening the config every route receives to require it would force
every existing test building that config to also hold a Redis URL — the same
§1.13 shape recurring a third time, caught before it landed rather than after.
`buildApp` gained a fourth, optional parameter instead; omitted, the route
answers 503 `RUN_TRIGGER_NOT_CONFIGURED` rather than crashing or silently doing
nothing, and the existing test suite's zero-Redis invariant survives unchanged.

**A stale-run sweeper now exists, and it is deliberately separate from the
event-driven failure path.** `SitePipeline`'s `worker.on("failed", ...)`
handler now calls `finishRun(..., "failed")` once a job's BullMQ retries are
exhausted — an immediate, clean signal — but cannot catch the case where the
*worker process itself* dies, since nothing survives to fire the event. A new
`apps/worker/src/stale-run-sweeper.ts` polls on an interval
(`HEARTBEAT_SWEEP_INTERVAL_MS`) for `running` rows whose heartbeat has gone
quiet past `HEARTBEAT_STALE_THRESHOLD_MS` and fails them — a fleet-wide read
with no `SiteScope`, deliberately, matching `organizationSiteIds`' precedent
for a package-internal exception, and narrow: it returns ids only, never site
content, and its only write is failing a run by id. `finishRun` itself gained
a `WHERE status = 'running'` guard so a run that finished by some other path
between a sweep's read and its write cannot be overwritten back to `failed` —
harmless for every existing caller, since all of them already only call it
while a run is running.

### Consequences

`apps/worker` has real test coverage for the first time — `apps/worker/test/`,
against a real Redis, a real Postgres and a real local HTTP server, not the
Redis-free stage-level testing `packages/pipeline` deliberately keeps. The
first version of the self-chaining test caught the `:`-separator defect on its
first run; a second fixture-sizing mistake (too few URLs per family to clear
the pattern-trie's collapse threshold) and a missing `baseUrl`/`expectedHost`
propagation gap through `AttachRequestPayload` → `SitePipeline.startRun` →
`discover`'s payload were both found the same way, by the test failing for a
real reason rather than by inspection. `packages/pipeline`'s own e2e suite
gained matching idempotency regressions for `verify` and `estimate`
(`pipeline.e2e.test.ts`), a dedicated `gzip-sniff.test.ts`, and a real gzip
reproduction (`discover-gzip.e2e.test.ts`) for a related, independently-found
bug — see the gzip fix below.

`scripts/live-run.ts` is unchanged and still works: it drives the same stage
functions directly, which now happen to also self-chain when given the
chance (its own `enqueue` stub still just collects rather than executing, so
this is inert for that script specifically), and it remains the only thing
that has ever exercised a real run's discover→ingest→verify→estimate→finalize
sequence against a genuinely large corpus.

Not addressed here, and not silently resolved: the cross-organization
fleet-wide auto-attach question `CLAUDE.md` and `attachSite()`'s own docblock
both flag as open. This work makes single-site, explicitly-triggered
attachment real; scaling to 650 sites' worth of concurrent, unattended
attachment is a separate decision this ADR deliberately does not make.

## ADR-0041 — A gzip-compressing server can make ingest fail on an already-decompressed file, fixed by sniffing bytes instead of trusting a header

**Date:** 2026-09-08
**Status:** Accepted.

### Context

A runbook for a new script, `scripts/live-run.ts` (the first thing able to
drive a real run against a real site — see ADR-0040), surfaced a real,
reproduced, pre-existing bug: `packages/pipeline/src/stages/discover.ts`'s
`isGzip()` decided whether a stored sitemap file was gzip-compressed by
checking `url.endsWith(".gz") || response.headers.get("content-encoding")`.
Undici's `fetch` transparently decompresses a gzip response body before a
`SitemapResponse`'s bytes are ever read, but leaves `content-encoding: gzip` on
the response object regardless — so a server that genuinely, correctly
compresses its XML on the wire (IIS and nginx both do this by default,
independent of the URL's extension) left the pipeline believing the STORED
bytes were still gzip. The next stage's `gunzip` then failed with
`Z_DATA_ERROR: incorrect header check` on a perfectly good sitemap. Reproduced
against `https://www.sitemaps.org/sitemap.xml`, which IIS serves this way.

### Decision

Trust the bytes actually on disk, not a header describing a transformation
undici already reversed. A new helper, `packages/pipeline/src/gzip-sniff.ts`,
reads the smallest possible prefix of a stream and checks for the gzip magic
number (`1f 8b`). `discover.ts` sniffs the entry document immediately after
`deps.store.put` writes it — before ever deciding `is_gzip` for the
single-`urlset` case, and before re-opening the same bytes to detect the root
element or list an index's children, both of which used to repeat the same
`.gz`-suffix-or-nothing guess independently. `ingest.ts`'s `ingestOneFile`
sniffs a freshly-downloaded child file the same way and corrects
`sitemap_file.is_gzip` via a new optional field on `markFileDownloaded` — a
child is only a named URL at discovery time, with no bytes yet to sniff, so
this is the first point a caller can correct that registration-time guess from
what was actually written.

The `.gz`-URL-suffix fast path is kept everywhere it already existed; sniffing
only replaces the `content-encoding` half of the check, which was the only
half that could be wrong in the direction that matters (marking gzip bytes as
plain is comparatively harmless — `streamLocs` would simply fail to parse XML
it received as still-compressed noise — while marking already-plain bytes as
gzip is what broke a working sitemap).

### Consequences

`packages/pipeline/src/gzip-sniff.test.ts` covers the sniff function directly
(real gzip bytes, plain XML, an empty stream, and the prefix-only detection
boundary). `discover-gzip.e2e.test.ts` reproduces the exact bug end to end
against a real local HTTP server that genuinely gzips a response with an
accurate header on a non-`.gz` URL, and asserts `discover`+`ingest` succeed
where the old code threw. Neither test existed before, and neither of the
existing gzip-adjacent tests in `packages/sitemap` could have caught this: they
either pass `isGzip: true` by hand (testing the downstream gunzip-when-told-to
path, not detection) or use `.gz`-suffixed synthetic fixtures — this codebase
had no test anywhere of the specific header-vs-bytes mismatch a real
compressing server produces.
