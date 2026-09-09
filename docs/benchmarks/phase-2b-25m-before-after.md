# Phase 2B.1 — 25M-URL benchmark, before vs. after instrumentation

Companion to `docs/reports/phase-2b-prior-art-analysis.md`. That report concluded **"More
Investigation Required"** and named a specific next step (§11–14): add read-only
timing/counting instrumentation to `verify` and re-run the existing 25M benchmark, rather than
implement any of its unproven candidate optimizations. This document is that measurement.

**No optimization was implemented in this milestone.** `packages/pipeline`'s `verify` stage
gained one optional, no-op-by-default hook (`PipelineDeps.onVerifyTelemetry`); nothing about
`resolveCandidates`, `resolveAll`'s file-grouping, `verifyPattern`, the sampler, or the
confidence math changed. A composition test (`packages/pipeline/src/stages/verify.test.ts`)
asserts `runVerify`'s result and the rows it writes are identical whether the hook is present or
absent — the thing being measured is verified not to be a side effect of the measuring.

## An operational mistake, disclosed rather than hidden

`scripts/benchmark-scale.ts` names its report file `${date}-${totalUrls}-urls-scale.json`, where
`date` is today's calendar date. The original 25M benchmark the prior-art report analyzed also
ran on 2026-09-09. Re-running the same benchmark today **silently overwrote that file** —
`docs/benchmarks/2026-09-09-25000000-urls-scale.json` now holds this milestone's run, not the
original one, and `docs/benchmarks/` was never under git version control (confirmed via
`git status`: untracked), so there is no tracked copy to recover either.

The "before" figures below are therefore **reconstructed**, not re-read, from two sources
captured earlier in this same working session, before the file was overwritten:
1. A direct read of the original JSON's first 19 lines (`startedAt` through `peakRssBytes`) —
   exact values, not approximations.
