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
