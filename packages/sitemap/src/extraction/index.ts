/**
 * Pattern extraction, and nothing that touches a disk, a socket or a parser.
 *
 * THIS SUBPATH EXISTS FOR ITS DEPENDENCY GRAPH, NOT ITS CONTENTS. Every symbol
 * below is already public through the package root; importing them from `.`
 * would work and would also evaluate `node:fs`, `node:zlib`, `sax` and a test
 * fixture generator holding `rmSync`, because the root barrel re-exports the
 * parser, the file store and the synthetic corpus. That is the wrong shape to
 * pull into a request-serving API process in order to reuse four pure
 * functions.
 *
 * So this is NARROWER, NOT WIDER — the same test `packages/database/testing`
 * had to pass (ADR-0023), applied to dependency rather than authority. It
 * grants nothing `.` withholds. `packages/database`'s single entry point is
 * load-bearing for a different reason: `client.ts` really does export
 * `internalDatabase`, and the exports map is the only thing making it
 * unreachable, which is what ADR-0004's compile-time tenancy guarantee rests
 * on. Nothing here grants that kind of authority, so nothing here needs hiding.
 *
 * `entry-points.test.ts` enforces the contract rather than trusting this
 * comment: it walks every file under `src/extraction/` and fails if one imports
 * a `node:` builtin or a third-party module.
 */

export {
  LocObserver,
  type LocObserverOptions
} from "./loc-observer.js";
export {
  type AccumulatedPattern,
  type AccumulatorResult,
  PatternAccumulator,
  type PatternAccumulatorOptions
} from "./pattern-accumulator.js";
export {
  PARAM_MIN_OBSERVED_URLS,
  PARAM_SEGMENT,
  PARAM_UNIQUE_RATIO_THRESHOLD,
  PARAM_UNIQUE_THRESHOLD,
  PatternTrie,
  type TerminalFactory
} from "./pattern-trie.js";
export {
  segmentsFromTemplate,
  templateArity,
  templateForSegments,
  templateParamCount
} from "./template.js";
export {
  type ForeignLoc,
  isSameHost,
  type LocParseResult,
  normalizeHost,
  type ParsedLoc,
  parseLoc,
  type UnparseableLoc
} from "./url-path.js";
