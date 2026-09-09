# Phase 2B.0 — Proven Prior-Art Architecture Investigation

Status: **investigation only** — no production code, schema, or config was modified while producing this report.

**Path correction to the task brief**: the reference material lives at `docs/Refrence/priorty_1/`, `priorty_2/`, `priorty_3/` (not `docs/reference/prior_1/2/3` — that path does not exist in this repo). `docs/requirements.md` does not exist either; it is not cited below. All findings in this report were re-verified by direct reads of the cited files, not taken on faith from the exploration passes that located them.

---

## 1. Executive Summary

The current platform's 25M-URL benchmark (`docs/benchmarks/2026-09-09-25000000-urls-scale.json`) took 12.0 min to ingest and **68.7 min** for verify+estimate combined, against a 50,000-URL benchmark that took 46.6 **seconds** for the same stage. The leading hypothesis — "candidate resolution may repeatedly scan/read sitemap files" — is **partially supported by the code's own design and strongly suggested, but not proven, by the benchmark numbers**. This report does not close that gap; it narrows it enough to name the smallest next measurement.

What is proven from reading the code directly:
- `estimate.ts` performs **zero** sitemap-file I/O (confirmed by its full import list — no `@pattern-aware/sitemap` import exists). The stage pairing in the benchmark JSON (`verifyEstimateMs`) cannot be decomposed from the recorded data alone, but any file-scan cost must live inside `verify`, not `estimate`.
- `verify.ts`'s candidate resolution (`resolveCandidates`, `packages/sitemap/src/ingest/resolve-candidates.ts:72`) is real, and it does re-open and re-stream a stored sitemap file per call — this is not a hypothesis, it's what the function does, by design, documented in its own docblock (lines 8-21).
- The mitigation already in place — grouping a pattern's candidates by file before resolving (`verify.ts:253-318`, `resolveAll`) — reduces cost only when **multiple candidates for the same pattern share a file**. Cross-referencing the 25M benchmark's own recorded numbers (§6) shows this condition is likely *not* met for the platform's largest patterns in that benchmark's synthetic corpus, which is the strongest evidence this report can offer for where the 88x time blowup (§6) against an 8x request-volume increase might be coming from.

What is proven from reading the prior-art excerpts: the old system solved several adjacent problems well (atomic partial-write visibility, a process-wide memory-budget ledger, job-idempotency fingerprinting, a generic bounded-concurrency worker pool) — but its own analogous "resolve a pattern's files once, cache across calls" idea (`sourceFileScanKey.ts`) has **no confirmed consumer anywhere in the copied source** and cannot be cited as proven prior art for solving *this* specific problem. Its own benchmarked scale tops out at 33.4M URLs (Cleaner) and 6.58M URLs (rewrites), not the "~100M+" the task brief asserts — that claim is not evidenced by the material actually provided (§3, §9).

**Recommendation (§11)**: instrument, don't redesign, before the next milestone. The report ends in "More Investigation Required," not "Ready for Implementation."

---

## 2. Current Platform Architecture

### 2.1 Ingestion flow

`discover → ingest → verify → estimate → finalize`, implemented in `packages/pipeline/src/stages/*.ts` as plain `(deps, scope, data) => Promise<Result>` functions. `packages/pipeline/deps.ts` states explicitly that BullMQ is deliberately absent from the package — queueing is composed in by `apps/worker/src/site-pipeline.ts`, which holds one BullMQ `Queue` + `Worker` pair per stage per site, keyed by `queueName({tier, siteId, stage})`.

- **discover** (`discover.ts:48`) fetches the sitemap URL, stores raw bytes (`fileId = ENTRY_FILE_ID = 0`), sniffs gzip from bytes, and parses its own entry document **twice** by design: once to detect the root element (`detectRootElement`), and — only if it's an index — a second time to enumerate children (`readIndexChildren`). This is a deliberate, documented (lines 65-72) trade against a second network fetch; it is not part of candidate resolution and does not repeat in ingest/verify/estimate.
- **ingest** (`ingest.ts:100`) does one streaming pass per file into a single shared `PatternAccumulator` (prefix trie), writing `pattern` and `pattern_population` rows, drawing first-round sample candidates from the accumulator's bounded min-heap as `{hash, fileId, ordinal}` triples (12 bytes each — see §2.2), and enqueuing one `verify` job per pattern.
- **verify** (`verify.ts:61`) is where candidate resolution and the actual HTTP probing happen — traced in full in §2.3.
- **estimate** (`estimate.ts:50`) reads `pattern_sample`/`pattern` rows, aggregates `sample_observation` via `tallyObservations`, computes statistics through `@pattern-aware/sampling`, writes `audit_snapshot`. **No sitemap-file I/O** — confirmed by its complete import list, which contains no `@pattern-aware/sitemap` import.
- **finalize** (`finalize.ts:48`) is pure DB reads/writes — `countPatternsByStatus`, `listSnapshotsByImpact`, `listSitemapFiles` (metadata only), writes `sampling_health`, closes the run.

Queue namespacing is `{tier}.{siteId}.{stage}` — **the separator is `.`, not `:`**. `packages/pipeline/src/queue-names.ts:15-28` documents this as a correction: `:` was the originally-designed and still-documented-elsewhere separator, but BullMQ throws on `:` in a queue name because it's BullMQ's own internal Redis-key delimiter (`bull:{queueName}:wait`). This contradicts CLAUDE.md's repo-layout prose (`{tier}:{siteId}:{stage}`) and this task brief's own Part 6 file list — noted here as a factual correction, not a defect to fix in this deliverable.

### 2.2 File model

Sitemap files are stored via `LocalDiskFileStore` (`packages/sitemap/src/store/file-store.ts`), keyed by `StoredFileKey {runId, fileId}` where `fileId` is a small per-run integer ordinal, not a database UUID — physically at `<root>/<runId>/<fileId>`. The `sitemap_file` table (`packages/database/src/repositories/sitemap-file.ts`) holds metadata (gzip flag, parse status, ordinal↔UUID mapping) but not the bytes themselves.

