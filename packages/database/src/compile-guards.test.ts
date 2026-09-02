import { readFileSync } from "node:fs";
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

describe("the package has exactly one entry point", () => {
  /**
   * `client.ts` really does export `internalDatabase`, and that is fine only
   * because nothing outside this package can import it: the `exports` map
   * publishes `.` alone, so a subpath import fails to resolve in both Node and
   * TypeScript's NodeNext resolution.
   *
   * That makes the exports map load-bearing rather than cosmetic. Adding a
   * wildcard subpath — a plausible convenience — would quietly reopen the
   * escape hatch that ADR-0004 closes, so it is asserted here instead of being
   * left to whoever reviews that change.
   */
  it("publishes no subpath that would expose the raw Drizzle handle", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8"
      )
    ) as { exports?: Record<string, unknown> };

    expect(Object.keys(manifest.exports ?? {})).toEqual(["."]);
  });
});
