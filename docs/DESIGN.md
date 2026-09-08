# Design System — Pattern-Aware SEO Platform

This is the design specification for the product UI. It exists so the visual identity is a set of concrete, checkable decisions — tokens, type scale, component rules — rather than a vibe that drifts every time a new screen gets built under deadline pressure. Read this before building or modifying any UI. It complements, not replaces, `docs/CODING_STANDARDS.md` (code quality) and `docs/architecture-review-and-action-plan.md` (product/data model).

**Source of truth.** This document describes the Google Stitch design (project `12137181229897682385`), which superseded the previous "glass cockpit instrument panel" spec on 2026-09-04 — see **ADR-0027** for what changed, why, and what deliberately did not.

**The design is vendored, as of 2026-09-07.** `docs/design-source/` holds **18 screens**, each a folder with Stitch's own generated `code.html` and a `screen.png`, plus `technical_precision/DESIGN.md` — the theme's frontmatter. Earlier revisions of this document said "13 desktop screens" and could not enumerate them; the count was wrong and the enumeration is now a directory listing. This retires the provenance caveats §7.1–§7.4 carried: **§2–§5 are verified against the generated config rather than inferred**, and all 18 configs are identical on palette, radii, spacing and type scale. What a config cannot settle is which element gets which value on a given screen — for that, read that screen's own `code.html`.

One naming note: Stitch spells its radius scale `DEFAULT`/`lg`/`xl`/`full` where this app spells it `xs`/`sm`/`md`/`lg`. The VALUES are identical (2/4/8/12px); only the names differ, and the app's are kept because they read in ascending order.

Read `technical_precision/DESIGN.md`'s **frontmatter**, not its prose. The prose describes a generic Zinc palette (`#09090B`/`#18181B`/`#27272A`) that contradicts the frontmatter, the 18 generated configs and every screenshot; it is Stitch boilerplate. The frontmatter is authoritative and agrees with §3 below hex-for-hex.