The sample state stored per candidate is a `(hash, fileId, ordinal)` triple — 12 bytes — rather than a full URL string (~80 bytes). `resolve-candidates.ts:8-21` states the reasoning explicitly: this is what keeps a 5,000-pattern site's sample state in tens of megabytes rather than hundreds. **The cost of that choice is paid at resolution time**: verification needs real URLs, so the file is re-opened and re-streamed to walk ordinals back into URLs.

`pattern_population` is the per-(pattern, file) population index — one row per file a pattern appears in (`pattern-population.ts:26`, "a pattern with 40 million URLs has one row per file here"). It is not read by `verify` or `estimate` in the pipeline stages (only by application/UI-facing repository functions elsewhere), but it is the concrete evidence used in §6 to estimate how many distinct files a given pattern's candidates are likely to be spread across.

### 2.3 Verification / candidate-resolution model

`resolveCandidates` (`packages/sitemap/src/ingest/resolve-candidates.ts:72-176`), read in full:

- Takes a `Map` of wanted ordinals for one file, opens the file once (`store.open(key)`, line 90), streams it via `streamLocs`, and **stops as soon as the last-wanted ordinal is seen** (the callback returns `false` once past `lastWanted`, line 144) — so a small draw from the front of a large file costs a partial read, not a full one. This is a genuine, already-present optimization, not something missing.
- Re-hashes every resolved path and compares it against the hash the sampler originally stored (line 127), throwing a **fatal** `CandidateResolutionError` on any mismatch or on any wanted ordinal not found by end-of-file (lines 149-161) — silent partial resolution is explicitly rejected because it would shrink the sample without shrinking `n`, inflating every confidence interval computed from it while looking like an ordinary success.
- Is called from `verify.ts`'s `resolveAll` (lines 253-318), which **groups one pattern's candidates by `fileId` first**, so a pattern whose sample happens to concentrate in one file pays one file-open, not one per candidate (comment, lines 246-248: "candidates scattered across three files cost three reads, not one per candidate"). **This grouping is scoped to one pattern's own verify job — it does not persist or share state across different patterns' jobs, and does not persist across a retry beyond the redelivery guard below.**
- Is protected from BullMQ's at-least-once redelivery by a guard in `runVerify` itself (lines 74-117): if `sample_observation` rows already exist for a `patternSampleId`, the job skips straight to re-enqueuing `estimate` without re-resolving or re-probing at all.
- After resolution, `verifyPattern` (from `@pattern-aware/verification`) does the actual HEAD-first, GET-on-suspicious HTTP probing against real URLs — this part touches the target site's server, not the stored sitemap file, and is the part the rate limiter/circuit breaker/escalation cap govern.

So: **within one pattern's one verify job**, a given file is opened at most once, and the resolution logic is correctly optimized for the case where a pattern's sample clusters in few files. What it does **not** do — and what neither Explore pass nor this report's own reads found any mitigation for — is share a file-open across *different patterns'* verify jobs, or across a *retried* job whose earlier attempt didn't get far enough to write any observations. See §6 for why this matters concretely against this benchmark's own corpus shape.

### 2.4 Estimate model

`estimate.ts` reads `pattern_sample`/`pattern` rows by id, aggregates `sample_observation` rows via a SQL-side `tallyObservations` call, and runs the statistics (`measureProportion`, `estimateStratified`, `scoreImpact` from `@pattern-aware/sampling`) purely on those aggregates. It writes one `audit_snapshot` row and triggers `checkRunCompletion`. It repeats no work verify already did (it does not re-resolve or re-probe), it does not rescan sitemap files (confirmed by import list — nothing from `@pattern-aware/sitemap`), and it depends entirely on `verify`'s persisted `sample_observation` rows. Its computation is DB-aggregation-bound, not CPU-heavy in any way this investigation found evidence for.

---

## 3. Prior-Art Architecture

**Directory contents** (all three are excerpts from a larger, not-fully-copied codebase — none is independently runnable; each imports modules like `db/pool.js`, `rewriteLocs.js`, `jobs/*.js` that are not present in any of the three directories):

| Dir | Contents | Nature |
|---|---|---|
| `priorty_1/` | `batchIngest.ts`, `boundedConcurrency.ts`, `cleaner.ts` (~74KB, largest file), `dedupBudget.ts`, `ingest.ts`, `parser.ts`, `patternFileScan.ts`, `sourceFileScanKey.ts` | Core backend source |
| `priorty_2/` | 5 `.ts` + 3 `.mjs` benchmark/repro scripts + a `README.md` | Benchmark/instrumentation. **4 scripts the README describes (`copyVisibility.mjs`, `patternJobCrashRecovery.ts`, `cleaner-reconnect.mjs`, `cleaner-abandon.mjs`) are not actually present** — their numbers below are README-only, not independently re-verifiable from source in this repo. |
| `priorty_3/` | `patternFileRewrites.ts`, `patternStructureJobClaim.ts`, `shapeFilter.ts`, `structureClusters.ts` + 3 `*.test.ts` | Pattern-structure/rewrite logic + tests |

### 3.1 Ingestion architecture

