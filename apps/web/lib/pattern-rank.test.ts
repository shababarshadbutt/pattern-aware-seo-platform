import { describe, expect, it } from "vitest";

import type { SeverityClassName } from "./api";
import { httpStatusTone, severityTone } from "./status";

/**
 * The pattern explorer's "worst finding" cell renders a status code and a
 * severity badge side by side, and they must carry ONE tone.
 *
 * THE CASE THIS EXISTS FOR, found by driving the seeded demo and by no test:
 * two of one site's patterns report HTTP **200**. One is `ok` — genuinely
 * healthy. The other is `soft_not_found` — a page that answers 200 while being
 * a "not found", which is exactly what the capped GET escalation exists to
 * detect. Coloured by the status code alone they are the same green, and the
 * screen reports a broken pattern as fine.
 *
 * The first fix reached for `httpStatusTone`'s `isSoft404` argument, and this
 * file rejected it: `httpStatusTone` scores a soft 404 `critical` while
 * `severityTone` scores the same class `warning`. THEY DISAGREE BY DESIGN —
 * one answers "what did the wire say" (the run explorer's raw observations,
 * which carry no severity class) and the other "how bad is this finding" (a
 * published claim, where a soft 404 deliberately ranks below a hard 404 or a
 * 500). Mixing them in one cell puts a green number beside a red badge with
 * nothing to tell a reader which to believe.
 *
 * So a row with a severity class takes `severityTone` for both, and
 * `httpStatusTone` is the fallback for the case with no class at all.
 */

/** The tone decision the explorer's cell makes, kept here so a test can drive it. */
function worstFindingTone(
  httpStatus: number | null,
  severityClass: SeverityClassName | undefined
) {
  return severityClass
    ? severityTone(severityClass)
    : httpStatusTone(httpStatus);
}

describe("the worst finding's tone", () => {
  it("never calls a soft 404 healthy, even though it answers 200", () => {
    expect(worstFindingTone(200, "soft_not_found")).not.toBe("healthy");
  });

  it("still calls a genuine 200 healthy", () => {
    // The complement. Without it, "colour every 200 critical" would satisfy the
    // case above while reporting every working pattern as broken.
    expect(worstFindingTone(200, "ok")).toBe("healthy");
  });

  it("gives the number and the badge the same tone", () => {
    /**
     * The actual invariant. Both describe one finding, so one tone — asserted
     * against `severityTone` directly, which is the badge's own mapper.
     */
    const classes: readonly SeverityClassName[] = [
      "ok",
      "soft_not_found",
      "not_found",
      "gone",
      "server_error",
      "redirect_single",
      "redirect_chain",
      "blocked",
      "unknown"
    ];

    for (const severityClass of classes) {
      expect(worstFindingTone(200, severityClass)).toBe(
        severityTone(severityClass)
      );
    }
  });

  it("does not report a pattern with no finding as a server error", () => {
    // No worst finding means nothing was published, not that something failed.
    expect(worstFindingTone(null, undefined)).toBe("unknown");
  });

  it("keeps the two mappers' disagreement visible rather than papered over", () => {
    /**
     * Asserted so nobody "fixes" the inconsistency by making one mapper defer
     * to the other. A raw 200 observation that was a soft 404 IS critical on
     * the run explorer, where there is no published claim to rank; a published
     * `soft_not_found` finding is a warning. Both are deliberate.
     */
    expect(httpStatusTone(200, true)).toBe("critical");
    expect(severityTone("soft_not_found")).toBe("warning");
  });
});
