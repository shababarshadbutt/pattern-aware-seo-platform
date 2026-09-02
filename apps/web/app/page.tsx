/*
 * M0 placeholder. The real screens are designed in D0/D1 and built in M5/D2.
 *
 * It is written to DESIGN.md rather than as throwaway markup on purpose: a
 * placeholder that violates the spec is where drift starts, and this one has to
 * prove the token layer actually works. So it follows section 7's composition —
 * a thin hairline stat strip, no KPI cards, a table as the primary element —
 * section 5's component language (2px radii, border-plus-background elevation,
 * rectangular mono status badges tinted rather than filled, a status-coloured
 * left-edge row accent), and section 2's rule that numbers are monospace and
 * tabular.
 */

const MILESTONES = [
  {
    id: "M0",
    label: "Repo foundation, tooling, and CI",
    status: "active",
    progress: "100%"
  },
  {
    id: "M1",
    label: "Schema, tenancy, and partitioning",
    status: "next",
    progress: "0%"
  },
  {
    id: "M2",
    label: "Single-pass streaming sitemap ingestion",
    status: "planned",
    progress: "0%"
  },
  {
    id: "M3",
    label: "Sampling core: min-heap, Wilson intervals with FPC",
    status: "planned",
    progress: "0%"
  },
  {
    id: "M4",
    label: "HTTP verification and escalation caps",
    status: "planned",
    progress: "0%"
  },
  {
    id: "M5",
    label: "Orchestration, API, and the pattern evidence page",
    status: "planned",
    progress: "0%"
  }
] as const;

type MilestoneStatus = (typeof MILESTONES)[number]["status"];

// Status drives colour everywhere it appears — badge, row accent, count — because
// that mapping is product logic, not decoration (DESIGN.md section 3).
const STATUS_COLOR: Record<MilestoneStatus, string> = {
  active: "var(--status-healthy)",
  next: "var(--status-warning)",
  planned: "var(--status-unknown)"
};

const STATS = [
  { label: "milestones", value: "10" },
  { label: "shipped", value: "1" },
  { label: "workspaces", value: "8" },
  { label: "phase", value: "M1" }
] as const;

function StatusBadge({ status }: { readonly status: MilestoneStatus }) {
  const color = STATUS_COLOR[status];

  // Rectangular, 2px radius, uppercase mono label, 1px border over a ~12%
  // tint rather than a solid fill — solid fills turn a dense table into a wall
  // of colour blocks, and capsule badges are a generic-SaaS tell (section 5).
  return (
    <span
      className="rounded-xs border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider"
      style={{
        color,
        borderColor: color,
        backgroundColor: `color-mix(in oklab, ${color} 12%, transparent)`
      }}
    >
      {status}
    </span>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-xl font-semibold tracking-tight">
        Pattern-Aware SEO Platform
      </h1>
      <p className="mt-2 max-w-prose text-sm text-secondary">
        Audits large sites by collapsing sitemaps into patterns and sampling
        each one, rather than crawling every URL. The dashboard is designed in
        D0/D1 and built in M5 — this page exists so the workspace runs end to
        end.
      </p>

      {/* Stat strip: a horizontal row of label/value pairs separated by hairline
          dividers. Not boxed cards — section 7 rejects the KPI-card row. */}
      <div className="mt-8 flex divide-x divide-border-subtle border-y border-border-subtle">
        {STATS.map((stat) => (
          <div key={stat.label} className="flex-1 px-4 py-3">
            <div
              className="font-mono text-2xl leading-none tabular-nums"
              data-numeric
            >
              {stat.value}
            </div>
            <div className="mt-1.5 font-mono text-2xs uppercase tracking-wider text-tertiary">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      <table className="mt-8 w-full border-collapse text-sm">
        <caption className="sr-only">Build milestones and their status</caption>
        <thead>
          <tr className="border-b border-border-strong text-left">
            <th
              scope="col"
              className="py-2 pr-4 pl-3 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
            >
              ID
            </th>
            <th
              scope="col"
              className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
            >
              Milestone
            </th>
            <th
              scope="col"
              className="py-2 pr-4 font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
            >
              Status
            </th>
            <th
              scope="col"
              className="py-2 text-right font-mono text-2xs font-medium uppercase tracking-wider text-tertiary"
            >
              Done
            </th>
          </tr>
        </thead>
        <tbody>
          {MILESTONES.map((milestone) => (
            <tr
              key={milestone.id}
              className="border-b border-border-subtle"
              // A thin left-edge accent per row, rather than tinting the whole
              // row or wrapping it in a coloured card (section 5).
              style={{
                boxShadow: `inset 3px 0 0 0 ${STATUS_COLOR[milestone.status]}`
              }}
            >
              <th
                scope="row"
                className="py-3 pr-4 pl-3 text-left font-mono text-xs font-normal text-secondary"
              >
                {milestone.id}
              </th>
              <td className="py-3 pr-4">{milestone.label}</td>
              <td className="py-3 pr-4">
                <StatusBadge status={milestone.status} />
              </td>
              <td
                className="py-3 text-right font-mono text-xs tabular-nums text-secondary"
                data-numeric
              >
                {milestone.progress}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