`apps/web/app/globals.css` is the machine-readable copy of §2–§5; if the two disagree, this document wins and that file is the bug.

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
- **The rail's item list follows the Stitch design's order, with one label deliberately changed:** Overview, Projects, **Analyses**, Issues, Tools, Analytics, then Settings and Documentation. Stitch says "Crawls"; ADR-0027 kept that at the owner's direction while recording the tension, and **ADR-0039 resolves it** — this platform samples patterns rather than crawling every URL, and the rail is where a reader learns the product's model. A screen built under that item must still not acquire crawl-everything behaviour; see the non-negotiable rules in `CLAUDE.md`. Note that "Analyses" sits directly above "Analytics" and they are different screens (a run's sampling passes, versus per-site estimator health); if that reads badly the fix is a better name, not a return to crawler language.
- **An item without a screen renders disabled**, not as a link that 404s.
- **Top bar, 48px**, carrying the breadcrumb trail. Rendered per page rather than from the layout, because the trail's labels come from the page's own data. The design also shows a search field and a notification bell; both stay out until they do something.
- **Drill-down, breadcrumb-tracked:** Sites → Site → Pattern → Sample evidence, each level its own dense view.

## 7. Screen composition

Page title, then a KPI card row of 3–5 counted figures that frame the screen, then the table that carries the evidence. Progressive disclosure is the default: summary → table → drill-in. Never raw per-URL data at the top level of a view.

### 7.1 Project Settings

**Transcribed from the Stitch screen, not invented.** An earlier version of this section described a composition made up because no document recorded one; that was wrong and is superseded (ADR-0031). **Source: `docs/design-source/project_team_settings/`**, with the three unbuilt tabs in `project_settings_integrations/`, `project_settings_team_roles/` and `project_settings_api_webhooks/`. The token values this section depends on are now verified against the generated config; the LAYOUT was matched to a screenshot and has not been re-checked against the markup since it arrived.

The screen configures **one project**. Title, a subtitle naming the project's host, then a tab row, then two columns: a bordered "Target Configuration" form and a narrower "Project Metadata" card beside it.

- **Tabs** — `Project Core`, `Platform limits`, then `Integrations`, `Team & Roles`, `API & Webhooks` disabled with the rail's `SOON` marker. Tabs are links driven by a `?tab=` search param, not client state, so a tab is shareable and the panels stay Server Components.
- **Project selector** — an addition to the design, not in it. Stitch assumes a current project; this app has none, so a row of project chips sits above the tabs. Without it the screen cannot say which site it is editing.
- **Target Configuration** — the design's structure with this product's fields. Uppercase small-caps labels, a full-width text input, a paired field row, a hint line under a control that needs one, a divider before the checkbox rows, and right-aligned `Discard Changes` / `Save Configuration` in a divided footer. The primary button is the case the accent split exists for: `--accent` as the fill, `--accent-foreground` on it, never `text-accent`.
- **Project Metadata** — label left, value right, one hairline between rows, the card hugging its content rather than stretching to the form's height. Status renders as a `StatusBadge`, never as text alone.

Three rules specific to this screen:

- **The design's fields are not always this product's fields.** Stitch shows crawl frequency, crawl depth, a robots.txt toggle and a Puppeteer toggle; this platform has no scheduler, no link graph, no robots.txt handling and no headless browser. Rendering them would be four controls promising capabilities that do not exist. The structure is the design's; the controls are the real per-site columns. See ADR-0031 — and treat this as the rule for any Stitch screen whose fields outrun the product, rather than a one-off.
- **An inherited value is named, never shown as a dash.** A blank `daily_request_cap` means "inherit the platform figure", and `—` reads as "no limit" — the section 1.5 failure in presentational form. It renders as `inherits 250,000`, and the row still says NOT ENFORCED, because the inherited limit is itself applied by nothing.
- **Enforcement is said as a word, never only a colour**, like the confidence band (section 8). `lib/status.ts` owns the tone via `enforcementTone`; the page must not pick one. A limit nothing applies is a **warning**, not a critical — the platform is not broken, it is running on defaults while a control someone set does nothing — and not `unknown`, which means "no measurement".

### 7.2 Analysis screens

The Stitch design's analysis screens share one composition: title and header actions, a row of four KPI cards, three side-by-side panels, then a paginated explorer table. The run detail is built on it (ADR-0032); the per-site Analytics screen is the second (ADR-0034); The Tools screen borrowed it provisionally under ADR-0035 and no longer does — the owner supplied the Stitch Tools screen and it has its own composition, section 7.3. **Sources: `docs/design-source/internal_links_analysis/` and `crawl_comparison_analysis/`.** Token values are verified against the generated config; the layout was matched to a screenshot and has not been re-checked against the markup.

- **Header actions** sit opposite the title. An action with no endpoint renders inert with its reason in a `title`, the same rule the rail follows.
- **Four KPI cards**, counted only. A card may carry a short chip beside the value — a trend, or a call to attention — and one card may take a tone-coloured border when a screen has a figure that should be read first. The chip is a WORD plus colour, never colour alone.
- **Three panels** of equal width, each a `Panel` with a title.
- **An explorer table** below them, with filter chips, then a footer pairing a row range with prev/next.
- **A second widget row is permitted** where the screen has something worth a chart that the design's three panels do not cover (ADR-0033). The run analysis uses it for probe outcomes, sampling coverage and a run-history sparkline. It is not a licence to keep adding rows: a widget earns its place by answering a question the reader actually brings, not by filling space.

Four rules for these screens:

- **The design's figures are not always available, and a substitute must not borrow its name.** Stitch's depth histogram is link depth — clicks from a root document — and this platform has no link graph. The panel showing path depth says "path depth" in its title, its caption and the card's tooltip. A metric that resembles another closely enough to be misread has to say which one it is.
- **A capped or sampled list states what it is counting.** The design's explorer footer reads "SHOWING 1-4 OF 145,892", describing every URL on a site. Ours lists only URLs the sampler actually probed, so it reads "of N **sampled** URLs" and the section says the rest were never requested. Presenting a sample as a census is the one claim this product must never make.
- **Charts are hand-rolled and never the only channel.** No charting library: `apps/web` takes no UI dependencies, and a library's colour and type defaults are what the token reset exists to exclude. A chart carries `role="img"` with a summarising label and repeats its numbers in an `sr-only` table.
- **Zero draws nothing.** A minimum bar height keeps a tiny non-zero value visible, and must never be applied to zero — an empty bucket drawn as a sliver reports data that does not exist.
- **A bar series that is "N of something" is scaled against that something**, never against the tallest bar. Scaling to the series maximum is correct for a distribution, which has no other denominator, and wrong for a count: seven windows each reporting 3 of 8 patterns at low confidence all render full height, and the reader concludes every pattern is low-confidence. `BarChart` takes an optional `reference` for this, and it is clamped never to fall below the largest bar, so a mis-set reference clips nothing. Found by screenshotting a real screen, not by any test (ADR-0034).
- **Never assemble a domain object just to ask it a question.** Where a caller holds part of a shape and has to invent the rest to call a function, the invented part decides the answer: filling `strata: []` on a `StratifiedEstimate` made the expansion planner report "already precise" beside a `low` confidence band, and nothing failed. Take the inputs and build the object once, inside the package that owns it (ADR-0035).
- **Both operands of a ratio must count the same thing.** `samples_drawn / patterns_total` looks reasonable and is not: a draw is not a pattern, and an expanded pattern contributes two draws, so the meter rendered a 113% bar reading "9 / 8" the moment the demo grew a round-2 draw.
- **A degenerate series still has to draw something true.** One data point has no horizontal span and a flat series has no vertical range; both make the usual normalisation divide by zero. Draw a centred flat line rather than a shape the data does not have.
- **A status colour comes from `lib/status.ts`, including HTTP outcomes.** `httpStatusTone` knows that a soft 404 is not a healthy 200 and that no response at all is not a server error. A chart must not classify an outcome itself.

### 7.3 Tools & Utilities

**Transcribed from the Stitch Tools screen**, supplied by the owner on 2026-09-07 and replacing the provisional 7.2 arrangement ADR-0035 had borrowed (ADR-0036). **Source: `docs/design-source/technical_tools_hub/`.** Token values are verified against the generated config; the layout was matched to a screenshot and has not been re-checked against the markup.

Top to bottom: a **meta strip** (a badge, then dot-separated facts), the **title with a description and header actions opposite**, a **filter bar** (a leading search field, then category pills), a **featured hero panel** holding the tool currently loaded, then **category sections** each pairing a heading with a right-aligned small-caps label above a grid of utility cards, then a **status strip** of dot-separated facts with quiet links opposite.

- **The hero** is an accent-filled icon tile, a name with a badge, a description, a right-aligned label/value pair, a control row, and a row of result tiles across a divider. The tiles appear only once something has been computed — a row of dashes or zeros before the reader has submitted anything is the design's "it ran" state borrowed for a screen where nothing has, and zero draws nothing (section 9). Tiles carry COUNTED figures and band names only; a sampled figure needs its interval and belongs in `<Estimate>`.
- **A utility card** is an icon tile and a status pill on one row, then the name, description, an optional reason, a chip row pushed to the bottom so footers align, and a divided footer pairing a provenance line with the launch action.
- **The filter row is links and a GET form**, never client state — the same choice `Tabs` makes. Every link carries the current query, category and loaded tool forward, so filtering the catalogue cannot discard what the reader typed into the hero.

Three rules specific to this screen:

- **The design's nine tools are not this product's two, and the gap is stated rather than styled over.** Seven of the design's utilities need capabilities that do not exist here — there is no HTML parser, no headless browser, no link graph, no robots.txt fetch and **no outbound HTTP from `apps/api` at all**. They are rendered as cards, not hidden, because a reader needs to know what this platform does not do; each says in the card which capability is missing. The catalogue is DATA in `lib/tools-catalog.ts`, and `tools-catalog.test.ts` fails the build if an unavailable tool stops saying why or a launchable one points at a route that does not exist. This is section 7.1's rule — the structure is the design's, the contents are the product's — scaled from a form's fields to a whole catalogue.
- **A count chip counts what a reader can use.** The design's chip reads "3 Tools". Ours reads "1 of 3 available", because "3 Tools" over a section where none of them run is a label asserting a guarantee the code does not make.
- **`toolAvailabilityTone` owns the pill's colour, and unavailable is `unknown`, never `critical`.** A capability that was deliberately never built is not a defect; seven red cards would report a broken product to anyone who reads the grid before the text. `advisory` is a warning — the computation is real and nothing in the pipeline runs it.

One token note found here: **`text-2xs` is a label size with a label line-height** (11px on 12px). It is correct for a badge or a single-line caption and cramped for a wrapping paragraph, which needs `leading-relaxed` alongside it. Mixing a mono span into an 11px sans hint is worse still — the two faces set at the same size do not look the same size — so a hint names a field in plain capitals rather than switching face.

### 7.4 Fleet portfolio

**Transcribed from the Stitch "Projects Portfolio" screen**, supplied by the owner on 2026-09-07 (ADR-0037). **Source: `docs/design-source/projects_portfolio/`.** Token values are verified against the generated config; the layout was matched to a screenshot and has not been re-checked against the markup.

Top to bottom: a **meta strip**, the **title with a description and header actions opposite** (an export and the accent-filled create), **four KPI cards**, a **filter row of pills**, then a **bordered table** whose footer pairs a row range with prev/next, then the **status strip**.

- **A row is** an avatar tile of two letters derived from the name, the name, a tier chip, the host beneath, then the columns, then icon-only quick actions right-aligned. The row carries a tone-coloured left-edge accent like every other list in the app.
- **Pagination is links**, not client state, driven by `?page=` — so page 3 is shareable and back-button-correct. Numbered page chips are omitted deliberately: a numbered set has to decide how many to show and when to elide, and prev/next carries the same capability at every fleet size.
- **The footer names what it counts.** "Showing 1–18 of 18 tracked projects" — every project on the account, which is what `site` holds. Where a footer counts something narrower than the reader assumes, the noun says so, as the run explorer's "sampled URLs" does.
- **The create action is disclosed in place, not a modal.** This app has no overlay or focus-trap primitive; a panel that expands where the button was is honest about that, where a half-modal that traps nothing is not.

Four rules specific to this screen:

- **There is no health score, and its absence is stated on the screen.** Stitch shows "94/100" per project and "Avg. Technical Health 88.4/100" in a card. This platform computes no such number anywhere, and a composite invented in a serializer would be the most confident-looking figure on the page and the only one with no definition, no test and no way for a reader to check it. The column carries **counted findings** — a severity bar plus "35 critical of 42" — and the intro says the score is absent rather than leaving a reader to guess which card absorbed it. This is 7.1's rule (the structure is the design's, the contents are the product's) applied to a whole table.
- **A fleet figure is computed over the fleet, never over the page.** The API sends `totals` separately from the rows for exactly this reason: a KPI card that sums the visible page and labels it the fleet is the defect D3a found on both fleet screens, where a card counted 50 rows and called it the total. A filter must reach the totals as well as the rows, or the cards describe a different set from the table beneath them.
- **Never-run, in-flight, found-nothing and measured are four states, not two.** A project onboarded ten minutes ago and a project whose run found nothing both render as zeros unless something says otherwise — the section 1.5 failure in presentational form. `never run` and `not measured` are said in words; a completed run that discovered zero URLs takes a `no urls` badge beside its status, because an HTML error page parses as perfectly valid, URL-less XML and `status` cannot express it. `lib/status.ts` owns the tone via `projectRunTone`, where never-run is `unknown` (no measurement yet, not trouble) and found-nothing is a `warning`.
- **An empty table says which kind of empty it is.** No projects at all and no projects matching a filter are different situations, and one message for both leaves the reader unable to tell whether the fleet is empty or their filter hid it. The filtered case offers a link that clears the filter.

Two controls are drawn inert with their reasons rather than dropped, so a reader comparing this to the design can see they were considered: the **cadence filter** (there is no scheduler, no cadence column, and nothing anywhere stores an interval) and the **card-grid view toggle** (a grid of identical cards as a list container is a named anti-pattern in section 9 — a list of things is a table). The per-row **run-now** action is inert for the same reason as the cadence filter.

### 7.5 Pattern intelligence

**Transcribed from the Stitch "Sitemap Analyzer" screen** (`docs/design-source/sitemap_analyzer/`), which is the design's population screen and the closest one in subject to a per-run pattern explorer. There is no pattern-shaped screen in the design — all 18 were checked — so this takes the nearest real composition rather than inventing one, which is why it carries no "provisional" marking the way ADR-0035's first Tools arrangement correctly did (ADR-0038).

Top to bottom: a **meta strip**, the **title with a description**, **four KPI cards**, a **panel row** (the design's single "Sitemap Health Overview" segmented bar, widened to three panels under §7.2's allowance), a **filter and sort row**, then the **explorer table** with a footer pairing a row range with prev/next, then the **status strip**.

Four rules specific to this screen, all instances of §7.1's rule — the structure is the design's, the contents are the product's:

- **"Indexability 94%" is refused outright.** Nothing in this platform measures index state: there is no robots.txt fetch, no meta-robots parse and no Search Console integration (`finding_source` is a one-value enum with `gsc` reserved for a later phase). An index-coverage percentage would be the most confident-looking figure on the page and the only one with no definition, no test and no way for a reader to check it — the health-score refusal of §7.4, applied to a different invented number.
- **"URLs Submitted" beside "URLs Discovered" collapses to one card.** That pair is a Search Console distinction between what a sitemap declares and what Google found. This platform has one number, so it shows one, and calls it `urls discovered` with the tooltip §7.4 established: discovered from sitemaps, not requested.
- **The design's "Last Modified" column is named `parsed at`.** `sitemap_file.parsed_at` records when WE parsed the file, not the `lastmod` the sitemap declares. A metric that resembles another closely enough to be misread has to say which one it is — the same rule that made the depth histogram say "path depth".
- **There is no run-wide "estimated affected URLs" card, and the page says why.** Summing intervals across patterns is a statistical choice this screen does not make, and summing only the visible page would be D3a's defect with a new label. The estimate stays per row, where its interval belongs, and a card may only carry a counted figure anyway (§5).

One rule that is not about the design at all: **nothing published, every-finding-blocked, and measured-at-zero are three states**, and all three render as "0" unless the screen keeps them apart. A pattern with no `audit_snapshot` row renders `not measured`; a pattern whose every finding is an absence of evidence renders through `<Estimate>`'s blocked tier; a pattern genuinely measured at zero renders a real zero. Collapsing the middle into the last reports a host refusing us as a clean bill of health — §1.5 in presentational form, and the reason the API sends the rollup as an optional field rather than a number that defaults to zero.

## 8. Interaction principles

- **Motion is fast and mechanical.** 120–200ms, `ease-out` in, `ease-in` out. No spring, bounce or elastic easing.
- **A sampled figure always renders with its interval.** ADR-0008: the `~` prefix, the interval, and the confidence band **as a word** rather than through hue alone — so it survives a screenshot, a print, and a reader who cannot separate the colours. `components/estimate.tsx` is the only module allowed to format one, and `lib/adr-0008-guard.test.ts` fails the build if a screen formats one itself.
- **Focus is always visible**, using `--accent-text`. The fill indigo is too dark against the page to read as a ring, which would make the keyboard path invisible. A component with no visible focus ring is a defect, not a style nitpick.
- **Responsive:** a desktop tool. Below ~1024px it degrades to a read-only glance mode rather than cramming dense tables into a phone.

## 9. Explicit anti-patterns (do not do these)

Hard-coded colours, radii or type sizes in a component instead of tokens; `--accent` used as a text colour; a solid-filled or capsule-shaped status badge; a grid of identical cards as the default way to show a list; drop shadows for elevation outside modals and popovers; a seventh type size; corner radii above 12px; spring or bounce easing; decorative animation of any kind; non-tabular numerals in a data column; a sampled figure rendered without its interval; a status colour picked for how it looks rather than taken from `lib/status.ts`; a rail item that links somewhere that 404s.

## 10. Implementation notes

The token layer is `apps/web/app/globals.css`. It **resets** Tailwind's `--color-*`, `--radius-*`, `--font-*` and `--text-*` namespaces rather than extending them, so a value that is not in this document does not exist to be typed: `rounded-2xl` and `bg-indigo-500` do not compile. That technique is independent of which design it enforces, and it survived the supersession deliberately (ADR-0027) — it is the reason a spec stays true instead of quietly becoming aspirational.

**Stitch itself is still unreachable from this dev machine, and it no longer matters.** ADR-0027 recorded that Node failed on the TLS-inspection certificate while `curl` against the same JSON-RPC endpoint succeeded; by 2026-09-05 that workaround was dead too — the handshake fails from Node, from `curl`/schannel and from .NET alike, specific to `*.googleapis.com`. Anyone needing the live tool still needs the inspecting proxy's root CA in the trust store, or a different network.

**The design is vendored instead**, which is a fix rather than a workaround: `docs/design-source/` holds all 18 screens with their generated HTML, so the source no longer depends on one machine's network path. **Check a screen against its own `code.html` before matching it to a screenshot.**

A screen the design does not cover is still a question for the owner, not a gap to fill (ADR-0031) — the vendored folder makes it cheap to establish which of the two a given screen is. Where a Stitch screen exists but its FIGURES outrun the product, take the composition and refuse the figures, stating the refusal on screen: §7.1's rule, applied at screen scale in §7.2 and §7.5.

This document should evolve the way the architecture plan does. When a real design decision changes, update this file rather than letting the shipped product silently diverge from what is written here.
