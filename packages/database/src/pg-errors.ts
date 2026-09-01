/**
 * Reading the useful part out of a failed query.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose message is the SQL
 * text, and hangs the original `pg` error off `cause`. So the two things worth
 * branching on — the SQLSTATE code and the constraint that was violated — are
 * never on the error you actually catch. Checking `error.code` directly looks
 * right, compiles, and silently never matches, which is a bad failure mode for
 * code whose job is to distinguish "somebody else got there first" from "this
 * is broken".
 *
 * Depth is bounded rather than looped to exhaustion: a cause chain that long is
 * a bug in something else and is not worth hanging on.
 */
const MAX_CAUSE_DEPTH = 6;

function walk<T>(error: unknown, read: (candidate: object) => T | undefined) {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }

    const found = read(current);

    if (found !== undefined) {
      return found;
    }

    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/** The SQLSTATE code, e.g. `23505` for a unique violation. */
export function pgErrorCode(error: unknown): string | undefined {
  return walk(error, (candidate) => {
    const code = (candidate as { code?: unknown }).code;

    return typeof code === "string" ? code : undefined;
  });
}

/** The name of the constraint that rejected the statement. */
export function pgConstraintName(error: unknown): string | undefined {
  return walk(error, (candidate) => {
    const constraint = (candidate as { constraint?: unknown }).constraint;

    return typeof constraint === "string" ? constraint : undefined;
  });
}

/** SQLSTATE 23505 — a unique index or constraint rejected the row. */
export function isUniqueViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}

/** SQLSTATE 23514 — a CHECK constraint rejected the row. */
export function isCheckViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23514";
}