`ingest.ts:29` (`createStoredSitemapFile`) is an idempotent insert (`ON CONFLICT (session_id, filename) DO NOTHING`). `batchIngest.ts:81-196` (`ingestFilesIntoSession`) pre-loads existing stored filenames in one query, then drives file copy+insert at `INGEST_CONCURRENCY = 4` through the generic `runWithBoundedConcurrency` pool (`boundedConcurrency.ts:27`, read in full — a shared-cursor pool with three explicit contracts: never more than `concurrency` in flight, results index-aligned regardless of completion order, and `onSettled` receives a *count* not an index so a progress bar can't jump backwards). Resume-safety: a retry skips a file only if **both** a DB row and the on-disk file exist (`batchIngest.ts:132`) — a specific fix for a measured defect where retrying 801 already-copied files cost the same 6.2s for zero effect. Large-file/crash safety: writes go to `<dest>.<uuid>.part` then `rename()` (atomic on POSIX), closing a race where a direct `copyFile` leaves a visible truncated file at the real path that the skip-test would misread as complete — the README claims this was measured at 4,009/4,263 exposures without the fix vs 0/4,107 with it (`priorty_2/README.md:25-28`, not independently re-verifiable since `copyVisibility.mjs` is absent). Streaming for large files goes through `sax` over a piped, gunzip-if-needed stream (`parser.ts:301-314, 454-611`), never buffering a whole file.

### 3.2 Pattern/file architecture

`pattern_file_occurrences` is the pattern→file source-of-truth table, joined **live** against `sitemap_files WHERE is_deleted = false` at scan time (`patternFileScan.ts:40-106`) — the join exists specifically because rename/transform/redirect-fix operations are copy-on-write and repoint `sitemap_files.filename`, so a stale lookup would scan the wrong (pre-edit) copy. `sourceFileScanKey.ts` builds a cache key from `patternId` + a derived "files version" hash (`patternFilesVersion`, lines 71-88, itself derived by hashing the current `(id, filename)` set rather than stored, because there's no `updated_at` column and every edit is copy-on-write). **A repo-wide grep across all three directories found zero callers of `sourceFileScanCacheKey`** — the cache-key builder exists, but nothing that reads or writes an actual cache keyed by it is present in the copied material. Population tracking for dedup is separate (Cleaner-side): a `Map<key, filename>` (`keptBy`) tracking which file "won" each normalized-URL key, with a byte-accounted admission ledger (`dedupBudget.ts`, §3.5).

### 3.3 Verification architecture

Two distinct things both loosely answer "verification" in this material:

- **`patternFileScan.ts`'s `scanPatternFiles`** (lines 116-165, read in full): resolves target files once via `resolvePatternScanTargets`, then streams each target's `<loc>`s exactly once per call, at concurrency 6, through the same shared-cursor pool pattern as `boundedConcurrency.ts`. A file that fails to read is skipped, not fatal. Within one call, no file is read twice. Whether a **second, separate call** (e.g., a second user request for the same pattern) re-scans from disk or would have hit a cache via `sourceFileScanKey.ts` **cannot be determined from the copied material** — the consuming cache store is not among these files.
- **`verifyThroughput.ts`'s modeled URL-status verification**: pure HTTP HEAD/GET against already-DB-stored candidate URLs, rate/concurrency bounded (`config.verification.maxRequestsPerSecond`/`maxConcurrency`). Does not touch sitemap files at all.

### 3.4 Performance architecture

See the full table in §3.5's sibling — summarized: `ingestRate.ts` (throughput/file, proxy-timeout projections), `handoffRetryWaste.mjs` (retry-waste before/after the skip-test fix: 801/801 re-copied @ 6.2s → 0 re-copied, 801 skipped @ 1.1s), `ingestPartialCopy.ts` (crash-mid-copy correctness), `cleanerHandoffIngest.mjs` (proxy timeout at ~300-305s vs. an unbounded backend, via SSE), `cleaner-sftp-stage-timing.mjs` (per-stage wall time: pull/parse/dedup/output/index/zip/done — a real 2,264-file run took ~25 min vs. a 250-file/500K-URL synthetic benchmark's ~19s), `patternRewriteScale.ts` (sequential vs. piscina-pool rewrite throughput on a 1,200-file × 2,000-URL/file = 2.4M-loc scenario — no absolute timing recorded, only ratio/correctness assertions), `seedLargeSession.ts` (fixture seeding only), `verifyThroughput.ts` (throughput = min(rateLimit, concurrency/secondsPerCheck)).

**No 100M+-URL figures exist anywhere in the copied files.** The largest corpus actually cited is 33.4M URLs / 915 sitemaps (Cleaner, `cleaner.ts:764,955`, `dedupBudget.ts:7`), and 6.58M URLs / 823 files for pattern rewrites (`patternFileRewrites.ts:35-37`). `dedupBudget.ts:7-9` records observed memory-limit failures around ~25-30M unique URLs. **The task brief's "already demonstrated operation at approximately 100M+ URL scale" is not evidenced by the material actually provided** — treat it as an unverified claim about the old system as a whole (which may be true outside these three directories), not as something this investigation confirmed.

### 3.5 Failure/recovery architecture

- Atomic temp-then-rename writes (§3.1).
- `dedupBudget.ts:1-241`: a process-wide byte ledger (`admitDedupRun`/`chargeDedupBytes`/`releaseDedupRun`), 0.8-of-budget admission watermark, 0.55 heap share, throwing a typed `CleanerCapacityError` rather than letting the process OOM.
- `cleaner.ts`'s sharded dedup engine (read in full, lines 1075-1300+): Phase A partitions every source file's already-materialized `key\tloc` provisional text file into per-bucket spill files (one XML parse per source file, total, ever — `cleaner.ts:1089`, "a cheap re-read of a `<key>\t<loc>` text file, NOT a second XML parse"); Phase A2 decides keep/drop one bucket at a time so only one bucket's `keptBy` Map is resident at once, charging/releasing the shared ledger per bucket in a `try/finally` (lines 1244-1287, explicitly to prevent a mid-run throw from leaking budget permanently); Phase B re-reads only the flat spill files, never the original XML, to write cleaned output. This is a genuine, well-evidenced **build-once-resolve-many** design at the file level.
- `patternStructureJobClaim.ts` (traced by the Explore pass, not independently re-read in full for this report — cited at the confidence level of one verified pass): fingerprints job inputs, distinguishes attach-to-in-flight / replay-recently-completed / reject-as-busy outcomes, and handles a unique-index race via catch-and-reread — built specifically to stop a client-timeout-but-server-still-committing retry from double-applying a transform.
- `patternFileRewrites.ts:229,299`: new files unlinked on transaction rollback, old files unlinked only after commit; parallel writes use `Promise.allSettled` (not `Promise.all`) so an in-flight DB write inside a caller's transaction isn't left running after a rollback.
- BullMQ crash recovery is documented only in the README (`priorty_2/README.md:61-76`; the underlying `patternJobCrashRecovery.ts` file is **absent**) — not independently re-verifiable from source.

---

## 4. Direct Comparison

| Concern | Current Platform | Prior-Art System | Difference | Scalability Impact | Recommendation |
|---|---|---|---|---|---|
| Sitemap ingestion | One streaming SAX pass/file into a shared prefix-trie accumulator; discover parses the entry doc twice by design (`discover.ts:65-72`) | `sax`-based streaming parse (`parser.ts`), bounded concurrency (4) via a generic worker pool, idempotent insert on ingest | Old system separates "copy the file" (bounded-concurrency, generic pool) from "extract from it" more explicitly; current system fuses download+parse+extract+sample-draw into one pass per `ingest.ts:35-38`'s own stated rationale (avoid a second `<loc>` re-read per question) | Current design already avoids the old system's need for a separate extraction pass — this is a strength, not a gap | No change indicated |
| Sitemap file storage | `LocalDiskFileStore`, keyed by small per-run integer ordinal, no reuse across runs | Files on disk under a session id, `sitemap_files` DB row with mutable `filename` (copy-on-write repointing) | Old system's files are long-lived and mutable-by-repoint (supports rename/transform); current system's are run-scoped and immutable | Not comparable — different product surface (migration/editing vs. audit) | Do not adopt the mutable-repoint model; audit files should stay immutable per run |
| File metadata | `sitemap_file` table: ordinal↔UUID, gzip flag, parse status | `sitemap_files` table: filename, `is_deleted`, `source_role` | Old system's metadata exists to support edit-in-place; current system's supports resolve-by-ordinal | UNKNOWN whether current metadata is sufficient for a future caching layer without a "files version" concept | If a cache is ever added, `patternFilesVersion`'s derived-hash-of-current-file-set idea (§3.2) is worth the two lines it costs, even without adopting the rest of that module |
| Pattern extraction | Prefix trie, single accumulator per site per run (ADR-0012) | UNKNOWN — extraction logic itself is not among the copied files (only file-scan/dedup/rewrite logic is) | Cannot compare — old pattern-extraction source was not provided | N/A | UNKNOWN — requires additional investigation (would need the old extraction algorithm, not provided) |
| Pattern → file mapping | `pattern_population`: one row per (pattern, file), written once at ingest | `pattern_file_occurrences`: one row per (pattern, file) at extraction time, joined live against current `sitemap_files` at scan time | Old system's mapping is a static record joined against *current* file state (handles renames); current system's mapping is itself current, since files don't get renamed mid-run | Not a gap for the current product (no in-place file editing exists), but the *shape* (pattern-to-file index) is structurally the same idea, independently arrived at | Already equivalent in spirit; no change indicated |
| Candidate resolution | `resolveCandidates`: opens + streams the stored file per (pattern, distinct file) per verify job, stops at last-wanted ordinal, re-hashes for correctness (`resolve-candidates.ts:72-176`) | `patternFileScan.ts`'s `scanPatternFiles`: opens + streams each target file once per *call*, at concurrency 6, no re-hash/correctness check found | Old system trades correctness-checking for raw scan speed (its use case is "show me every URL," not "prove this exact URL was the one sampled"); current system's correctness check is load-bearing for statistical validity and has no analogue to drop | Current system's per-call grouping-by-file optimization is real but scoped to one pattern's one job — see §6 for the empirical gap this leaves | See §11 |
| File scanning | At most one open/stream per (pattern, distinct file) *within* one verify job; **no cross-pattern or cross-job sharing** | At most one open/stream per file *within* one `scanPatternFiles` call; cache-key module exists but **unconfirmed as wired to a cache anywhere in the copied source** | Structurally near-identical scoping; neither system has confirmed cross-call reuse | Both systems share the same unresolved question at different points | See §11 — measure before copying an unconfirmed idea |
| Caching/reuse | None found | `sourceFileScanKey.ts` cache-key builder exists; **no consumer found** | Old system's caching intent is not provable from what was copied | Cannot be cited as "proven" prior art for this specific gap | Do not adopt as-is; if built, must include the actual cache store and its invalidation proof, not just the key |
| Batching | Ingest is per-file, sequential across files within one accumulator pass; queue-level batching is per-pattern verify jobs | `runWithBoundedConcurrency` batches file copy+insert at concurrency 4; `scanPatternFiles` batches file scans at concurrency 6 | Old system explicitly bounds concurrency for file-level I/O; current system's file-level I/O (`resolveCandidates` calls inside `resolveAll`) runs **sequentially**, `for...of` (`verify.ts:268`) | A verify job resolving candidates across many distinct files pays that cost serially, not concurrently | Worth investigating: bounding `resolveAll`'s per-file resolution concurrency (§11) |
| Concurrency | BullMQ worker concurrency, default 1/stage, hard-capped at 1 for `estimate` specifically (fan-in correctness, `site-pipeline.ts:132-147`) | Generic `runWithBoundedConcurrency<TItem,TResult>` (`boundedConcurrency.ts:27`), concurrency chosen per call site (4 for ingest, 6 for file-scan) | Old system has one reusable, tested, generic pool; current system has no equivalent primitive for bounding intra-stage I/O concurrency | The current codebase has nothing structurally equivalent to reach for if `resolveAll`'s serial file resolution turns out to be the bottleneck | Adopt the *pattern* (a small, generic, tested bounded-concurrency helper), not the file — see §8 |
| Deduplication | `sample_observation` uniqueness on URL (ADR fixed from hash, M2); redelivery guard in `verify.ts` prevents re-probing | `keptBy` Map + byte-budget ledger for cross-file URL dedup at Cleaner scale | Different problem: old system dedups *content* across files pre-migration; current system dedups *observations* to avoid re-probing a live server | Not comparable — different purposes | No change indicated |
| Verification | HEAD-first, GET-on-suspicious, size-capped, rate-limited, circuit-broken (packages/verification) | HTTP HEAD/GET against DB-stored URLs, rate/concurrency bounded (`verifyThroughput.ts`) | Similar shape at the HTTP layer; current system's is more elaborated (circuit breaker, escalation cap) per ADR history | No gap found | No change indicated |
| Retry handling | BullMQ at-least-once + `verify.ts`'s `countObservations` redelivery guard (skip re-probe if observations exist) | `patternStructureJobClaim.ts` fingerprint-based idempotency (attach/replay/reject) for a different job class (transforms) | Old system's idempotency handles a *client-timeout-but-server-committed* race explicitly; current system's guard handles *BullMQ redelivery* explicitly — different races, both real | UNKNOWN whether the current pipeline has a client-timeout-but-worker-committed race analogous to the old system's documented one | UNKNOWN — requires additional investigation (would need to trace `apps/api`'s request/enqueue boundary for a timeout scenario, out of this report's scope) |
| DB writes | Parameterized, batched inserts (`upsertPatterns`, `writePopulations`, `appendSampleObservations`) | Parameterized queries via `pool.query` | No material difference found | — | No change indicated |
| DB reads | `listSitemapFiles`, `pattern_sample`/`pattern` lookups by id, `tallyObservations` aggregate | `pattern_file_occurrences` + `sitemap_files` join per scan call | Old system re-queries file state live per call (correctness under mutable files); current system's files are immutable per run so this isn't needed | Not a gap | No change indicated |
| Disk management | `LocalDiskFileStore`, no explicit budget/eviction found in the traced stages | `dedupBudget.ts`'s byte-ledger admission control, atomic temp-then-rename | Old system has an explicit, tested memory/disk admission guard for its highest-risk stage (Cleaner dedup); current system's 25M-run peaked at 1.4GB RSS against a stated 1,536MB non-negotiable-rule budget with no ledger-style guard visible in the traced code | At larger scale (the platform's own stated target, well beyond 25M), an unguarded admission path is a real risk class the old system already paid to solve | Worth adopting the *ledger pattern* (admission watermark, typed capacity error, per-unit charge/release) if/when a stage's memory profile is shown to need it — not needed today per the 25M benchmark's own headroom | 
| Benchmarking | `scripts/benchmark-scale.ts` drives real stage functions against a real local Postgres + real local HTTP server, JSON output with wall time, RSS, disk, per-table row counts, `samplingHealth` | Five `.ts`/`.mjs` scripts, each narrowly scoped (retry-waste, partial-copy correctness, throughput, stage timing) | Old system's benchmarks are narrower and more numerous, each isolating one mechanism; current system's is one broad end-to-end harness | Current harness cannot currently isolate "time spent in `resolveCandidates`" from "time spent in HTTP probing" within `verifyEstimateMs` — this is exactly the gap §11 proposes closing | Adopt the *narrow, mechanism-isolating benchmark* habit, not any specific old script |
| Observability | Structured pino logging per stage, `samplingHealth` snapshot (requests, escalations, circuit breaks) | Per-stage SSE progress events (`cleaner-sftp-stage-timing.mjs`), a stated but here-unverifiable BullMQ crash-recovery behavior | Old system has per-*sub-stage* timing (pull/parse/dedup/output/index/zip); current system's `samplingHealth` is per-*run*, not per-file or per-resolveCandidates-call | This is precisely the granularity gap that makes the leading hypothesis unproven | See §11 |
| Resume/recovery | BullMQ redelivery guard in `verify.ts`; `estimate`'s upsert is itself idempotent per the `verify.ts` comment (line 84) | Atomic rename (ingest), fingerprint-claim (transforms), `files_done` explicitly documented as a progress indicator, not a resume cursor (README) | Both systems accept that a crashed job redoes its own unit of work rather than resuming mid-unit; current system additionally protects against *re-probing* specifically (the highest-cost-to-repeat operation) | No gap found beyond what's already noted above | No change indicated |

---

## 5. Proven Scalability Techniques

For each: what it does, where, what problem it solves, why it helps at scale, whether an equivalent exists today, whether to adopt, risk, and whether it touches a protected algorithm.

1. **Atomic temp-then-rename writes** — `priorty_1/batchIngest.ts:136-166`. Prevents a partial file from being visible at its real path mid-copy, which would make a crash-then-resume skip-test misidentify a truncated file as complete. Matters at any scale where a copy can be interrupted. **No equivalent found** in the current platform's `LocalDiskFileStore` write path (not directly examined in this report's targeted reads; flagged as unknown, not confirmed absent). **Adopt**: low risk, small change, directly closes a known failure class if `LocalDiskFileStore.put` currently writes straight to the destination path. **Does not touch a protected algorithm.**

2. **Generic bounded-concurrency worker pool** — `priorty_1/boundedConcurrency.ts:27` (`runWithBoundedConcurrency`). Solves "run N tasks with a concurrency ceiling, index-aligned results, monotonic progress count" as a reusable, independently-testable primitive rather than ad hoc `Promise.all`/manual cursors at each call site. Helps at scale because it's the difference between a tunable ceiling and either unbounded concurrency (resource exhaustion) or hardcoded sequential (`verify.ts:268`'s current `for...of` over files, §11). **No equivalent exists today** in the current codebase (not found in any of the traced pipeline/sitemap/database packages). **Adopt as a pattern**: reimplement narrowly in `packages/sitemap` or `packages/pipeline` if `resolveAll`'s per-file resolution is shown to benefit from bounding (§11) — do not literally copy the file, since it imports nothing external and is ~70 lines of general-purpose TypeScript. Risk: low — it's pure, synchronous-claim, well-specified (three explicit contracts documented in its own comment). **Does not touch a protected algorithm**, but composing it around `resolveCandidates` would be exactly the kind of "two independently-correct pieces wired together" composition CODING_STANDARDS.md §1.13 calls out as this codebase's most common real bug source — any such change needs its own composition test, not just each piece's own tests.

