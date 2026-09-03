# Design System — Pattern-Aware SEO Platform

This is the design specification for the product UI. It exists so "premium, distinctive, not generic SaaS" is a set of concrete, checkable decisions — tokens, type scale, component rules — rather than a vibe that drifts back toward Inter-and-purple-gradients the moment a new screen gets built under deadline pressure. Read this before building or modifying any UI. It complements, not replaces, `docs/CODING_STANDARDS.md` (code quality) and `docs/architecture-review-and-action-plan.md` (product/data model).

**Foundational tooling:** shadcn/ui components as the base primitives, restyled through the tokens below (never shadcn's default theme as-is — the default look is exactly the "generic SaaS" starting point this spec exists to move away from). Magic UI only for the specific, named motion moments in §8 — not as a general component source. Impeccable (the design-taste skill already recommended in the tech stack doc) should be initialized as a **product surface**, and pointed at this file as the source of truth when it asks for design direction, rather than inventing its own.

## 0. The idea

The product reads live status off a huge, mostly-invisible system — sitemap patterns, sampling confidence, HTTP health, across hundreds of sites — the same job a **glass cockpit instrument panel** does for a pilot: dense, precise, numeric, glanceable, trustworthy under pressure, built for someone who uses it every day and wants zero decoration between them and the readout. That's the visual reference point for this product — not literally skeuomorphic (no fake rivets or dials), but borrowed in spirit: monospaced data readouts, amber/status-light semantic color, hairline instrument-panel borders instead of soft drop shadows, everything reachable without touching a mouse. It also happens to genuinely fit the platform's own client base (aviation sites), which is a nice coincidence rather than the reason for the choice — the reason is that it's a real, coherent metaphor for "a lot of precise numbers, glanced at constantly, that need to read as trustworthy," which is a better brief for an SEO ops tool than "make it look premium."

Positioning in one line: **a flight instrument panel for your sitemap, not a marketing dashboard about your sitemap.**

## 1. Visual direction

- Dark mode is the primary, default experience — this is a tool used for hours by people who live in dark-themed dev tools already (matches the Linear/Vercel/Raycast audience expectation), not a marketing site that happens to have a dark toggle. Light mode is fully designed, not an afterthought (see §3), for daytime/screen-share use.
- Flat surfaces, hairline borders, no drop shadows for elevation. Depth is communicated with a one-step background shift (surface vs. base) plus a 1px border, never a blurred shadow — shadows are the single fastest tell of "generic SaaS card," and the ban list explicitly rules them out.
- Sharp, restrained corner radii — see §5. Nothing in this product should read as "soft." A pattern-health table showing a P0 critical issue affecting 13M URLs should look serious, not friendly.
- Numbers are the product. Every screen's job is ultimately to answer "which patterns need attention and how confident are we." Type, color, and layout all subordinate to making numeric data (error rates, confidence, population counts, impact scores) fast to scan and compare — this is the opposite instinct from a marketing dashboard, which subordinates data to hero illustrations and card decoration.
- One accent color, used sparingly and meaningfully (see §3) — not a gradient, not a rotating brand palette. Restraint is what reads as premium (this is the one thing Linear, Vercel, and Raycast all actually agree on, even though the brief says not to copy them).

## 2. Typography

Two typefaces only — a UI sans and a monospace for data. No third "display" face; restraint here is deliberate (adding a distinct headline font is the single easiest way to accidentally drift toward "marketing site" rather than "instrument panel").

- **UI sans: Switzer** (Fontshare, free for commercial use, self-host via `next/font/local`). A geometric-leaning grotesque with real character — avoids the extremely-online genericness of Inter/Roboto while staying highly legible at small sizes, which matters for dense tables. (Alternative if the team prefers a slightly warmer feel: **General Sans**, same source, same license — pick one and commit, don't mix.)
- **Data monospace: JetBrains Mono** (OFL license, available via `next/font/google` or self-hosted). Used for every numeric value, URL, pattern string, status code, and confidence percentage — anywhere alignment and unambiguous character shapes (0 vs O, 1 vs l) matter. This is what gives the product its "instrument readout" feel and is one of the most load-bearing decisions in this spec — don't let numbers default to the UI sans.

**Type scale** (px / line-height, UI sans unless noted):

| Token | Size / Leading | Usage |
|---|---|---|
| `text-2xs` | 11 / 16 | dense table cell labels, badges |
| `text-xs` | 12 / 16 | table body, secondary metadata |
| `text-sm` | 13 / 20 | default body, form inputs, nav |
| `text-base` | 14 / 20 | primary reading size |
| `text-lg` | 16 / 24 | section headers, panel titles |
| `text-xl` | 20 / 28 | page titles |
| `text-2xl` | 28 / 36 | top-line KPI numbers (monospace) |
| `text-3xl` | 40 / 48 | rare — a single hero number on an empty/onboarding state only |

Rules: numeric data always uses `font-variant-numeric: tabular-nums` (JetBrains Mono has this by default) so columns of numbers align without additional CSS gymnastics. Never center-align body text. Never use font weights above 600 (semibold) outside of the KPI numbers and page titles — heavy weights read as "marketing," not "instrument."

## 3. Color system

Semantic tokens, not raw hex in components. Status colors map directly to the pattern-health states already defined in the product (`healthy` / `needs attention` / `critical` / `insufficient data`) — this mapping is product logic, not decoration, so it must be consistent everywhere a status appears (table row accent, badge, chart line, sidebar count).

**Dark mode (default):**

```css
:root[data-theme="dark"] {
  --bg-base: #0A0B0D;          /* app background */
  --bg-surface: #131417;       /* panels, table, sidebar */
  --bg-surface-raised: #1B1D21;/* popovers, command palette, dropdowns */
  --border-subtle: #24262B;
  --border-strong: #35373E;
  --text-primary: #F2F3F5;
  --text-secondary: #9BA0AA;
  --text-tertiary: #6B707A;

  --accent: #D9A441;            /* signal amber — primary actions, focus rings, active nav */
  --accent-foreground: #171208;

  --status-healthy: #3FB67F;
  --status-warning: #D9A441;    /* reuses accent — "needs attention" IS the caution signal */
  --status-critical: #E5484D;
  --status-unknown: #6E7681;    /* insufficient sampling confidence */
}
```

**Light mode:**

```css
:root[data-theme="light"] {
  --bg-base: #FAFAF8;           /* warm off-white, not sterile pure white */
  --bg-surface: #FFFFFF;
  --bg-surface-raised: #FFFFFF;
  --border-subtle: #E4E4E0;
  --border-strong: #CFCFC9;
  --text-primary: #16171A;
  --text-secondary: #55585F;
  --text-tertiary: #82858C;

  --accent: #A6720C;             /* deepened for AA contrast on light */
  --accent-foreground: #FFFBEF;

  --status-healthy: #1A8F5A;
  --status-warning: #A6720C;
  --status-critical: #C4282E;
  --status-unknown: #6E7681;
}
```

Explicitly out of the palette: purple, indigo, or violet as an accent (the single most common "AI product" tell — reserved-word ban, not a suggestion), and any gradient on a background, button, or icon. Icons and illustrations are single-color/line-based, never gradient-filled.

## 4. Spacing system

4px base unit: `4, 8, 12, 16, 24, 32, 48, 64, 96`. No arbitrary values outside this scale in component code.

Two density modes, user-toggleable, persisted per user — this directly serves "dense but readable," which is a real tension the platform has to resolve rather than pick one side of by default:

- **Comfortable** (default): 12px vertical table row padding, 16px section gaps.
- **Compact**: 6px vertical table row padding, 8px section gaps — for power users triaging hundreds of patterns in one sitting.

Whitespace is used to group, not decorate: the gap *between* a table and its filter bar should be visibly smaller than the gap between two unrelated sections. If two elements have the same spacing above and below them, they read as unrelated — audit for this specifically, it's the most common way "generous whitespace" accidentally becomes "directionless whitespace."

## 5. Component language

- **Radius scale:** `2px` (inputs, buttons, badges, table cells), `6px` (cards/panels, popovers, command palette), `10px` (modals only). Nothing larger. The ban on "huge rounded containers" is enforced by simply not having a larger radius token available.
- **Elevation:** border + one-step background shift only (`--bg-surface` on `--bg-base`, `--bg-surface-raised` on `--bg-surface`). No `box-shadow` for elevation anywhere except a very subtle (2–4px, low-opacity) shadow under the command palette and modals specifically, where floating-above-everything is the actual intent.
- **Buttons:** 28px (compact contexts) or 32px (default) height, 2px radius, icon + label, and — matching Linear/Raycast convention because it's genuinely useful, not because it's their look — a keyboard shortcut hint shown right-aligned on hover/focus for any action that has one.
- **Badges/status pills:** rectangular, 2px radius (never a full pill/capsule shape — capsule badges are one of the clearest "generic SaaS" tells), small-caps or uppercase monospace label (`HEALTHY`, `P0`, `4XX`, `LOW CONFIDENCE`), colored via a 1px border + tinted background at ~12% opacity of the status color, not a solid fill — keeps dense tables from turning into a wall of solid color blocks.
- **Tables are the primary UI primitive, not cards.** A view showing many patterns, samples, or sites is a table — sortable, resizable columns, sticky header, row-hover reveals contextual actions (§6) instead of showing every possible action at all times, and a thin (2–3px) left-edge color accent per row indicating status instead of tinting the whole row or wrapping it in a colored card.
- **Cards exist but are rare and specific:** used only for genuinely standalone objects (a single site's summary, an onboarding empty state) — never as the default container for a list of things, which is the "dashboard made entirely of identical cards" pattern this spec explicitly rejects. If you're about to render an array as a grid of cards, it should almost always be a table instead.
- **Sparklines:** small inline SVG, monochrome using the row's status color, embedded directly in table cells to show a pattern's trend without leaving the table.

## 6. Navigation model

- **Command palette (`Cmd/Ctrl+K`) is the primary navigation surface**, not a nice-to-have layered on top of a conventional nav — fuzzy search across sites, patterns, reports, and actions ("go to site: united-aero.com," "run sampling: pattern #4821," "export report"). This is what lets the product stay keyboard-first without needing a deep, always-visible nested sidebar.
- **Left rail:** icon-only by default, collapsible label view — top-level sections only (Enterprise overview, Sites, Patterns, Reports, Settings). It's a map, not the primary way anyone actually gets around day to day; that's the command palette's job.
- **Drill-down, not modal-stacking:** Enterprise → Site → Pattern → Sample is a breadcrumb-tracked navigation stack, each level its own dense view. Opening a modal on top of a modal never happens.
- **Detail panel:** selecting a row opens a right-side slide-over (not a route change, not a modal) so table context stays visible underneath — this is the mechanism for progressive disclosure (§8), not a separate page for every drill-in.
- **Keyboard:** `j`/`k` to move between table rows, `Enter` to open the selected row's detail panel, `/` to focus the current view's filter, `Cmd/Ctrl+K` global palette, `g` then a letter for "go to" navigation (`g s` → Sites, `g p` → Patterns) — Superhuman/Linear-style, because it's a genuinely good pattern for a tool used all day, not because of where it's from.

## 7. Dashboard composition

Reject the generic layout (row of 4 KPI cards + 2 chart cards + a table below). Instead:

- **A single thin, persistent stat strip** at the top of relevant views — not boxed cards, just a horizontal row of label/value pairs separated by hairline dividers, each with its monospace number, a small inline delta (`▲ 2.1%`) and optional sparkline. This holds the 3–5 numbers that actually matter for the current view (e.g., on the Enterprise overview: sites monitored, critical patterns, URLs sampled this week, average confidence) — dense, glanceable, no card chrome.
- **The pattern/site table is the hero of the screen**, not a secondary element below the "real" dashboard — because the table *is* the product. Filtering, sorting, and saved views live directly above it in a slim toolbar, not in a separate sidebar of filter cards.
- **Context, not clutter:** a chart or detail view appears in the right-side slide-over panel when something is selected, not permanently rendered for every row at once.
- **Enterprise (650-site) view** is a dense sortable table with an inline sparkline and status-colored left-edge accent per site — never a grid of 650 site cards. If an at-a-glance visual overview is wanted in addition, a single compact heatmap/treemap (one visualization, not one card per site) sits above the table, not instead of it.

## 8. Interaction principles

- **Motion is fast and mechanical, not playful.** 120–200ms, `ease-out` for things appearing, `ease-in` for things leaving — no spring/bounce/elastic easing anywhere; this is an instrument panel, not a consumer app. A status pill changing color on data refresh cross-fades; it doesn't bounce.
- **Magic UI is used in exactly these places, and nowhere else:** (1) the monospace KPI numbers count up/down when a value changes on refresh, rather than snapping instantly; (2) inline sparklines draw themselves in on first render; (3) a pattern that just became critical gets a single subtle pulse on its status accent to draw the eye once, then stops. No marquees, no particle backgrounds, no animated gradients, no decorative motion anywhere in this product — every animation here is communicating a state change in data, full stop.
- **Progressive disclosure is the default information architecture**, not an exception: summary stat strip → pattern table → pattern detail panel → sample-level evidence → raw HTTP response, each a deliberate step deeper. Never show raw per-URL data at the top level of any view.
- **Responsive behavior:** this is fundamentally a desktop power tool, the same honest positioning Linear and Raycast take. Below ~1024px, it becomes a read-only glance mode — the stat strip and a simplified, non-editable pattern list — rather than attempting to cram sortable multi-column tables and a command palette into a phone screen. Don't spend engineering effort making the dense table "work" on mobile; spend it making the glance mode genuinely useful for someone checking status from their phone.
- **Focus states are always visible and always use `--accent`** — this is a keyboard-first product, so a component with an invisible or barely-visible focus ring is a bug, not a style nitpick.

## 9. Explicit anti-patterns (do not do these)

Generic SaaS dashboard layouts; any purple/indigo/violet accent or gradient anywhere; pill/capsule-shaped badges; drop shadows for elevation; a grid of identical cards as the default way to show a list of things; Inter or Roboto as the UI typeface; more than two typefaces; corner radii larger than the scale in §5; spring/bounce easing; decorative animation (particles, marquees, animated gradients) anywhere in the product surface (fine for a future public marketing page — see the Magic UI note in the tech stack doc — never in the app itself); centered body text; non-tabular numerals in any data column.

## 10. Implementation notes

Build on shadcn/ui's component primitives (already the chosen library — see the tech stack doc), but the theme is the tokens in §3 applied through shadcn's CSS-variable theming, not shadcn's default palette or default `rounded-lg`/shadow-heavy card styles. Use the shadcn/ui MCP to pull in specific primitives and dashboard blocks, then restyle to this spec — don't accept a pulled block's default visual treatment as final. Use Impeccable's `/impeccable audit` and `/impeccable critique` commands against this document specifically once screens exist, so drift back toward generic patterns gets caught mechanically rather than relying on someone noticing later.

This document should evolve the way the architecture plan does: when a real design decision changes (a different accent color ships, a third density mode gets added), update this file rather than letting the shipped product silently diverge from what's written here.
