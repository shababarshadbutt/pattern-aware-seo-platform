/**
 * The icon set for the app shell.
 *
 * Inline SVG rather than the Material Symbols font the Stitch export loads
 * from `fonts.googleapis.com`. The design's icons ARE Material Symbols, but
 * that face is not in `next/font/google`'s catalogue, so using it would mean a
 * render-blocking stylesheet from a third-party origin and a flash of ligature
 * text ("cloud_download") before the font arrives. These are the same glyph
 * shapes at the same 20px optical size, drawn as strokes.
 *
 * Every icon inherits `currentColor` and is marked `aria-hidden`: each one sits
 * beside a real text label in the rail, so announcing it again would just make
 * a screen reader say everything twice.
 */

/*
 * `| undefined` is explicit because tsconfig sets `exactOptionalPropertyTypes`:
 * without it, forwarding an absent className from one component to the next is
 * a type error rather than the no-op it reads as.
 */
type IconProps = { readonly className?: string | undefined };

function Svg({
  children,
  className
}: {
  readonly children: React.ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className ?? "h-5 w-5 shrink-0"}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function DashboardIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect height="7" rx="1" width="7" x="3" y="3" />
      <rect height="7" rx="1" width="7" x="14" y="3" />
      <rect height="7" rx="1" width="7" x="14" y="14" />
      <rect height="7" rx="1" width="7" x="3" y="14" />
    </Svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}

export function CrawlIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M7 16a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 18 16" />
      <path d="M12 12v7" />
      <path d="m9 16 3 3 3-3" />
    </Svg>
  );
}

export function IssuesIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <path d="M12 16.5v.01" />
    </Svg>
  );
}

export function ToolsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14.5 5.5a4 4 0 0 0 5 5L21 9l-6 6-6 6-3-3 6-6 6-6Z" />
    </Svg>
  );
}

export function AnalyticsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M22 20H2" />
    </Svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      {/*
        Sliders, not a cog. A circle ringed by radial spokes reads as a SUN at
        20px, which in a product that just dropped light mode would look like a
        theme toggle. Sliders are unambiguous and draw correctly at this size.
      */}
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </Svg>
  );
}

export function DocsIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </Svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function BellIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </Svg>
  );
}

export function UserIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </Svg>
  );
}

/*
 * --- Tool-catalogue glyphs. ---
 *
 * The Stitch Tools screen gives every utility card an icon tile and marks its
 * hero panel with a filled accent tile. These are drawn to the same 24px grid
 * and the same 1.5 stroke as the rail's set above, so a card icon and a rail
 * icon read as one family rather than two imports.
 *
 * Several name capabilities this platform does NOT have — a browser, a robot,
 * a globe. They are drawn anyway because the cards for those capabilities are
 * rendered as unavailable rather than hidden (see `lib/tools-catalog.ts`), and
 * a card with an empty tile reads as a loading failure rather than a refusal.
 */

export function BoltIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
    </Svg>
  );
}

export function SitemapIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect height="5" rx="1" width="7" x="9" y="2" />
      <rect height="5" rx="1" width="6" x="2" y="17" />
      <rect height="5" rx="1" width="6" x="16" y="17" />
      <path d="M12.5 7v4M5 17v-3h14v3" />
    </Svg>
  );
}

export function BranchIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="12" cy="19" r="2.5" />
      <path d="M6 7.5v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3" />
      <path d="M12 13.5v3" />
    </Svg>
  );
}

export function TargetIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
    </Svg>
  );
}

export function ExpandIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5" />
      <path d="m4 4 6 6M20 20l-6-6M4 20l6-6M20 4l-6 6" />
    </Svg>
  );
}

export function GaugeIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4.5-6" />
      <circle cx="12" cy="18" r="1.5" />
    </Svg>
  );
}

export function ScaleIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12 4v16M7 20h10" />
      <path d="M4 9h16" />
      <path d="M4 9 1.5 15h5L4 9ZM20 9l-2.5 6h5L20 9Z" />
    </Svg>
  );
}

export function GlobeIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4a13 13 0 0 1 0 16 13 13 0 0 1 0-16Z" />
    </Svg>
  );
}

export function RobotIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect height="10" rx="2" width="16" x="4" y="9" />
      <path d="M12 5v4M9.5 14h.01M14.5 14h.01" />
      <circle cx="12" cy="4" r="1.5" />
    </Svg>
  );
}

export function CodeIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" />
    </Svg>
  );
}

export function TerminalIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <rect height="16" rx="2" width="18" x="3" y="4" />
      <path d="m7 10 2.5 2L7 14M13 15h4" />
    </Svg>
  );
}

export function LayersIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </Svg>
  );
}

/** The trailing arrow on a card's launch action. */
export function ArrowRightIcon({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </Svg>
  );
}
