<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- Repo-specific guidance below. Next only rewrites the delimited block above. -->

## Before building any screen in this app

Read `../../docs/DESIGN.md`. It is the source of truth for every UI decision here and
is specific rather than advisory — section 9 is a list of bans, not preferences.

**It describes the Google Stitch design, which superseded the previous
"instrument panel" spec on 2026-09-04 (ADR-0027).** If your recollection of this
app involves an amber accent, Switzer, or a light theme, it is out of date — read
the file rather than the memory. The short version:

- **Dark only.** One palette, no `data-theme` attribute and no theme switch. The
  previous spec's light palette was retired with it, deliberately. A light mode
  is a palette to design, not a switch someone forgot to wire up.
- **Tokens only.** `app/globals.css` resets Tailwind's default colour, radius,
  font and text-size namespaces and defines only what DESIGN.md specifies, so
  `rounded-2xl` and `bg-zinc-800` generate nothing. If a value you want does not
  exist, that is the design system working — change DESIGN.md and the token layer
  together, deliberately.
- **The accent is indigo, and it splits into two tokens that never swap.**
  `--accent` (`bg-accent`, `border-accent`) is a **fill** — buttons, the active
  rail marker, the logo tile. It is 4.0:1 against the page and is **not** a text
  colour. `--accent-text` (`text-accent-text`) is the tint for accented text,
  links and the focus ring. Reaching for `text-accent` is the mistake the split
  exists to prevent.
- **Every number is JetBrains Mono and tabular.** Numeric values, URLs, pattern
  strings, and status codes never fall back to the UI sans. The UI sans is
  **Geist**, loaded via `next/font/google` in `app/layout.tsx`.
- **Tables carry the data; cards frame it.** A list of things is a table with a
  status-coloured left-edge accent per row — a grid of identical cards as a list
  container is still an explicit anti-pattern. `StatCards` is the exception the
  Stitch design introduced: a KPI row of 3–5 figures above the table.
- **A card may only hold a COUNTED figure.** A sampled one has to carry its
  interval, so it belongs in `<Estimate>` inside the table. Never sum estimates
  into a headline number — that manufactures a precise-looking total out of
  uncertain parts.
- **Never render a sampled number without its confidence interval** — see
  ADR-0008 in `../../docs/decisions.md`. `<Estimate>` enforces it in the type
  system, and `lib/adr-0008-guard.test.ts` fails the build if a screen formats
  one itself. That guard hardcodes `components/estimate.tsx` as the only
  permitted adapter, so **do not rename or move that file** — the check would
  keep passing while policing a convention nothing follows.
- **Status colours come from `lib/status.ts`, never picked by eye.** That mapping
  is product logic: a `blocked` host maps to `unknown`, never `critical`, because
  a host refusing us is not a site defect; a `low` confidence band maps to
  `unknown` because a wide interval is missing evidence, not bad news.

## The navigation rail

`components/nav-rail.tsx` follows the Stitch design's item order — Overview,
Projects, **Analyses**, Issues, Tools, Analytics — with one label deliberately
not the design's. Two things to know before editing it:

- **The design says "Crawls"; this app says "Analyses" (ADR-0039).** It leads to
  `/runs`, the sitemap-run history. A run samples patterns; it does not request
  every URL, and the rail is where a reader learns that. ADR-0027 originally
  kept the design's word and recorded the tension; ADR-0039 resolved it. Do not
  let a screen built under that item acquire crawl-everything behaviour — see
  the non-negotiable rules in `../../CLAUDE.md`.
- **An item with no `href` renders disabled with a `SOON` marker.** Items without
  a screen must not link anywhere. Five silently-inert items previously read as
  five broken links, which is what prompted building `/issues` and `/runs` at
  all.
