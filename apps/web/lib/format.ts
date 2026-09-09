/**
 * Shared formatting for the mono data columns (DESIGN.md section 2: numbers,
 * URLs, and dates in a data column are always monospace and tabular).
 */

export function formatDateTime(iso: string): string {
  const date = new Date(iso);

  // Fixed en-CA-ish numeric format (not a locale call keyed off the
  // viewer's browser) so every render — server or client — produces the same
  // string; these are Server Components, but this keeps the helper safe to
  // reuse from a Client Component later without a hydration mismatch.
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A byte size, in binary units.
 *
 * KiB rather than kB, because the figure it labels is a downloaded sitemap's
 * `byte_size` and 1024 is what a reader comparing it against a file on disk
 * will see. Fixed to one decimal above the byte range so a column of sizes
 * stays the same width under tabular numerals; exact bytes below 1 KiB,
 * because "0.1 KiB" hides the difference between an empty file and a small one.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${formatCount(bytes)} B`;
  }

  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}
