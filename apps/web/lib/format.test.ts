import { describe, expect, it } from "vitest";

import { formatBytes, formatCount, formatDateTime } from "./format";

describe("formatDateTime", () => {
  /**
   * Pinned because it is deliberately NOT a locale call.
   *
   * `toLocaleString` keyed off the viewer's browser produces a different
   * string on the server than in the client, which React reports as a
   * hydration mismatch — and the fix, once someone reaches for it under
   * deadline pressure, is usually to suppress the warning rather than to make
   * the output deterministic. This test is what stops that: the format is
   * fixed, UTC, and identical everywhere.
   */
  it("renders a fixed UTC format, not a locale-dependent one", () => {
    expect(formatDateTime("2026-09-03T17:27:09.882Z")).toBe(
      "2026-09-03 17:27 UTC"
    );
  });

  it("does not shift the instant into the running machine's timezone", () => {
    // Same instant, expressed with an offset. A local-time formatter would
    // print two different clock times for these.
    expect(formatDateTime("2026-01-15T23:30:00.000Z")).toBe(
      formatDateTime("2026-01-16T00:30:00.000+01:00")
    );
  });

  it("zero-pads every component", () => {
    expect(formatDateTime("2026-01-02T03:04:00.000Z")).toBe(
      "2026-01-02 03:04 UTC"
    );
  });
});

describe("formatCount", () => {
  it("groups thousands, because these are read not computed with", () => {
    expect(formatCount(22_898)).toBe("22,898");
    expect(formatCount(13_800_000)).toBe("13,800,000");
  });

  it("leaves a small count alone", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(40)).toBe("40");
  });

  it("does not silently truncate a fractional impact score", () => {
    /**
     * `impact_score` is `numeric(20,3)` precisely so a small finding does not
     * round to zero (ADR-0020). A formatter that floored its input would undo
     * that at the last step, which is where it would be hardest to notice.
     */
    expect(formatCount(479.7)).toContain("479.7");
    expect(formatCount(0.45)).toContain("0.45");
  });
});

describe("formatBytes", () => {
  it("shows exact bytes below a kibibyte", () => {
    /**
     * "0.1 KiB" would hide the difference between an empty sitemap file and a
     * small one, and an empty file that parsed cleanly is exactly the case
     * section 1.5 says must not look like an ordinary success.
     */
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("uses binary units, because that is what a file listing shows", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1_048_576)).toBe("1.0 MiB");
    expect(formatBytes(1_073_741_824)).toBe("1.0 GiB");
  });

  it("keeps one decimal so a column of sizes stays the same width", () => {
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(10_485_760)).toBe("10.0 MiB");
  });
});
