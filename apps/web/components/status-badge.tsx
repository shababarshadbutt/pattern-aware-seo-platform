import { TONE_VAR, type Tone } from "../lib/status";

/**
 * Rectangular, 2px radius, uppercase mono label, 1px border over a ~12% tint
 * rather than a solid fill — DESIGN.md section 5. Shared across every status
 * domain in the product (site, run, pattern, confidence band, severity) so
 * they all read as the same visual language.
 */
export function StatusBadge({
  tone,
  label
}: {
  readonly tone: Tone;
  readonly label: string;
}) {
  const color = TONE_VAR[tone];

  return (
    <span
      className="rounded-xs border px-2 py-1 font-mono text-2xs whitespace-nowrap uppercase tracking-wider"
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`
      }}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}
