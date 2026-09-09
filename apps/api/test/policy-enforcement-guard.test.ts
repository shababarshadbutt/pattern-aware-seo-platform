import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

import { POLICY_LIMITS, SITE_POLICY_COLUMNS } from "../src/policy-manifest.js";

/**
 * The manifest's `enforcedAt` claims, checked against the source tree.
 *
 * WHY THIS EXISTS. `/settings` tells a reader that five HTTP budgets and two
 * site columns are configured but applied by nothing. That statement is true
 * today and will become false the moment somebody wires one up — and a screen
 * that keeps saying "NOT ENFORCED" about a limit now in force is worse than one
 * that never said anything, because it invites the reader to discount a control
 * that is really there.
 *
 * So the claim is not trusted. This walks the source tree and checks it in BOTH
 * directions: a limit marked enforced must be referenced where the manifest
 * says, and a limit marked unenforced must be referenced nowhere at all. The
 * second direction is the one that matters — it fails on the commit that adds
 * the enforcement, naming the remedy, rather than months later when someone
 * notices the screen is lying.
 *
 * A grep-shaped guard has to be verified both ways, per the M7 finding where
 * the first version of the database import guard flagged a docblock that merely
 * described the rule. Hence the guard-the-guard test at the bottom.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Roots to scan: every workspace's source, and nothing generated. */
const SCAN_ROOTS = [
  join(REPO_ROOT, "apps"),
  join(REPO_ROOT, "packages")
] as const;

/**
 * Files that may name a policy key without meaning "this is enforced here".
 *
 * `config.ts` DEFINES the keys, the manifest DESCRIBES them, and a test may
 * assert about them — none of those three is an application of a limit. Nothing
 * else gets an exemption: the point is that an ordinary source file mentioning
 * a key is treated as consuming it.
 */
const EXEMPT = [
  join("packages", "shared", "src", "config.ts"),
  join("apps", "api", "src", "policy-manifest.ts")
] as const;

function isExempt(repoPath: string): boolean {
  return (
    EXEMPT.some((exempt) => repoPath === exempt) ||
    repoPath.includes(".test.") ||
    repoPath.includes(`${sep}dist${sep}`) ||
    repoPath.includes(`${sep}node_modules${sep}`)
  );
}

interface SourceFile {
  /** Repo-relative, with the platform's separator. */
  readonly path: string;
  /** Source with comments removed — see {@link stripComments}. */
  readonly text: string;
}

/**
 * Drop comments, because A MENTION IS NOT A CONSUMPTION.
 *
 * `schema/tenancy.ts` documents `daily_request_cap` as "a per-site override of
 * HTTP_PER_SITE_DAILY_REQUEST_CAP" — prose explaining what the column means,
 * not code applying the limit. Without this, that docblock alone made the guard
 * report the cap as enforced, which is the M7 finding repeating: the first
 * version of the database import guard flagged a comment that merely described
 * the rule it was policing.
 *
 * A regex, not a parser. Over-stripping would hide a real reference and surface
 * as a false "referenced nowhere" on the enforced side — loud, and in the
 * direction that gets investigated — so the failure mode is acceptable for a
 * check whose job is to notice a change, not to compile.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

function collectSources(dir: string, into: SourceFile[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") {
      continue;
    }

    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      collectSources(full, into);
      continue;
    }

    if (!/\.(ts|tsx)$/u.test(entry)) {
      continue;
    }

    const path = relative(REPO_ROOT, full);

    if (isExempt(path)) {
      continue;
    }

    into.push({ path, text: stripComments(readFileSync(full, "utf8")) });
  }
}

const SOURCES: SourceFile[] = [];

for (const root of SCAN_ROOTS) {
  collectSources(root, SOURCES);
}

/**
 * Every file referencing `name`, as a property access or a bare identifier.
 *
 * `String.raw`, and not as a style preference. Written as a plain template
 * literal, `\b` is an escape the literal resolves before the RegExp ever sees
 * it — so the pattern became a BACKSPACE character either side of the name and
 * matched nothing. Every "this limit is referenced nowhere" assertion below
 * then passed vacuously, and the manifest could have claimed anything. The
 * enforced-direction test is what caught it, which is the whole argument for
 * checking both directions instead of only the one you care about.
 */
function referencesTo(name: string): readonly SourceFile[] {
  const pattern = new RegExp(String.raw`\b` + name + String.raw`\b`, "u");

  return SOURCES.filter((source) => pattern.test(source.text));
}

/** Normalise a manifest path to this platform's separator for comparison. */
function normalise(path: string): string {
  return path.split("/").join(sep);
}

