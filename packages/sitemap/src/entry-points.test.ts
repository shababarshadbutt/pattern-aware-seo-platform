import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the `./extraction` subpath promises, enforced rather than trusted.
 *
 * The subpath exists so `apps/api` can fold a pasted list of URLs into the same
 * `PatternAccumulator` the pipeline uses without evaluating `node:fs`,
 * `node:zlib`, `sax` and a fixture generator holding `rmSync` — all of which
 * the package root pulls in, because its barrel also re-exports the parser, the
 * file store and the synthetic corpus.
 *
 * That claim is only true for as long as nobody adds an import. A comment
 * saying "this subtree is pure" is exactly the kind of assertion §1.9 is about:
 * a label promising a guarantee the code does not make. So the second test
 * below IS the guarantee, and the first stops the exports map quietly growing a
 * third entry that nothing checked.
 */

const PACKAGE_ROOT = existsSync(join(process.cwd(), "src", "extraction"))
  ? process.cwd()
  : join(process.cwd(), "packages", "sitemap");

/** The exact export surface. A new subpath must be a deliberate edit here. */
const SANCTIONED_EXPORTS = [".", "./extraction"] as const;

/**
 * What the extraction subtree may not reach for.
 *
 * `node:` covers every builtin; the two bare specifiers are this package's own
 * runtime dependencies. A relative import is always fine — the point is the
 * dependency graph, not the file count.
 */
const FORBIDDEN_SPECIFIER = /^(?:node:|sax$|undici$)/u;

/** Every `import ... from "x"` and `export ... from "x"` specifier in a file. */
function specifiersIn(source: string): readonly string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/gu)].map(
    (match) => match[1] ?? ""
  );
}

function sourceFilesUnder(directory: string): readonly string[] {
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);

      if (statSync(path).isDirectory()) {
        walk(path);

        continue;
      }

      if (entry.endsWith(".ts") && !entry.includes(".test.")) {
        found.push(path);
      }
    }
  };

  walk(join(PACKAGE_ROOT, directory));

  return found;
}

describe("the package's export surface", () => {
  it("publishes exactly the sanctioned entry points", () => {
    /**
     * Verbatim the `packages/database` precedent: the assertion is on the
     * COMPLETE set, not on the presence of each, so a wildcard or a third
     * subpath fails on the commit that adds it rather than whenever someone
     * next reads the manifest.
     */
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
    ) as { readonly exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports).sort()).toEqual([
      ...SANCTIONED_EXPORTS
    ]);
  });
});

describe("the extraction subtree stays free of node and third-party imports", () => {
  it("finds files to check, so a passing result is not vacuous", () => {
    // Guards the guard. A renamed directory would otherwise make every
    // assertion below pass over an empty list while reporting success.
    expect(sourceFilesUnder(join("src", "extraction")).length).toBeGreaterThan(
      4
    );
  });

  it("recognises a forbidden specifier where one really is present", () => {
    /**
     * A POSITIVE CONTROL on the matcher itself, not on the subtree.
     *
     * `policy-enforcement-guard.test.ts` was written with `\b` inside a
     * template literal — a BACKSPACE character, not a word boundary — which
     * made every one of its assertions pass at once while checking nothing. A
     * matcher that can only ever report success is not a guard, so this proves
     * it fires: `parser/loc-stream.ts` genuinely imports `sax`.
     */
    const parser = readFileSync(
      join(PACKAGE_ROOT, "src", "parser", "loc-stream.ts"),
      "utf8"
    );

    expect(
      specifiersIn(parser).filter((specifier) =>
        FORBIDDEN_SPECIFIER.test(specifier)
      )
    ).toContain("sax");
  });

  it("no file under src/extraction imports a builtin or a dependency", () => {
    const offences: string[] = [];

    for (const file of sourceFilesUnder(join("src", "extraction"))) {
      for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
        if (FORBIDDEN_SPECIFIER.test(specifier)) {
          offences.push(`${file} imports ${specifier}`);
        }
      }
    }

    expect(
      offences,
      `The ./extraction subpath exists so a request-serving process can import pattern extraction without evaluating node builtins, sax, or the synthetic-corpus fixture generator. These imports break that:\n${offences.join("\n")}\nEither move the code that needs them out of src/extraction, or remove the subpath and its docblock claim.`
    ).toEqual([]);
  });
});
