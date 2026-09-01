import { PARAM_SEGMENT } from "./pattern-trie.js";

/**
 * Render a path as a pattern template.
 *
 * `["product", "123"]` with position 1 variable becomes `/product/{param}`.
 * This is the string that identifies a pattern, so it has to be stable: the
 * same path with the same parameterization must always produce the same
 * template, in every worker thread and on every rerun.
 */
export function templateForSegments(
  segments: readonly string[],
  parameterizedPositions: ReadonlySet<number>
): string {
  if (segments.length === 0) {
    return "/";
  }

  const rendered = segments.map((segment, index) =>
    parameterizedPositions.has(index) ? PARAM_SEGMENT : segment
  );

  return `/${rendered.join("/")}`;
}

/** Recover the segments of a template. The inverse of {@link templateForSegments}. */
export function segmentsFromTemplate(template: string): readonly string[] {
  return template.split("/").filter((segment) => segment !== "");
}

/** How many path segments a template has. Its arity, and its tracker key. */
export function templateArity(template: string): number {
  return segmentsFromTemplate(template).length;
}

/** How many positions in a template are variable. */
export function templateParamCount(template: string): number {
  return segmentsFromTemplate(template).filter(
    (segment) => segment === PARAM_SEGMENT
  ).length;
}
