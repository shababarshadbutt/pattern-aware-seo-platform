/*
 * The extraction subtree is re-exported wholesale from its own barrel rather
 * than file by file, so `.` and `./extraction` cannot drift into publishing
 * different sets. `./extraction` exists because this barrel also pulls in
 * `node:fs`, `sax` and a fixture generator — see `extraction/index.ts`.
 */
export {
  type AccumulatedPattern,
  type AccumulatorResult,
  type ForeignLoc,
  isSameHost,
  LocObserver,
  type LocObserverOptions,
  type LocParseResult,
  normalizeHost,
  PARAM_MIN_OBSERVED_URLS,
  PARAM_SEGMENT,
  PARAM_UNIQUE_RATIO_THRESHOLD,
  PARAM_UNIQUE_THRESHOLD,
  type ParsedLoc,
  PatternAccumulator,
  type PatternAccumulatorOptions,
  PatternTrie,
  parseLoc,
  segmentsFromTemplate,
  type TerminalFactory,
  templateArity,
  templateForSegments,
  templateParamCount,
  type UnparseableLoc
} from "./extraction/index.js";
export {
  type ParseFileOptions,
  type ParseFileResult,
  parseSitemapFile,
  parseSitemapStream,
  type SitemapFileSource
} from "./ingest/parse-file.js";
export {
  CandidateResolutionError,
  type CandidateToResolve,
  type ResolveCandidatesOptions,
  type ResolvedCandidate,
  resolveCandidates
} from "./ingest/resolve-candidates.js";
export {
  assessSize,
  type OversizeThresholds,
  type OversizeVerdict,
  sampleRateMultiplierFor
} from "./ingest/thresholds.js";
export {
  type LocCallback,
  NotASitemapError,
  type SitemapRootElement,
  type StreamLocsOptions,
  type StreamLocsResult,
  streamLocs
} from "./parser/loc-stream.js";
export {
  hasRecognizedSitemapStart,
  isNonRecoverablePreambleError,
  NON_XML_PREAMBLE_MESSAGE,
  NonRecoverablePreambleError,
  PREAMBLE_PEEK_BYTES
} from "./parser/preamble.js";
export {
  LocalDiskFileStore,
  type SitemapFileStore,
  type StoredFile,
  type StoredFileKey,
  StoredFileMissingError
} from "./store/file-store.js";
export {
  generateSyntheticCorpus,
  parseCorpusArgs,
  SYNTHETIC_CORPUS_DEFAULTS,
  type SyntheticCorpusOptions
} from "./testing/synthetic-corpus.js";