/**
 * Roots that PRESENT a limit rather than apply one.
 *
 * `apps/web/lib/settings.ts` names `HTTP_PER_SITE_DAILY_REQUEST_CAP` to resolve
 * what a site with no cap of its own inherits — it is rendering the number, and
 * a browser cannot enforce a server-side request budget. `apps/api` serves the
 * same values. Counting either as enforcement made the guard flag the very
 * screen built to report the gap.
 *
 * A CARVE-OUT, NOT AN ALLOWLIST, deliberately: everything outside these two
 * stays in scope, so the guard still fails on an enforcement added anywhere it
 * could actually happen — the worker, or any package that samples or issues
 * requests. An allowlist of "places enforcement may live" would silently miss a
 * root nobody remembered to add.
 */
const PRESENTATION_ROOTS = [join("apps", "api"), join("apps", "web")] as const;

function isPresentation(path: string): boolean {
  return PRESENTATION_ROOTS.some((root) => path.startsWith(root));
}

const POLICY_ENTRIES = Object.entries(POLICY_LIMITS);
const SITE_ENTRIES = Object.entries(SITE_POLICY_COLUMNS);

describe("the policy manifest's enforcement claims", () => {
  it("scanned a real source tree, not an empty one", () => {
    /**
     * GUARD THE GUARD. A walk that silently stops finding files makes every
     * assertion below pass vacuously — and the "unenforced means zero
     * references" direction passes MOST easily when nothing was read at all.
     */
    expect(SOURCES.length).toBeGreaterThan(60);
    expect(POLICY_ENTRIES.length).toBeGreaterThan(20);

    /**
     * A POSITIVE CONTROL ON THE MATCHER, not only on the file walk.
     *
     * A broken `referencesTo` is the more dangerous failure: it makes the
     * "unenforced" direction pass for every key at once. That happened during
     * development — see the note on `referencesTo` — and a files-scanned floor
     * did not notice, because the files were there and the regex was the thing
     * that was wrong. So assert the matcher finds something it must find, and
     * rejects something it must not.
     */
    expect(referencesTo("HostRateLimiter")).not.toHaveLength(0);
    expect(referencesTo("NoSuchIdentifierExistsAnywhere")).toHaveLength(0);
    expect(
      POLICY_ENTRIES.filter(([, meta]) => meta.enforcedAt !== null)
    ).not.toHaveLength(0);
    expect(
      POLICY_ENTRIES.filter(([, meta]) => meta.enforcedAt === null)
    ).not.toHaveLength(0);
  });

  it("finds every limit it calls enforced in the file it names", () => {
    for (const [key, meta] of POLICY_ENTRIES) {
      if (meta.enforcedAt === null) {
        continue;
      }

      const files = referencesTo(key).map((source) => source.path);

      expect(
        files,
        `${key} is marked enforced at ${meta.enforcedAt} but is referenced nowhere. Either it lost its consumer, or the path in apps/api/src/policy-manifest.ts is stale.`
      ).not.toHaveLength(0);

      expect(
        files,
        `${key} is marked enforced at ${meta.enforcedAt}, but no reference is in that file (found: ${files.join(", ")}). Update enforcedAt in apps/api/src/policy-manifest.ts.`
      ).toContain(normalise(meta.enforcedAt));
    }
  });

  it("finds NO reference to a limit it calls unenforced", () => {
    /**
     * The direction that earns this file. When someone finally charges the
     * daily request cap or passes a real escalation budget, this fails here —
     * on their commit, naming the file they just edited and the line to change.
     */
    for (const [key, meta] of POLICY_ENTRIES) {
      if (meta.enforcedAt !== null) {
        continue;
      }

      const files = referencesTo(key)
        .map((source) => source.path)
        .filter((path) => !isPresentation(path));

      expect(
        files,
        `${key} is marked NOT enforced, but ${files.join(", ")} references it. If it is now applied, set enforcedAt to that path in apps/api/src/policy-manifest.ts — the Settings screen is currently telling readers this limit does nothing.`
      ).toHaveLength(0);
    }
  });

  it("finds no verification-side use of the two unenforced site columns", () => {
    /**
     * A different exclusion set, because these are database columns rather than
     * environment variables: packages/database owns them, and apps/api and
     * apps/web legitimately carry and render them. Only a reference from the
     * code that actually issues requests would mean one had become real.
     *
     * `HostRateLimiter`'s options accept no per-site interval and `#intervalMs`
     * is derived once from `requestsPerSecond` — that absence is what this
     * asserts.
     */
    const consumingRoots = [
      join("packages", "verification"),
      join("packages", "pipeline"),
      join("packages", "sampling"),
      join("apps", "worker")
    ];

    for (const [key, meta] of SITE_ENTRIES) {
      if (meta.enforcedAt !== null) {
        continue;
      }

      const offenders = referencesTo(key)
        .map((source) => source.path)
        .filter((path) => consumingRoots.some((root) => path.startsWith(root)));

      expect(
        offenders,
        `site.${key} is marked NOT enforced, but ${offenders.join(", ")} references it. If it is now applied, set enforcedAt in apps/api/src/policy-manifest.ts.`
      ).toHaveLength(0);
    }
  });
});
