/**
 * FNV-1a, 32-bit.
 *
 * Ported verbatim in behaviour from the legacy engine's `stableHash`
 * (`triageSampling.ts`), and kept identical on purpose: it is the basis of
 * sample reproducibility, so changing it would silently invalidate every stored
 * `k_threshold_hash` and make old and new draws incomparable. If it ever must
 * change, that is a new `sample_method` enum value and a migration, not an edit
 * here.
 *
 * Not cryptographic and does not need to be — its job is to permute, not to
 * hide. What it must be is stable across processes, machines and releases,
 * which rules out anything seeded by the runtime.
 *
 * ON COLLISIONS AT SCALE. A 32-bit space and 40 million URLs collide often —
 * roughly 186,000 times, by the birthday bound. That is harmless here, and
 * worth being explicit about because it looks alarming:
 *
 *   - Selection is unaffected. Two distinct URLs that hash alike are two
 *     distinct candidates; if that hash is small enough both are retained, and
 *     neither displaces the other.
 *   - Uniqueness downstream is on the URL, never the hash — see migration 0001,
 *     which corrects exactly this mistake.
 *   - Ties are broken deterministically on `(hash, fileId, ordinal)` by
 *     {@link compareSampleKeys}, so a colliding pair always orders the same way
 *     and a re-run draws the same sample.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // hash * 16777619 in 32-bit arithmetic, without overflowing into a double.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

/**
 * Total order over sample candidates: smallest hash first, ties broken by the
 * position the URL was found at.
 *
 * The tie-break is what makes a draw reproducible rather than merely
 * distributionally correct. At the selection boundary — where K candidates have
 * been kept and more share the threshold hash — an arbitrary choice between
 * equals would make two runs over identical input disagree about which URLs
 * were sampled, and a user watching the number move could not tell sampling
 * noise from a real change on the client's site.
 *
 * `(fileId, ordinal)` is a position in the sitemap set, which is fixed for a
 * given run, so the order it imposes is total and stable.
 */
export function compareSampleKeys(
  aHash: number,
  aFileId: number,
  aOrdinal: number,
  bHash: number,
  bFileId: number,
  bOrdinal: number
): number {
  if (aHash !== bHash) {
    return aHash - bHash;
  }

  if (aFileId !== bFileId) {
    return aFileId - bFileId;
  }

  return aOrdinal - bOrdinal;
}