3. **Process-wide dedup byte-budget ledger with typed capacity error** — `priorty_1/dedupBudget.ts:1-241`. Solves "don't let one huge run OOM the process" via an admission watermark (0.8 of budget) and per-unit charge/release rather than a fixed row/file-count cap. Helps at scale specifically because the failure mode it prevents (unbounded resident dedup state) is exactly what the current platform's Non-negotiable rule #4 ("never materialize a full URL population in memory") already exists to prevent by design — the current platform's answer to this problem is architectural (streaming, no full-population materialization) rather than a runtime ledger. **A different equivalent already exists** (the streaming design itself, validated at the 25M benchmark's 1.4GB RSS against a 1,536MB non-negotiable budget). **Do not adopt as-is** — it would be solving a problem the current architecture is designed not to have. Worth revisiting only if a future stage is shown to need bounded-but-nonzero in-memory accumulation the way the old Cleaner's dedup pass does (the current pipeline currently doesn't have an analogous accumulation point outside the already-bounded min-heap sampler, which is a protected algorithm — see below).

4. **Fingerprint-based job idempotency (attach-to-in-flight / replay-recently-completed / reject-as-busy)** — `priorty_3/patternStructureJobClaim.ts` (per the Explore pass; not independently re-read in full for this report). Solves a specific race: a client times out and retries while the server is still committing the original request, and naive retry double-applies a transform. Helps at scale because timeout/retry races become more frequent, not less, as request volume grows. **The current platform already has a narrower equivalent**: `verify.ts`'s `countObservations` redelivery guard (§2.3) — but it only covers BullMQ's own at-least-once redelivery, not a client-timeout-while-still-committing race at the API boundary. **UNKNOWN** whether such a race exists in the current `apps/api` → enqueue path — out of this report's scope to trace. **Do not adopt the file** — the current guard is simpler and fits the current job shape (verify jobs aren't user-request-triggered retries); if a timeout race is later found at the API boundary, the *fingerprint* technique (not this file) is the relevant prior art to revisit.

5. **Pattern-file cache-key derivation from a live-derived "files version" hash** (`sourceFileScanKey.ts:71-88`, `patternFilesVersion`) — solves cache-key staleness without an explicit invalidation call on every one of six-and-counting file-mutation paths, by making the key itself unreachable once any file changes. Elegant idea, **but its own codebase has no confirmed consumer of it** (§3.2) — it cannot be presented as *proven* prior art for solving the current platform's file-rescan question, only as an *idea* worth testing independently. **Do not adopt as proven** — if a cache is built for `resolveCandidates` results, this key-derivation idea is worth using, but the cache store, its size/TTL bounds, and a test proving it's actually consulted are the current platform's own responsibility to build and prove, not something to inherit as "already validated."

---

## 6. File-Scan / Candidate-Resolution Comparison

### Current: how many times can a sitemap file be opened/parsed/scanned/revisited for candidate resolution?

- **Within one verify job** (one pattern): at most once per **distinct file** its candidates reference, because `resolveAll` (`verify.ts:253-318`) groups candidates by `fileId` before calling `resolveCandidates`.
- **Across verify jobs** (different patterns): **no sharing exists**. If pattern A and pattern B both draw a candidate from file 42, `resolveCandidates` opens and streams file 42 once for A's job and once again, independently, for B's job. Nothing in `verify.ts`, `resolve-candidates.ts`, or the file store caches a resolution or a stream position across calls.
- **Across a retried job**: the redelivery guard means a *fully retried* job (BullMQ handing the same job back after full completion) skips resolution entirely. A job that fails **partway** through `resolveAll` (e.g., after resolving file 10 of 20 but before writing any `sample_observation` rows) is **not** covered by the guard — `countObservations` is checked once, before any resolution starts, so a partial-then-crashed attempt followed by a retry re-resolves every file from scratch, including the ones the failed attempt already resolved. This is a real gap, though its cost is bounded by how often a job fails partway through resolution specifically (not measured in this investigation).

**Empirical read on the 25M benchmark** (`docs/benchmarks/2026-09-09-25000000-urls-scale.json`), computed here from the report's own numbers, not asserted by either Explore pass:

- `urlsPerFile: 50000`, `filesParsed: 500` → 500 files × 50,000 URLs/file = 25,000,000, confirming files are 5x larger per-file than the 50K-URL benchmark's `urlsPerFile: 10000`.
- `postgres.rowsByTable.pattern_population: 9500` = exactly `19 patterns × 500 files`. Given `pattern_population` is one row per (pattern, file) that pattern actually appears in (`pattern-population.ts:26`), this means **every one of the 19 patterns has at least one URL in every one of the 500 files** in this synthetic corpus — patterns are not clustered into a handful of files each.
- `firstRoundSampleSize` (`packages/sampling/src/sample-plan.ts:70`, its own test file confirms) caps at **400** for a population as large as this benchmark's largest pattern (13.7M URLs, `topPatterns[0]`). A 400-candidate draw via the hash-based min-heap sampler, against a population spread across (up to) 500 files roughly evenly, would be expected — by a standard coupon-collector estimate, not a measured count — to land in somewhere in the range of 250-350 **distinct files**, not a small clustered subset. That is the opposite of the case `resolveAll`'s per-pattern file-grouping optimization was designed to help.
- `verifyEstimateMs` grew **~88x** (46,618ms → 4,120,024ms) while `samplingHealth.httpRequests` (the actual probe count) grew only **~8x** (845 → 6,730) and `getEscalations` grew **~7.8x** (145 → 1,125). A roughly-linear-in-probe-count cost model does not explain an 88x time increase from an 8x request increase. **This is the strongest evidence this report can offer that something other than raw HTTP probing dominates verify+estimate at this scale** — and the file-size growth (5x bigger files, meaning a longer average stream-to-ordinal per resolution) plus the estimated 250-350-distinct-files-per-large-pattern figure above are the most concrete, code-grounded candidates for what that "something" is.
- **This is a derived estimate from recorded benchmark metadata, not a direct instrumented measurement of `resolveCandidates` call counts or time.** Treat it as the specific, falsifiable hypothesis to test next (§11), not as a proven root cause.

### Prior art: how does it avoid or control this?

- `patternFileScan.ts`'s `scanSitemapLocs`-per-target-once (§3.3) is the same one-open-per-file-per-call scoping the current system has — **not a stronger guarantee**, just the same one, applied to a different call shape (a UI-triggered per-pattern breakdown rather than a queued verify job).
- `sourceFileScanKey.ts`'s cache-key idea, if it were actually wired to a cache (unconfirmed — §3.2, §5.5), would be the mechanism that closes exactly the gap identified above: reusing a resolved-file result across calls for different patterns that share a file, or across retries. **But this cannot be cited as proven prior art**, because no evidence in the copied material shows it was ever consulted by anything.
- `cleaner.ts`'s build-once-resolve-many dedup design (§3.5) is the clearest **proven** example of the old system solving an adjacent version of this exact class of problem — parse each source file's XML exactly once, ever, for a whole multi-phase pipeline, by materializing an intermediate flat representation the later phases re-read instead. This is architecturally the closest thing to "proven prior art directly on point," even though it's solving a dedup problem, not a sample-resolution problem.

---

## 7. Current Platform Rediscoveries

- The current platform's `resolveAll` grouping-by-file (§2.3) independently re-derives the same "batch reads by source file" instinct as `patternFileScan.ts`'s per-call scan — arrived at separately, same shape, same scope limitation (no cross-call sharing).
- `pattern_population`'s one-row-per-(pattern,file) index (§2.2) is structurally the same idea as `pattern_file_occurrences` (§3.2) — both are "which files does this pattern's population live in" indexes, built independently for different reasons (M1's schema work vs. the old system's edit-support need).
- The old system's own `sourceFileScanKey.ts` gap (a caching *idea* with no wired-up consumer) is a rediscovery risk in reverse: if the current platform builds a `resolveCandidates` cache without first proving it's the actual bottleneck (§11), it risks landing in the exact same unconfirmed-but-plausible-looking state the old system's own cache-key module is in today.

---

## 8. Techniques Worth Adopting

Ranked by confidence, all pending the instrumentation step in §11 before any implementation:

1. **A small, generic, tested bounded-concurrency helper** (pattern from `boundedConcurrency.ts`, §5.2) — for bounding `resolveAll`'s currently-sequential per-file resolution loop (`verify.ts:268`, a plain `for...of`), *if* instrumentation shows that loop is wall-clock significant and I/O-bound (not CPU-bound — see the Piscina section, §10). Low risk, no schema change, no algorithm change.
2. **Atomic temp-then-rename writes** for `LocalDiskFileStore`'s write path, *if* it currently writes directly to the destination (not confirmed either way in this report — worth a five-minute check before the next milestone regardless of the verify+estimate investigation, since it's a correctness gap independent of performance).
3. **Narrow, mechanism-isolating benchmark scripts** (the *habit*, from `priorty_2/`'s five scripts) as a complement to the existing broad `scripts/benchmark-scale.ts` harness — specifically, an instrumented pass that can report time-in-`resolveCandidates` separately from time-in-HTTP-probe within the verify stage (§11).

---

## 9. Techniques NOT Worth Adopting

- **`sourceFileScanKey.ts`'s caching mechanism as literally described** — its own codebase never confirms it's wired to a real cache; adopting it would be inheriting an unproven idea, not proven prior art, and would repeat the exact "invented, undocumented-as-provisional" mistake this project's own milestone history (D3c/D3g, per CLAUDE.md) has already paid down elsewhere.
- **`dedupBudget.ts`'s memory-ledger admission control** — solves a problem (unbounded in-memory dedup state) the current architecture avoids by design (streaming, no full-population materialization, Non-negotiable rule #4). Adopting it would add complexity for a failure mode the current design doesn't have.
- **The Cleaner's mutable, copy-on-write file model and `sitemap_files.filename` repointing** — specific to a system that lets users rename/redirect-fix/transform files in place. The current platform's files are immutable per run by design; adopting mutability would contradict the audit-not-migration product direction and reopen exactly the kind of "which version of this file is current" bookkeeping (`patternFileScan.ts`'s live join, §3.2) the current design doesn't need.
- **`patternStructureJobClaim.ts`'s full fingerprint-replay machinery** — built for a different job class (user-triggered, timeout-prone, double-apply-dangerous transforms). The current `verify` job's redelivery guard already fits its actual failure mode (BullMQ at-least-once) more simply; importing the heavier machinery wholesale would be solving a race not yet shown to exist here.
- **Any "100M+ proven at scale" framing carried over uncritically** — not evidenced by the material provided (§3.4); don't cite the old system's scale as settled justification for adopting any of its specific mechanisms without the mechanism's own evidence standing on its own.

---

## 10. Piscina

**Not recommended**, and not because CPU usage hasn't been checked, but because nothing traced in either system shows the *bottleneck workload* is CPU-bound:

- `resolveCandidates` is a **stream-and-compare** operation: open a file, walk `<loc>` elements via SAX parsing, hash-compare, stop early. This is I/O- and parse-throughput-bound, not compute-bound in the sense Piscina (CPU-bound work moved off the main thread) is built for — SAX parsing at this scale is not the kind of hot numeric loop Piscina pools in this codebase (per CODING_STANDARDS.md's own guidance) are reserved for.
- `estimate.ts` is DB-aggregation-bound (a `tallyObservations` SQL call plus arithmetic over the result), not CPU-bound.
- The 88x-time-vs-8x-request-volume gap identified in §6 is most plausibly **repeated-work-bound** (the same or similar files opened and streamed multiple times across patterns) rather than CPU-bound — repeated work doesn't get cheaper by parallelizing it across worker threads; it gets cheaper by not repeating it.
- The prior art's own Piscina usage (`patternFileRewrites.ts`'s rewrite pool, referenced by the Explore pass, and `patternRewriteScale.ts`'s benchmark) is for **file rewriting** (transforming and re-writing XML content), a genuinely CPU/serialization-heavy operation — not for file *scanning* or *resolution*, which is the operation under investigation here. This is not analogous prior art for a Piscina recommendation in verify/estimate.

If the instrumentation in §11 instead reveals CPU-bound time (e.g., in hashing or SAX parsing overhead itself, not I/O wait), that would be new evidence and this recommendation should be revisited — but nothing found in this investigation supports it today.

---

## 11. Recommended Next Change

**Add read-only instrumentation to the existing 25M-scale benchmark harness (`scripts/benchmark-scale.ts`) to measure, separately within the verify stage:**
1. Total wall time spent inside `resolveCandidates` calls (and a count of how many times it's called, and how many are for a file already resolved by an earlier call in the same benchmark run — i.e., cross-pattern file-open repetition).
2. Total wall time spent inside `verifyPattern`'s actual HTTP probing.
3. The distinct-file-count per pattern's candidate set, to directly measure (not estimate) how clustered or spread the min-heap sampler's draws actually are against this corpus's file layout.

This directly tests the hypothesis using the platform's own already-built benchmark infrastructure, at the same 25M scale the concerning numbers came from, without touching any production code path's behavior (only adding counters/timers around existing calls).

---

## 12. Why That Change

- The hypothesis is explicitly stated as unproven in the task brief, and this investigation's own reads confirm it is **plausible but not measured** (§6) — the 88x/8x mismatch is real and code-grounded, but it is a correlation across two benchmark runs, not an instrumented root-cause measurement.
- `estimate.ts` is definitively ruled out as a file-I/O source (§2.4), so the investigation is correctly scoped to `verify`.
- The prior art's own analogous caching idea was never proven wired-up in its own codebase (§3.2, §9) — copying it now, without first confirming the current platform's actual bottleneck shape, would repeat an unverified assumption rather than apply a proven technique, and risks solving a problem (or solving it in the wrong place) that instrumentation might show doesn't match the real cost distribution (e.g., if it turns out `verifyPattern`'s own escalation/soft-404-sniffing HTTP-request pattern dominates instead — `getEscalations` did grow 7.8x, comparable to the 8x request growth, but the *time* growth is 11x that ratio).
- This satisfies the brief's explicit instruction not to choose a fix until evidence supports it, and keeps the change minimal, reversible, and non-production (counters/timers only).

---

## 13. What Must NOT Be Changed

Per the task brief's protected-algorithms list, and confirmed by this investigation to still apply:
- The prefix-trie pattern extraction (ADR-0012) — not touched or implicated by this investigation; the old system's own extraction algorithm wasn't even part of the copied material to compare against.
- Adaptive sampling / deterministic hash sampling (the min-heap sampler, `firstRoundSampleSize`, Wilson/FPC math in `packages/sampling`) — the 400-candidate cap and the hash-based draw are exactly what's being *measured against* in §6, not what's being proposed for change. Nothing in this report proposes altering sample size, sample selection, or confidence math.
- Verification correctness logic (HEAD-first/GET-on-suspicious, escalation cap, circuit breaker) — untouched; §10 explicitly rules out a Piscina change here too.
- `resolveCandidates`'s hash re-check and fatal-on-mismatch behavior (§2.3) — this is a correctness guarantee, not the performance question under investigation, and must not be weakened even if a future caching layer is built around it (a cached resolution result must still be validated the same way a fresh one is, or the correctness guarantee silently becomes "usually correct").

---

## 14. Proposed Validation Plan

1. Implement the read-only counters/timers described in §11 as a small, isolated addition to `scripts/benchmark-scale.ts` and the stage functions it calls (behind existing dependency-injection seams — `deps.ts` already allows this without touching BullMQ or production wiring).
2. Re-run the existing 25M-URL benchmark corpus (already built and benchmarked once — no new corpus generation needed) with instrumentation enabled.
3. Compare instrumented `resolveCandidates` time + call count against total `verifyEstimateMs`, and cross-check the distinct-file-count-per-pattern measurement against this report's §6 coupon-collector estimate.
4. Only after that data exists: decide between (a) bounding `resolveAll`'s per-file resolution concurrency (§8.1), (b) a cross-call resolution cache scoped and proven the way §9 requires (not the unproven prior-art version), (c) some other cause the instrumentation surfaces that this report didn't anticipate, or (d) no change, if the numbers show the time is legitimately dominated by HTTP-probe latency/escalation behavior instead.
5. Any resulting change gets its own regression test for the composition (per CODING_STANDARDS.md §1.13) — not just a unit test of whichever piece changes — since this is exactly the class of "independently-correct pieces wired together" defect this codebase has repeatedly found in exactly this kind of cross-stage change.

---

## 15. Decision: Ready for Implementation or More Investigation Required

**More Investigation Required.**

The comparison in this report narrows the search space (rules out `estimate.ts`, rules out the prior art's unproven caching idea as citable evidence, produces a specific, falsifiable, code-grounded hypothesis about file-open repetition inside `verify`) but does not itself measure the actual time distribution inside the verify stage. §11-14 name the smallest concrete step to get that measurement before any redesign, caching, batching, or concurrency change is implemented.
