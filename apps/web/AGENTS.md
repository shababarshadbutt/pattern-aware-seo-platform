<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- Repo-specific guidance below. Next only rewrites the delimited block above. -->

## Before building any screen in this app

Read `../../DESIGN.md`. It is the source of truth for every UI decision here and
is specific rather than advisory — section 9 is a list of bans, not preferences.
The short version:

- **Dark is the default**, set via `data-theme="dark"` in `app/layout.tsx`. Light
  mode is fully designed, not an afterthought.
- **Tokens only.** `app/globals.css` resets Tailwind's default colour, radius,
  font and text-size namespaces and defines only what DESIGN.md specifies, so
  `bg-indigo-500` and `rounded-2xl` generate nothing. If a value you want does
  not exist, that is the design system working — change DESIGN.md and the token
  layer together, deliberately.
- **Every number is JetBrains Mono and tabular.** Numeric values, URLs, pattern
  strings, and status codes never fall back to the UI sans.
- **Tables, not cards.** A list of things is a table with a status-coloured
  left-edge accent per row. A grid of identical cards is an explicit
  anti-pattern.
- **Never render a sampled number without its confidence interval** — see
  ADR-0008 in `../../docs/decisions.md`. One `<Estimate>` component enforces
  this in the type system.
- Switzer is the specified UI sans but is not vendored yet. Do **not** stopgap
  with Inter or Roboto; both are banned by name.
