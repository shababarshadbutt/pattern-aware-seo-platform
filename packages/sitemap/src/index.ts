export {
  type AccumulatedPattern,
  type AccumulatorResult,
  PatternAccumulator,
  type PatternAccumulatorOptions
} from "./extraction/pattern-accumulator.js";
export {
  PARAM_MIN_OBSERVED_URLS,
  PARAM_SEGMENT,
  PARAM_UNIQUE_RATIO_THRESHOLD,
  PARAM_UNIQUE_THRESHOLD,
  PatternTrie,
  type TerminalFactory
} from "./extraction/pattern-trie.js";
export {
  segmentsFromTemplate,
  templateArity,
  templateForSegments,
  templateParamCount
} from "./extraction/template.js";
export {
  type ForeignLoc,
  isSameHost,
  type LocParseResult,
  normalizeHost,
  type ParsedLoc,
  parseLoc,
  type UnparseableLoc
} from "./extraction/url-path.js";
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
