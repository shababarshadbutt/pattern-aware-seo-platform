import Link from "next/link";
import type { ReactNode } from "react";
import { TONE_VAR, toolAvailabilityTone } from "../lib/status";
import type { CatalogSection, CatalogTool } from "../lib/tools-catalog";
import { ArrowRightIcon } from "./icons";

/**
 * The Stitch Tools screen's utility card, and the section header above a grid
 * of them.
 *
 * TRANSCRIBED FROM THE DESIGN'S SCREENSHOT: a bordered surface holding an icon
 * tile top-left and a status pill top-right, then the name, then a description,
 * then a chip row, then a divided footer pairing a small provenance line on the
 * left with the launch action on the right. Sections lead with an accent dot,
 * the title, a count chip, and a right-aligned small-caps label.
 *
 * PROVENANCE CAVEAT, as everywhere since ADR-0031: matched to a screenshot,
 * not to the design's generated `tailwind.config` the way section 3's palette
 * was, so spacing and radii are inferred. Every value used is an existing
 * token; the reset in `globals.css` means an invented one would not compile.
 *
 * THE ONE PLACE THIS DEPARTS FROM THE DESIGN, and it is deliberate: the design
 * draws nine identical "Operational" pills, because it is a mock of a product
 * with nine working tools. Seven of these cannot exist here, so the pill takes
 * its tone from `lib/status.ts` like every other status in the app, and an
 * unavailable card renders its reason IN the card rather than behind a hover.
 * A grid where the dark cards do not say why they are dark is the rail's
 * five-dead-items problem (ADR-0028) rebuilt at card scale.
 */

export function ToolSection({
  section,
  activeToolId,
  children
}: {
  readonly section: CatalogSection;
  /** The tool currently loaded into the hero panel, outlined in the grid. */
  readonly activeToolId?: string;
  readonly children?: ReactNode;
}) {
  const launchable = section.tools.filter(
    (tool) => tool.availability !== "unavailable"
  ).length;

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-xs bg-accent"
          />
          <h2 className="text-base font-semibold tracking-tight text-primary">
            {section.title}
          </h2>
          {/*
            The design's count chip reads "3 Tools". Ours says how many of the
            three can be launched, because "3 Tools" over a section where none
            of them run is the label asserting a guarantee the code does not
            make (CODING_STANDARDS section 1.9).
          */}
          <span className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs tracking-wider text-tertiary">
            {launchable === 0
              ? `${section.tools.length} · NONE AVAILABLE`
              : `${launchable} OF ${section.tools.length} AVAILABLE`}
          </span>
        </div>
        <p className="font-mono text-2xs tracking-wider text-tertiary uppercase">
          {section.label}
        </p>
      </div>

      {children}

      <div className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
        {section.tools.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            active={tool.id === activeToolId}
          />
        ))}
      </div>
    </section>
  );
}

const AVAILABILITY_LABEL: Record<CatalogTool["availability"], string> = {
  operational: "Operational",
  advisory: "Advisory",
  unavailable: "Unavailable"
};

export function ToolCard({
  tool,
  active
}: {
  readonly tool: CatalogTool;
  readonly active?: boolean;
}) {
  const tone = toolAvailabilityTone(tool.availability);
  const unavailable = tool.availability === "unavailable";

  return (
    <article
      className={`flex flex-col rounded-md border bg-surface-raised ${
        unavailable ? "opacity-70" : ""
      }`}
      style={{
        borderColor: active ? "var(--accent)" : "var(--border-subtle)"
      }}
    >
      <div className="flex flex-1 flex-col px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-border-subtle bg-base text-secondary"
          >
            <tool.icon className="h-5 w-5" />
          </span>
          {/*
            A word AND a colour, never colour alone — DESIGN.md section 8, the
            same rule the confidence band follows. The dot is decoration on top
            of the word, not the carrier of it.
          */}
          <span
            className="flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-2xs whitespace-nowrap"
            style={{
              color: TONE_VAR[tone],
              borderColor: TONE_VAR[tone],
              backgroundColor: `color-mix(in oklab, ${TONE_VAR[tone]} 12%, transparent)`
            }}
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-xs"
              style={{ backgroundColor: TONE_VAR[tone] }}
            />
            {AVAILABILITY_LABEL[tool.availability]}
          </span>
        </div>

        <h3 className="mt-4 text-base font-semibold tracking-tight text-primary">
          {tool.name}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-secondary">
          {tool.description}
        </p>

        {tool.unavailableReason !== undefined && (
          <p className="mt-3 border-l-2 border-border-subtle pl-3 text-2xs leading-relaxed text-tertiary">
            {tool.unavailableReason}
          </p>
        )}

        <div className="mt-auto flex flex-wrap gap-1.5 pt-4">
          {tool.tags.map((tag) => (
            <span
              className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs text-tertiary"
              key={tag}
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3">
        <span className="font-mono text-2xs text-tertiary">
          {tool.provenance}
        </span>
        {tool.href === undefined ? (
          <span
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-1.5 font-mono text-2xs tracking-wider text-tertiary uppercase"
          >
            Not built
          </span>
        ) : (
          <Link
            className="flex items-center gap-1.5 font-mono text-2xs tracking-wider text-accent-text uppercase transition-colors hover:text-primary"
            href={tool.href}
          >
            Launch tool
            <ArrowRightIcon className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>
    </article>
  );
}
