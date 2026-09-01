/**
 * The statistical core.
 *
 * M2 lands the collection primitive — the bounded min-heap by hash — because
 * the single-pass ingestion in packages/sitemap cannot draw a reproducible
 * sample without it. M3 adds the estimation layer on top: Wilson score
 * intervals with finite-population correction, stratification, and adaptive
 * expansion.
 */
export {
  BoundedHashSample,
  type SampleCandidate
} from "./bounded-hash-sample.js";
export { compareSampleKeys, stableHash } from "./stable-hash.js";
