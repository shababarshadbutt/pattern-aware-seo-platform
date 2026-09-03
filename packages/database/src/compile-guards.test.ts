import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Database } from "./client.js";
import { listSites } from "./repositories/site.js";
import { type SiteScope, systemOrganizationScope } from "./scope.js";

/**
 * The M1 acceptance criterion that cannot be checked at runtime: "a deliberately
 * unscoped query fails to compile."
 *
 * Every `@ts-expect-error` below is the assertion. If the guard it describes
 * ever weakens, TypeScript stops reporting an error there, `@ts-expect-error`
 * becomes an unused directive, and `tsc --noEmit` fails the build — so these
 * are enforced by the typecheck gate, not by the assertions in the test bodies.
 *
 * The runtime `expect` calls exist only so Vitest has something to run; the real
 * test is that this file compiles.
 */

// Never dereferenced. The types are the subject under test, not the values.
const db = undefined as unknown as Database;
const siteScope = undefined as unknown as SiteScope;

describe("the Database handle is opaque outside the repository layer", () => {
  it("exposes no query builder", () => {
    // @ts-expect-error - `Database` has no `select`. There is no way to start a
    // query outside packages/database, which is what makes an unscoped read
    // impossible rather than merely discouraged (ADR-0004).
    void (() => db.select);

    // @ts-expect-error - nor `insert`, `update`, `delete`, or `execute`.
    void (() => db.execute);

    expect(typeof listSites).toBe("function");
  });
});

describe("repositories cannot be called without a scope", () => {
  it("requires a scope argument", () => {
    // @ts-expect-error - listSites(db) is missing the organization scope. There
    // is no unscoped overload, so "just read everything" is not expressible.
    void (() => listSites(db));

    expect(typeof listSites).toBe("function");
  });

  it("will not accept a site scope where an organization scope is required", () => {
    // @ts-expect-error - the two scopes are distinct brands. A site-level
    // authority cannot be widened into an organization-level one by passing it
    // to a function that wanted the wider type.
    void (() => listSites(db, siteScope));

    expect(typeof listSites).toBe("function");
  });
});

describe("scopes cannot be fabricated from object literals", () => {
  it("rejects a hand-rolled scope", () => {
    // @ts-expect-error - the brand is not constructible outside scope.ts, so a
    // bare `{ organizationId, siteId }` from code that checked nothing cannot
    // reach a repository.
    const forged: SiteScope = {
      organizationId: "org",
      siteId: "site",
      origin: "request"
    };

    void forged;

    // ...whereas the named constructors work, and their names record where the
    // authority came from.
    expect(systemOrganizationScope("org").origin).toBe("system");
  });
});

describe("the package's entry points", () => {
  /**
   * `client.ts` really does export `internalDatabase`, and that is fine only
   * because nothing outside this package can import it: the `exports` map
   * publishes no path that reaches it, so such an import fails to resolve in
   * both Node and TypeScript's NodeNext resolution.
   *
   * That makes the exports map load-bearing rather than cosmetic. Adding a
   * wildcard subpath — a plausible convenience — would quietly reopen the
   * escape hatch that ADR-0004 closes, so the exact set is asserted here
   * instead of being left to whoever reviews that change.
   *
   * `./testing` is the one sanctioned addition (ADR-0023, decided in
   * CODING_STANDARDS section 1.4). It does not loosen `.`: the harness returns
   * the same opaque `Database`, so a test can create and drop a database and
   * still cannot write an unscoped query. The condition attached to that
   * decision — that it is never imported outside a test — is the next test.
   */
  it("publishes exactly the sanctioned entry points", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8"
      )
    ) as { exports?: Record<string, unknown> };

    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual([
      ".",
      "./testing"
    ]);
  });

  /**
   * The second condition CODING_STANDARDS section 1.4 attaches to `./testing`:
   * it must never be imported from `apps/*\/src` or any non-test file.
   *
   * Without this the subpath is just a wider public API. The harness creates
   * and drops databases with a `pg` client of its own; that is proportionate
   * in a test and completely inappropriate in a request path, and the
   * difference is a convention until something checks it.
   */
  it("is imported only from test files, never from application source", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const offences: string[] = [];

    const walk = (directory: string): void => {
      if (!existsSync(directory)) {
        return;
      }

      for (const entry of readdirSync(directory)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".next") {
          continue;
        }

        const path = join(directory, entry);

        if (statSync(path).isDirectory()) {
          walk(path);

          continue;
        }

        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) {
          continue;
        }

        /**
         * Matches an IMPORT, not a mention.
         *
         * A first version searched for the bare specifier anywhere in the file
         * and flagged `apps/api/vitest.config.ts`, whose docblock explains why
         * those tests live outside `src` — a comment describing this rule read
         * as a violation of it. The check has to look at what a module
         * actually pulls in, not at what it talks about.
         */
        const importsHarness =
          /(?:from|import)\s*\(?\s*["']@pattern-aware\/database\/testing["']/u.test(
            readFileSync(path, "utf8")
          );

        if (!importsHarness) {
          continue;
        }

        const relative = path.replace(repoRoot, "").replaceAll("\\", "/");
        const isTestFile = /\.(test|spec)\.tsx?$/u.test(entry);
        const isUnderAppSource = /^\/?apps\/[^/]+\/src\//u.test(relative);

        if (!isTestFile || isUnderAppSource) {
          offences.push(relative);
        }
      }
    };

    walk(join(repoRoot, "apps"));
    walk(join(repoRoot, "packages"));
    walk(join(repoRoot, "scripts"));

    expect(offences).toEqual([]);
  });
});