2. `docs/reports/phase-2b-prior-art-analysis.md` §6 and its Executive Summary, which quotes
   several exact figures from the same original run (`samplingHealth.httpRequests`,
   `getEscalations`, `pattern_population` row count, `topPatterns[0]`'s population) as part of
   its own analysis.

Fields the original run wrote that were captured in neither source (Postgres row counts for
tables other than `pattern_population`, disk figures, CPU figures, the full `topPatterns` list,
`httpRequestsServed`) are marked **not available** below rather than guessed at. This gap is a
direct, avoidable consequence of not renaming/copying the original report before re-running the
benchmark — worth fixing in the benchmark script itself (a monotonic run id or timestamp-to-the-
second in the filename, not just the date) before the next 25M-or-larger run, so this doesn't
repeat at 50M.

## Field-by-field comparison

| Field | Before (reconstructed) | After (this run) | Note |
|---|---|---|---|
| `urls` / `urlsPerFile` / `filesParsed` | 25,000,000 / 50,000 / 500 | 25,000,000 / 50,000 / 500 | same corpus config, per the task brief's "do not change benchmark variables" rule |
| `patternCount` / `samplesDrawn` | 19 / 19 | 19 / 19 | identical — corpus generation is deterministic |
| `discoverMs` | 625.9 ms | 265.4 ms | both negligible against the run total |
| **`ingestMs`** | 720,194.0 ms (12.00 min) | 704,282.6 ms (11.74 min) | untouched by this change; within normal run-to-run variance |
| **`verifyEstimateMs`** | 4,120,024.4 ms (68.67 min) | 2,109,460.0 ms (35.16 min) | see "On the wall-clock delta" below — **not** attributable to the instrumentation itself |
| `finalizeMs` | 48.3 ms | 61.7 ms | negligible |
| **`totalWallMs`** | 4,841,064.6 ms (80.68 min) | 2,814,874.8 ms (46.91 min) | sum of the above |
| `ingestThroughputUrlsPerSec` | 34,712.9 | 35,497.1 | consistent |
| **`peakRssBytes`** | 1,514,184,704 (1,444.4 MB) | 1,482,805,248 (1,414.1 MB) | ~2% lower, negligible — instrumentation's memory footprint (a few counters and a `Set<number>` of ≤500 file ordinals) is not observable against a 1.4 GB run |
| `ingestPeakRssBytes` | not available | 1,468,272,640 (1,400.3 MB) | — |
| `cpuUserMicros` / `cpuSystemMicros` | not available | 1,731,360,000 / 204,922,000 | — |
| `diskPeakBytes` / `finalDiskBytes` | not available | 1,789,678,135 / 1,789,678,135 (1,706.8 MB) | — |
| `postgres.totalBytes` | not available | 6,578,176 (6.3 MB) | — |
| `postgres.rowsByTable.pattern_population` | 9,500 (quoted, report §6) | 9,500 | identical — confirms 19 patterns × 500 files, same as the report's own cross-check |
| `postgres.rowsByTable` (other tables) | not available | `audit_snapshot` 19, `pattern` 19, `pattern_sample` 19, `sample_observation` 5,605, `sitemap_file` 500 | — |
| `httpRequestsServed` | not available | 9,621 | — |
| **`samplingHealth.httpRequests`** | 6,730 (quoted, report §6) | 6,730 | identical — the probe count itself is unaffected, as expected |
| **`samplingHealth.getEscalations`** | 1,125 (quoted, report §6) | 1,125 | identical |
| `samplingHealth.patternsLowConfidence` | not available | 5 | — |
| `topPatterns[0]` (largest pattern) | `/part/{param}`-shaped, ~13.7M population (quoted, report §6) | `/part/{param}`, 13,746,335 | consistent |
| **`verifyTelemetry.resolveCandidatesMs`** | not instrumented — this is the metric this milestone exists to produce | 1,709,900.4 ms | **81.1% of `verifyEstimateMs`** |
| **`verifyTelemetry.resolveCandidatesCalls`** | not instrumented | 3,885 | — |
| **`verifyTelemetry.resolveCandidatesRepeatFileCalls`** | not instrumented | 3,385 | **87.1% of all resolveCandidates calls are a file some earlier pattern's job already opened and streamed this run** |
| **`verifyTelemetry.verifyProbeMs`** | not instrumented | 388,828.6 ms | 18.4% of `verifyEstimateMs` |
| `verifyTelemetry.verifyProbeCalls` | not instrumented | 19 | one per pattern, as expected |
| **`verifyTelemetry.distinctFilesPerPattern`** | not instrumented (report §6 estimated 250–350 via a coupon-collector calculation) | min 2, p50 274, p95 287, max 287, mean 204.5 | measured, not estimated — see below |

## On the wall-clock delta (verifyEstimateMs: 68.7 min → 35.2 min)

This is a **~49% drop with zero behavior change** — confirmed by the composition test, and by
`samplingHealth.httpRequests`/`getEscalations` landing on the exact same values in both runs
(6,730 and 1,125), which means the two runs probed the identical set of URLs with the identical
outcomes. Nothing about what the code *does* changed; only how long it took to do it changed.

This is not evidence the instrumentation made anything faster — adding two `performance.now()`
calls and a closure invocation per file cannot plausibly save 33 minutes. It is evidence that
**this benchmark's wall-clock time has enough run-to-run variance (here, close to 2x) that a
single before/after pair of wall-clock numbers is not, by itself, trustworthy evidence of
anything** — a materially stronger version of the caution the prior-art report already raised in
§12 about the original 88x/8.7x mismatch being "a correlation across two benchmark runs, not an
instrumented root-cause measurement." Likely contributors: this is a shared development machine,
not an isolated benchmark host, and the two runs happened at different times of day (07:08 vs.
10:47 local) under unknown and uncontrolled background load. **This is itself worth carrying
forward**: before drawing a conclusion from wall-clock deltas across separate 25M+ runs on this
machine, either control for background load or run multiple repetitions — a gap this milestone's
own before/after comparison exposed by tripping over it, not one it set out to look for.

This is precisely why the *internal* breakdown below — proportions and call counts measured
**within one run**, not deltas **across** runs — is the credible evidence this document rests its
conclusion on, not the wall-clock comparison above.

## Answering the report's two open questions

**Does `resolveCandidates` time and call-repetition actually dominate `verifyEstimateMs`, as
hypothesized but not measured in §12?**

Yes, now measured directly rather than inferred:
- `resolveCandidates` calls account for **81.1%** of `verifyEstimateMs` wall time
  (1,709.9 s of 2,109.5 s); `verifyPattern`'s actual HTTP probing accounts for 18.4%
  (388.8 s) — the remaining ~0.5% is DB writes, the redelivery guard, and per-job logging.
- Of the 3,885 total `resolveCandidates` calls, **3,385 (87.1%) are for a file some earlier
  pattern's verify job already opened and streamed to completion in this same run.** Exactly
  500 calls — one per file in the corpus — are a file's first open; every file is reopened an
  average of **7.77 times** across different patterns' jobs (3,885 ÷ 500).
- This confirms the report's central, previously-unproven hypothesis (§2.3, §6): `resolveAll`'s
  existing per-pattern file-grouping optimization is real and correctly scoped, but the gap it
  leaves — **no sharing of a resolved file across different patterns' verify jobs** — is not a
  theoretical concern, it is the dominant cost in this stage at this scale.

**Is the distinct-file-count per pattern close to the report's coupon-collector estimate of
250–350 files?**

Close, and now measured rather than estimated: **p50 = 274 files, p95 = 287, max = 287** —
inside the estimated range for the run's larger patterns. The **mean of 204.5** sits lower, pulled
down by smaller patterns (min = 2 distinct files, almost certainly one of the run's
smaller-population patterns, well under the 400-candidate cap). The report's estimate was
directionally correct for the patterns it was modeling (large, high-population ones) and the
measured distribution confirms it rather than overturning it.

## What this means for Phase 2B.2

The report's own §14 decision framework named four outcomes once instrumentation existed: (a)
bound `resolveAll`'s per-file resolution concurrency, (b) a cross-call resolution cache "scoped
and proven the way §9 requires," (c) some other cause the data surfaces, or (d) no change, if
HTTP-probe latency turns out to dominate instead.

The measurement rules out (d) outright (probing is 18.4% of the time, not the majority) and
rules out (c) — nothing unanticipated surfaced; the cost is exactly where the hypothesis said it
would be. Between (a) and (b): **bounding concurrency parallelizes independent I/O, but 87.1% of
this stage's file opens are not independent work — they are the same file, already resolved once
this run, being opened and streamed again.** Concurrency makes redundant work faster to redo; it
does not stop it being redundant. The report's own §9 already rejected copying the prior art's
`sourceFileScanKey.ts` cache-key idea *as proven prior art* (its own codebase never confirmed a
consumer existed) — but that objection was about **evidence**, not about the idea being wrong,
and this milestone's measurement is exactly the evidence that was missing: a proven, scoped,
same-run cross-pattern cache for `resolveCandidates` results (keyed at minimum by `(runId,
fileId)`, invalidated by nothing beyond the process lifetime since sitemap files are immutable
per run — see CLAUDE.md's repo-layout notes) is now the evidence-backed candidate for Phase 2B.2,
not a guess.

Any such cache must, per the report's §13 (restated in this milestone's plan): preserve
`resolveCandidates`'s hash re-check and fatal-on-mismatch behavior on every lookup, cached or not
— a cached result must be exactly as trustworthy as a fresh one, not "usually correct" — and per
CODING_STANDARDS.md §1.13, ship with its own composition test proving the cache and the
correctness check don't quietly disagree once wired together, not just a unit test of the cache
in isolation.

## Verdict

> **OPTIMIZATION NOT PROVEN**

No optimization was attempted in this milestone — by design, following the prior-art report's own
"More Investigation Required" conclusion and the task brief's stop-and-report-evidence-needed
clause rather than guessing at a fix. What this milestone delivers instead is the measurement the
report said was missing, and that measurement now **positively confirms** the report's leading
hypothesis (cross-pattern file-open repetition dominates `verify`'s wall time) with hard numbers:
81.1% of stage time inside `resolveCandidates`, 87.1% of those calls provably redundant. The next
step — a proven, correctness-preserving cross-call cache — is now evidence-based rather than
speculative, and is recommended as Phase 2B.2. Per the task brief's own instruction, this is not
proceeding to 50M automatically; that decision belongs to whoever reviews this report next, and
should wait until Phase 2B.2's cache (or another evidence-based fix) actually exists to test.
