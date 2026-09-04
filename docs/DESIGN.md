# Design System — Pattern-Aware SEO Platform

This is the design specification for the product UI. It exists so the visual identity is a set of concrete, checkable decisions — tokens, type scale, component rules — rather than a vibe that drifts every time a new screen gets built under deadline pressure. Read this before building or modifying any UI. It complements, not replaces, `docs/CODING_STANDARDS.md` (code quality) and `docs/architecture-review-and-action-plan.md` (product/data model).

**Source of truth.** This document describes the Google Stitch design (project `12137181229897682385`, 13 desktop screens), which superseded the previous "glass cockpit instrument panel" spec on 2026-09-04 — see **ADR-0027** for what changed, why, and what deliberately did not. Every value below is transcribed from the `tailwind.config` in Stitch's own generated HTML, not sampled from a screenshot. `apps/web/app/globals.css` is the machine-readable copy of §2–§5; if the two disagree, this document wins and that file is the bug.

## 0. The idea

The product reads live status off a huge, mostly-invisible system — sitemap patterns, sampling confidence, HTTP health, across hundreds of sites. Every screen answers one question: **which patterns need attention, and how confident are we?** Type, colour and layout all subordinate to making numeric data fast to scan and compare.

The surface is a dense, dark operations console: a persistent navigation rail, a thin breadcrumb bar, KPI cards for the figures that frame a screen, and a table carrying the actual evidence. Numbers are the product.

## 1. Visual direction

- **Dark only.** There is one palette and no theme switch. The design ships a single dark theme; the light palette that existed under the previous spec was retired with it (ADR-0027). A light mode is a palette to design, not a switch to re-enable.
- **Flat surfaces on a five-step ladder.** Depth is a background shift plus a 1px border, never a blurred shadow. The ladder runs `--bg-rail` (dimmest — the navigation rail sits *below* the page) → `--bg-base` → `--bg-surface` → `--bg-surface-raised` → `--bg-surface-high`.
- **One accent, in two roles that never swap.** Indigo. `--accent` is a fill: primary buttons, the active rail marker, the logo tile. `--accent-text` is the light tint for accented text and links. The fill colour is 4.0:1 against the page and is not a text colour; using it as one is the specific mistake the split exists to prevent.
- **Restrained radii.** 2/4/8/12px. Nothing larger exists as a token.
- **Numbers are monospace, always.** Every count, status code, URL, timestamp, pattern template and confidence figure is JetBrains Mono with tabular figures.

## 2. Typography

Two faces. **Geist** for UI text, **JetBrains Mono** for data. Both are served self-hosted through `next/font/google` — no third-party request at render, and no unvendored font silently falling back to system sans, which is exactly what happened to the previous spec's Switzer for the whole of M7.

| Token | Face | Size / Leading | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| `text-xl` | Geist | 24 / 32 | 600 | -0.02em | Page title |
| `text-lg` | Geist | 18 / 24 | 600 | -0.01em | Section heading, product mark |
| `text-base` | Geist | 14 / 20 | 400 | — | Body, nav items |
| `text-sm` | Geist | 13 / 18 | 400 | — | Secondary prose |
| `text-xs` | JetBrains Mono | 13 / 16 | 450 | — | Table data, URLs, timestamps |
| `text-2xs` | JetBrains Mono | 11 / 12 | 500 | — | Column headers, badges, card labels |

Six sizes exist. The Tailwind `--text-*` namespace is reset, so a seventh is a build error rather than a review note. Mono labels — column headers, card labels, badge text — are uppercase with wide tracking.

## 3. Color system

Palette is Material 3 dark. Semantic names, not raw hex, in every component.

| Token | Hex | Role |
|---|---|---|
| `--bg-rail` | `#0e0d16` | Navigation rail |
| `--bg-base` | `#13121b` | Page background |
| `--bg-surface` | `#1b1b24` | Row hover, active nav row |
| `--bg-surface-raised` | `#1f1f28` | Cards, panels |
| `--bg-surface-high` | `#2a2933` | Nested surface |
| `--border-subtle` | `#464555` | Hairline borders, table rules |
| `--border-strong` | `#918fa1` | Emphasised borders |
| `--text-primary` | `#e4e1ee` | Body text |
| `--text-secondary` | `#c7c4d8` | Supporting text |
| `--text-tertiary` | `#918fa1` | Labels, disabled |
| `--accent` | `#4f46e5` | Fill only — buttons, active marker, logo tile |
| `--accent-text` | `#c3c0ff` | Accented text, links, focus ring |
| `--accent-foreground` | `#ffffff` | Text on an accent fill |

**Status colours are independent of the accent.** Under the previous amber accent, warning and accent were the same token by design. They are not now.

| Tone | Hex | Meaning |
|---|---|---|
| `--status-healthy` | `#10b981` | Measured and fine |
| `--status-warning` | `#f59e0b` | Needs attention |
| `--status-critical` | `#ef4444` | A real defect |
| `--status-unknown` | `#918fa1` | **Absence of evidence, not bad news** |

