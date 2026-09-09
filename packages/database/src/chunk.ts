/**
 * Split a bulk insert into statements that stay under Postgres's bind-parameter
 * ceiling.
 *
 * `INSERT ... VALUES` binds one parameter per column per row, and Postgres
 * refuses a statement past 65,535 total parameters. Nothing enforced that here
 * before this module existed: `upsertSitemapFiles`, `upsertPatterns`, and
 * `upsertPatternPopulations` each built one `.values(entireArray)` call, which
 * is fine at demo scale and a hard query failure once a run's file or pattern
 * cardinality gets large enough — exactly the shape a 50-90M-URL site produces
 * (thousands of files, thousands of patterns, and a population-index row per
 * pattern-per-file combination).
 *
 * The chunk size is derived from how many columns a row actually has, not one
 * constant reused everywhere: a 4-column row and a 6-column row hit the same
 *65,535-parameter ceiling at different row counts, and hardcoding one number
 * either wastes headroom on the narrow table or silently reintroduces the
 * failure on a wider one the day its column count grows.
 */

/** Comfortably under Postgres's 65,535-per-statement bind-parameter limit. */
const DEFAULT_MAX_BIND_PARAMS = 60_000;

/**
 * Group `rows` into chunks that each bind at most `maxBindParams` parameters.
 *
 * Returns `[rows]` unchanged (as a single chunk) when `rows` already fits —
 * callers do not need to special-case the common, small-N path.
 */
export function chunkRows<T>(
  rows: readonly T[],
  columnsPerRow: number,
  maxBindParams: number = DEFAULT_MAX_BIND_PARAMS
): T[][] {
  if (columnsPerRow <= 0) {
    throw new RangeError(
      `columnsPerRow must be positive, got ${columnsPerRow}`
    );
  }

  const rowsPerChunk = Math.max(1, Math.floor(maxBindParams / columnsPerRow));

  if (rows.length <= rowsPerChunk) {
    return rows.length === 0 ? [] : [[...rows]];
  }

  const chunks: T[][] = [];

  for (let index = 0; index < rows.length; index += rowsPerChunk) {
    chunks.push(rows.slice(index, index + rowsPerChunk) as T[]);
  }

  return chunks;
}
