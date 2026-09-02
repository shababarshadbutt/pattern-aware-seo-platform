/**
 * Which implementation of the maths produced a stored estimate.
 *
 * Written to `audit_snapshot.estimator_version` on every published claim.
 * Without it, a later correction to the estimator silently makes old and new
 * rows incomparable while they look identical — and the whole point of that
 * table is that a claim stays defensible months after it was made.
 *
 * BUMP THIS whenever a change alters the numbers this package produces for
 * inputs it already handled. Adding a new function does not count; changing
 * `wilsonInterval`, the finite-population correction, how stratum bounds are
 * combined, or the confidence-band cuts does.
 *
 * History:
 *   1.0.0  Wilson score intervals with finite-population correction, stratum
 *          bounds summed for the total (ADR-0001). Replaces the legacy normal
 *          approximation, which collapsed to [0, 0] on zero observed hits.
 */
export const ESTIMATOR_VERSION = "1.0.0";
