import { describe, expect, it } from "vitest";

import { chunkRows } from "./chunk.js";

describe("chunkRows", () => {
  it("returns everything in one chunk when it already fits", () => {
    const rows = Array.from({ length: 10 }, (_, i) => i);

    expect(chunkRows(rows, 6, 60_000)).toEqual([rows]);
  });

  it("returns no chunks for an empty input", () => {
    expect(chunkRows([], 6)).toEqual([]);
  });

  it("splits by columns-per-row so a 4-column table and a 6-column table chunk differently", () => {
    const rows = Array.from({ length: 100 }, (_, i) => i);

    // maxBindParams=40 -> 40/4=10 rows/chunk vs 40/6=6 rows/chunk (floored).
    const fourColumn = chunkRows(rows, 4, 40);
    const sixColumn = chunkRows(rows, 6, 40);

    expect(fourColumn.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(sixColumn.every((chunk) => chunk.length <= 6)).toBe(true);
    expect(fourColumn.flat()).toEqual(rows);
    expect(sixColumn.flat()).toEqual(rows);
    // Same input, different table shape -> different chunk count.
    expect(fourColumn.length).not.toBe(sixColumn.length);
  });

  it("never exceeds the configured bind-parameter budget per chunk", () => {
    const rows = Array.from({ length: 137 }, (_, i) => i);
    const columnsPerRow = 6;
    const maxBindParams = 50;

    const chunks = chunkRows(rows, columnsPerRow, maxBindParams);

    for (const chunk of chunks) {
      expect(chunk.length * columnsPerRow).toBeLessThanOrEqual(maxBindParams);
    }

    expect(chunks.flat()).toEqual(rows);
  });

  it("rejects a non-positive columnsPerRow", () => {
    expect(() => chunkRows([1, 2, 3], 0)).toThrow(RangeError);
  });

  it("uses a real-world default that keeps a >20,000-row, 4-column table's chunk under the 65,535 bind-parameter ceiling", () => {
    const rows = Array.from({ length: 25_000 }, (_, i) => i);

    const chunks = chunkRows(rows, 4);

    for (const chunk of chunks) {
      expect(chunk.length * 4).toBeLessThan(65_535);
    }

    expect(chunks.flat()).toEqual(rows);
  });
});