**This mapping is product logic, not decoration.** `apps/web/lib/status.ts` maps every status domain — site, run, pattern, confidence band, severity — onto these four tones so a badge, a row accent and a figure always agree about the same fact. Two rules there are correctness rather than taste, and survive any restyle: a **blocked** host maps to `unknown`, never `critical`, because a host refusing us is not a site defect; and a **low** confidence band maps to `unknown`, because a wide interval is missing evidence rather than a problem with the site.

## 4. Spacing system

4px base unit. Page padding 24px, grid gutter 12px, component padding 6px vertical / 12px horizontal.

## 5. Component language

- **Radius:** `rounded-xs` 2px (row markers), `rounded-sm` 4px (badges, buttons, inputs), `rounded-md` 8px (cards, panels, the logo tile), `rounded-lg` 12px (modals, popovers). Nothing larger — enforced by not having a larger token.
- **Elevation:** border plus a one-step background shift. No `box-shadow` for elevation outside modals and popovers.
- **Status badges:** rectangular, 4px radius, uppercase mono label, a 1px border over a ~12% tint of the status colour. Never a solid fill, which turns a dense table into a wall of colour blocks, and never a capsule.
- **Tables are the primary primitive.** Uppercase mono column headers in `--text-tertiary`; mono, right-aligned numeric cells; a 1px bottom rule per row; `--bg-surface` on hover; and a 3px left-edge accent in the row's status colour rather than tinting the whole row.
- **KPI cards** frame a screen: bordered, 8px radius, on `--bg-surface-raised`, an uppercase mono label above a large mono value. Cards are for **counted** figures. A sampled figure never goes in one — it belongs in `<Estimate>`, which carries its interval (§8).
- **Cards are not a list container.** A collection of things is a table.

## 6. Navigation model

- **Left rail, 240px, persistent.** Logo tile and product name at the top, primary items, then secondary items pinned to the bottom. The active item carries a 2px left border in `--accent`, a `--bg-surface` background and an `--accent-text` label.
- **The rail's item list mirrors the Stitch design exactly:** Overview, Projects, Crawls, Issues, Tools, Analytics, then Settings and Documentation. This was the project owner's explicit decision (ADR-0027). **"Crawls" is the design's label, not a description of what this platform does** — the product samples patterns rather than crawling every URL, and a screen built under that item must not acquire crawl-everything behaviour. See the non-negotiable rules in `CLAUDE.md`.
- **An item without a screen renders disabled**, not as a link that 404s.
- **Top bar, 48px**, carrying the breadcrumb trail. Rendered per page rather than from the layout, because the trail's labels come from the page's own data. The design also shows a search field and a notification bell; both stay out until they do something.
- **Drill-down, breadcrumb-tracked:** Sites → Site → Pattern → Sample evidence, each level its own dense view.

## 7. Screen composition

Page title, then a KPI card row of 3–5 counted figures that frame the screen, then the table that carries the evidence. Progressive disclosure is the default: summary → table → drill-in. Never raw per-URL data at the top level of a view.

## 8. Interaction principles

- **Motion is fast and mechanical.** 120–200ms, `ease-out` in, `ease-in` out. No spring, bounce or elastic easing.
- **A sampled figure always renders with its interval.** ADR-0008: the `~` prefix, the interval, and the confidence band **as a word** rather than through hue alone — so it survives a screenshot, a print, and a reader who cannot separate the colours. `components/estimate.tsx` is the only module allowed to format one, and `lib/adr-0008-guard.test.ts` fails the build if a screen formats one itself.
- **Focus is always visible**, using `--accent-text`. The fill indigo is too dark against the page to read as a ring, which would make the keyboard path invisible. A component with no visible focus ring is a defect, not a style nitpick.
- **Responsive:** a desktop tool. Below ~1024px it degrades to a read-only glance mode rather than cramming dense tables into a phone.

## 9. Explicit anti-patterns (do not do these)

Hard-coded colours, radii or type sizes in a component instead of tokens; `--accent` used as a text colour; a solid-filled or capsule-shaped status badge; a grid of identical cards as the default way to show a list; drop shadows for elevation outside modals and popovers; a seventh type size; corner radii above 12px; spring or bounce easing; decorative animation of any kind; non-tabular numerals in a data column; a sampled figure rendered without its interval; a status colour picked for how it looks rather than taken from `lib/status.ts`; a rail item that links somewhere that 404s.

## 10. Implementation notes

The token layer is `apps/web/app/globals.css`. It **resets** Tailwind's `--color-*`, `--radius-*`, `--font-*` and `--text-*` namespaces rather than extending them, so a value that is not in this document does not exist to be typed: `rounded-2xl` and `bg-indigo-500` do not compile. That technique is independent of which design it enforces, and it survived the supersession deliberately (ADR-0027) — it is the reason a spec stays true instead of quietly becoming aspirational.

To re-pull the design from Stitch, note that Node cannot reach `stitch.googleapis.com` from the current dev machine: TLS inspection presents a certificate Windows trusts and Node does not, so the MCP client fails where `curl` against the same JSON-RPC endpoint succeeds. See ADR-0027.

This document should evolve the way the architecture plan does. When a real design decision changes, update this file rather than letting the shipped product silently diverge from what is written here.
