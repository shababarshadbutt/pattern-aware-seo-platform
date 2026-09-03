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
