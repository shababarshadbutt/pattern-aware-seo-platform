import { stableHash } from "@pattern-aware/sampling";

import { parseLoc } from "../extraction/url-path.js";
import { streamLocs } from "../parser/loc-stream.js";
import type { SitemapFileStore, StoredFileKey } from "../store/file-store.js";

/**
 * Turn sample candidates back into URLs.
 *
 * The sampler stores a `(hash, fileId, ordinal)` triple rather than a URL
 * string — 12 bytes instead of ~80, which is what keeps a 5,000-pattern site's
 * sample state in tens of megabytes instead of hundreds. The cost of that
 * choice is paid here: verification needs actual URLs, so the file is re-read
 * and counted back to the ordinal.
 *
 * This is the seam between sampling and verification, and it is the one place
 * where a silent error would be invisible everywhere downstream: probe the
 * wrong URL, and the observation is recorded against the right candidate with
 * a wrong result. So every resolved URL is checked against the hash the
 * sampler stored, and a mismatch is fatal rather than a warning.
 */

/** The parts of a stored candidate resolution needs. */
export interface CandidateToResolve {
  readonly hash: number;
  readonly ordinal: number;
}

export interface ResolvedCandidate {
  readonly ordinal: number;
  readonly hash: number;
  /** Absolute URL, exactly as the sitemap wrote it. What gets probed. */
  readonly url: string;
  /** Path plus query — the value that was hashed. */
  readonly path: string;
}

export interface ResolveCandidatesOptions {
  /** Site base URL, for resolving relative `<loc>` values. */
  readonly baseUrl: string;
  /** Expected host, so a foreign `<loc>` is not silently probed. */
  readonly expectedHost: string;
  readonly isGzip?: boolean;
}

/**
 * Raised when a file no longer yields the URLs its candidates were drawn from.
 *
 * Loud on purpose. The alternative — resolving what it can and returning a
 * short list — would shrink the sample without shrinking `n`, inflating every
 * interval computed from it while looking like an ordinary success.
 */
export class CandidateResolutionError extends Error {
  public override readonly name = "CandidateResolutionError";
}

/**
 * Resolve candidates from one stored sitemap file.
 *
 * Stops as soon as the last wanted ordinal is seen, so drawing twelve URLs
 * from the front of a 50,000-URL file costs a partial read.
 *
 * WHY THE HASH IS RE-CHECKED AND NOT THE FILE DIGEST. A digest proves the bytes
 * are unchanged, which is a proxy for what actually matters: that this ordinal
 * still holds the URL the sampler hashed. Re-hashing the resolved path tests
 * that directly and per candidate. It is also strictly more useful — a sitemap
 * regenerated with the same URLs in the same order is a digest mismatch but a
 * correct resolution, while a shifted URL is caught either way. The stored
 * digest stays useful for detecting churn between runs; it is not the guard
 * here.
 */
export async function resolveCandidates(
  store: SitemapFileStore,
  key: StoredFileKey,
  candidates: readonly CandidateToResolve[],
  options: ResolveCandidatesOptions
): Promise<readonly ResolvedCandidate[]> {
  if (candidates.length === 0) {
    return [];
  }

  const wanted = new Map<number, CandidateToResolve>();

  for (const candidate of candidates) {
    wanted.set(candidate.ordinal, candidate);
  }

  const lastWanted = Math.max(...wanted.keys());
  const resolved = new Map<number, ResolvedCandidate>();
  const source = await store.open(key);

  /**
   * FAILURES ARE CARRIED OUT, NOT THROWN FROM THE CALLBACK.
   *
   * `streamLocs` settles a parse failure through one path that deliberately
   * rewrites the error: when junk was stripped from the front of the file and
   * the document still failed, it reports a preamble error instead, because the
   * raw XML complaint would send the reader after a phantom syntax problem.
   * Correct for parse errors — and it would swallow this function's errors too,
   * turning a hash mismatch on a preamble-stripped file into a misleading
   * "not recoverable preamble" report. So the failure is recorded, the stream is
   * asked to stop, and the throw happens out here where nothing rewrites it.
   * Do not "simplify" this back into a throw.
   */
  let failure: CandidateResolutionError | undefined;

  await streamLocs(
    source,
    (loc, ordinal) => {
      const candidate = wanted.get(ordinal);

      if (candidate === undefined) {
        // Not sampled. Counting past it is the whole cost of this design.
        return ordinal < lastWanted;
      }

      const parsed = parseLoc(loc, options.baseUrl, options.expectedHost);

      if (parsed.kind !== "matched") {
        failure = new CandidateResolutionError(
          `run ${key.runId} file ${key.fileId} ordinal ${ordinal} was sampled as a site URL but now parses as ${parsed.kind}: ${parsed.sourceUrl}`
        );

        return false;
      }

      const actual = stableHash(parsed.path);

      if (actual !== candidate.hash) {
        failure = new CandidateResolutionError(
          `run ${key.runId} file ${key.fileId} ordinal ${ordinal} hashes to ${actual}, but was sampled as ${candidate.hash} — the file's URLs have shifted since ingestion, so this ordinal no longer identifies the URL that was drawn (resolved: ${parsed.path})`
        );

        return false;
      }

      resolved.set(ordinal, {
        ordinal,
        hash: candidate.hash,
        url: parsed.sourceUrl,
        path: parsed.path
      });

      return ordinal < lastWanted;
    },
    options.isGzip === true ? { isGzip: true } : {}
  );

  if (failure !== undefined) {
    throw failure;
  }

  if (resolved.size !== wanted.size) {
    const missing = [...wanted.keys()]
      .filter((ordinal) => !resolved.has(ordinal))
      .sort((a, b) => a - b);

    throw new CandidateResolutionError(
      `run ${key.runId} file ${key.fileId} ended before ${missing.length} sampled ordinal(s) [${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}] — the file is shorter than when it was ingested`
    );
  }

  // Returned in the candidates' own order, so a caller zipping results back
  // against its input does not have to sort.
  return candidates.map((candidate) => {
    const hit = resolved.get(candidate.ordinal);

    if (hit === undefined) {
      throw new CandidateResolutionError(
        `run ${key.runId} file ${key.fileId} ordinal ${candidate.ordinal} unresolved`
      );
    }

    return hit;
  });
}
