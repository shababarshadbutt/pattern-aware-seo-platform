export const PARAM_SEGMENT = "{param}";

/**
 * A path segment stops being a literal when its siblings are numerous...
 */
export const PARAM_UNIQUE_THRESHOLD = 100;

/**
 * ...or when almost every value in that slot is different.
 */
export const PARAM_UNIQUE_RATIO_THRESHOLD = 0.6;

/**
 * How many URLs must pass through a slot before the ratio rule is allowed to
 * fire.
 *
 * The legacy engine uses 3, and that is a bug rather than a tuning choice. The
 * first three URLs through any slot are almost always three different values,
 * so the ratio is 1.0 and the slot parameterises immediately — on real input
 * this collapses `/about`, `/contact` and `/terms` into a single `/{param}`.
 * Measured on the synthetic corpus, the legacy floor merged 2,946 static pages
 * into one meaningless pattern.
 *
 * 30 is this project's statistical floor everywhere else — below roughly thirty
 * observations a proportion estimate carries an interval so wide it says
 * nothing (see SAMPLE_MIN_SIZE) — so the same number is used here rather than
 * inventing a second one. The absolute-count rule still catches a genuinely
 * variable slot long before then.
 */
export const PARAM_MIN_OBSERVED_URLS = 30;

/**
 * Depth of the subtree fingerprint used to decide which siblings are alike.
 * Two is enough to tell `section-N/page/…` from `shop/{category}/…` without
 * walking whole subtrees on every check.
 */
const SIGNATURE_DEPTH = 2;

/** Above this fanout a node is summarised as variable inside a signature. */
const SIGNATURE_FANOUT_CAP = 8;

/** Re-check a collapse decision once a node's fanout has grown by this factor. */
const RECHECK_GROWTH_FACTOR = 2;

/**
 * Fanout at which a node collapses MID-STREAM, before the pass has finished.
 *
 * Set far above the real thresholds because collapsing early is a memory guard,
 * not a decision. Signatures computed while the trie is still filling are
 * unreliable — a node created moments ago has no subtree yet, so it fingerprints
 * as a leaf and gets grouped with genuine leaves — and a slot that collapses on
 * that evidence can never recover, because subsequent literals are routed into
 * the variable branch and lose their identity.
 *
 * So mid-stream collapse only fires when holding the literals would actually
 * cost something, and the real decision is deferred to {@link PatternTrie.finalize}
 * where every subtree is complete. A slot crowded enough to trip this really is
 * variable, so collapsing it early is correct anyway.
 */
const SAFETY_FANOUT = 512;

/** Whatever the caller wants to hang off a completed path. */
export interface TerminalFactory<T> {
  create(): T;
  merge(target: T, source: T): void;
}

interface TrieNode<T> {
  /** Literal child segments. Emptied when this node collapses. */
  children: Map<string, TrieNode<T>>;
  /** URLs that have chosen a child at this node. The ratio rule's denominator. */
  observations: number;
  /** Children merged into a single `{param}` branch. */
  paramChild: TrieNode<T> | undefined;
  /** Payload for a path that ENDS here. */
  terminal: T | undefined;
  /** Fanout at the last collapse evaluation, to throttle re-checks. */
  lastCheckedFanout: number;
}

function createNode<T>(): TrieNode<T> {
  return {
    children: new Map(),
    observations: 0,
    paramChild: undefined,
    terminal: undefined,
    lastCheckedFanout: 0
  };
}

/**
 * Groups URLs into patterns by their path shape, deciding which segments are
 * variable FROM CONTEXT rather than from position alone.
 *
 * WHY A TRIE, AND WHY THIS IS NOT THE ALGORITHM THAT WAS PORTED.
 *
 * The legacy engine keeps one counter per path position, shared by every URL on
 * the site: everything at position 0 is pooled, everything at position 1 is
 * pooled, and each position is judged variable or literal on those totals. That
 * throws away the only information that distinguishes the cases. Run against
 * the synthetic corpus, which is modelled on the shapes real sitemaps contain,
 * it produced:
 *
 *     16,477  /part/{param}
 *      9,660  /{param}/{param}/{param}     <- three unrelated families merged
 *      2,946  /{param}                     <- /about, /contact, /terms
 *        917  /catalog/{param}/{param}/detail/{param}
 *
 * A third of the site in one pattern that describes nothing. The run succeeds,
 * the population is right, and every downstream estimate is about a group with
 * no shared meaning — which is the worst kind of wrong, because nothing looks
 * broken.
 *
 * A trie fixes it because the decision is made per node. `shop` and `legacy`
 * keep their literal first segment while three hundred `section-N` siblings
 * collapse, because those are three separate decisions rather than one vote at
 * position 0.
 *
 * SIBLINGS ARE COLLAPSED BY SHAPE, NOT JUST BY COUNT. Numerousness alone is not
 * enough: the root of that corpus has 311 children, and collapsing them
 * wholesale rebuilds the same mega-pattern one level down. So when a node is
 * crowded, its children are fingerprinted by the shape of their own subtrees
 * and only groups of genuinely interchangeable siblings collapse. Three hundred
 * children that all look like `page/…` are one variable slot; the `shop` child
 * next to them is not, and keeps its name.
 *
 * Recorded as ADR-0012.
 */
export class PatternTrie<T> {
  readonly #root: TrieNode<T> = createNode();
  readonly #factory: TerminalFactory<T>;

  #nodeCount = 1;

  public constructor(factory: TerminalFactory<T>) {
    this.#factory = factory;
  }

  /** Nodes currently held. Used by the caller's memory accounting. */
  public get nodeCount(): number {
    return this.#nodeCount;
  }

  /**
   * Walk a path, creating nodes as needed, and return the payload at its end.
   *
   * Called once per URL, so it does one Map lookup per segment and evaluates a
   * collapse only when a node's fanout has actually grown enough to change the
   * answer.
   */
  public terminalFor(segments: readonly string[]): T {
    let node = this.#root;

    for (const segment of segments) {
      node = this.#descend(node, segment);
    }

    node.terminal ??= this.#factory.create();

    return node.terminal;
  }

  /** Every completed path, as a template with `{param}` for variable slots. */
  public entries(): readonly { template: string; terminal: T }[] {
    this.finalize();

    const out: { template: string; terminal: T }[] = [];

    this.#walk(this.#root, [], out);

    return out;
  }

  /**
   * Make the collapse decisions properly, now that every subtree is complete.
   *
   * This is where parameterisation is actually decided. During the pass the
   * trie only collapses to protect memory, because a fingerprint taken while
   * the trie is filling reflects how much of a subtree happened to have arrived
   * rather than its shape — and a wrong collapse is unrecoverable, since the
   * merged children have lost their names.
   *
   * Idempotent, so calling `entries()` twice is free.
   */
  public finalize(): void {
    this.#reevaluate(this.#root);
  }

  /**
   * Fold another trie in.
   *
   * Needed for parallel parsing and for crash resume. Collapse decisions are
   * re-evaluated afterwards, because evidence that was below the threshold in
   * either half separately can cross it once combined — and skipping that would
   * leave the same pattern under two different templates.
   */
  public merge(other: PatternTrie<T>): void {
    this.#mergeNode(this.#root, other.#root);
    this.#reevaluate(this.#root);
  }

  #descend(node: TrieNode<T>, segment: string): TrieNode<T> {
    node.observations += 1;

    /**
     * Literal children are checked FIRST, even after a collapse.
     *
     * A collapse here is usually partial: three hundred `section-N` siblings
     * become `{param}` while `shop`, `part` and `legacy` keep their names.
     * Short-circuiting to the variable branch the moment one exists makes those
     * survivors unreachable, and every later URL that should have matched one
     * of them lands in `{param}` instead — which rebuilds the mega-pattern this
     * class exists to prevent, one level down. It cost 15,726 URLs on the
     * synthetic corpus before this ordering was fixed.
     */
    let child = node.children.get(segment);

    if (child !== undefined) {
      return child;
    }

    // Unrecognised value in a slot already known to be variable: that is what
    // the variable branch is for.
    if (node.paramChild !== undefined) {
      return node.paramChild;
    }
    child = createNode<T>();
    this.#nodeCount += 1;
    node.children.set(segment, child);

    // Only a NEW sibling can change anything, only once the fanout has moved
    // meaningfully since the last look, and only past the memory guard.
    if (
      node.children.size >= SAFETY_FANOUT &&
      node.children.size >= node.lastCheckedFanout * RECHECK_GROWTH_FACTOR
    ) {
      this.#maybeCollapse(node);

      // The child just created may have been folded into the variable branch.
      const survivor = node.children.get(segment);

      if (survivor !== undefined) {
        return survivor;
      }

      if (node.paramChild !== undefined) {
        return node.paramChild;
      }
    }

    return child;
  }

  /**
   * Decide whether this node's children are variable, and collapse the ones
   * that are.
   */
  #maybeCollapse(node: TrieNode<T>): void {
    node.lastCheckedFanout = node.children.size;

    if (!this.#looksVariable(node.children.size, node.observations)) {
      return;
    }

    // Crowded — but are the children interchangeable, or is this a mixed bag?
    const bySignature = new Map<string, string[]>();

    for (const [value, child] of node.children) {
      const signature = this.#signature(child, SIGNATURE_DEPTH);
      const group = bySignature.get(signature);

      if (group === undefined) {
        bySignature.set(signature, [value]);
      } else {
        group.push(value);
      }
    }

    // One shape for everything: the whole slot is variable.
    if (bySignature.size === 1) {
      this.#collapseAll(node);

      return;
    }

    // Mixed: collapse only the groups that are themselves numerous, and leave
    // the distinctive siblings — `shop`, `legacy` — with their own names.
    let collapsedInto: TrieNode<T> | undefined;

    for (const group of bySignature.values()) {
      if (!this.#looksVariable(group.length, node.observations)) {
        continue;
      }

      collapsedInto ??= createNode<T>();
      this.#nodeCount += 1;

      for (const value of group) {
        const child = node.children.get(value);

        if (child !== undefined) {
          this.#mergeNode(collapsedInto, child);
          node.children.delete(value);
        }
      }
    }

    if (collapsedInto !== undefined) {
      node.paramChild = collapsedInto;
      node.lastCheckedFanout = node.children.size;
    }
  }

  #looksVariable(distinct: number, observations: number): boolean {
    if (distinct > PARAM_UNIQUE_THRESHOLD) {
      return true;
    }

    return (
      observations >= PARAM_MIN_OBSERVED_URLS &&
      distinct / observations >= PARAM_UNIQUE_RATIO_THRESHOLD
    );
  }

  /**
   * A short fingerprint of a subtree's shape.
   *
   * Names are included for the IMMEDIATE children only; everything deeper is
   * reduced to whether it is a leaf or a branch. That split is the whole point.
   * Names one level down are the discriminating information — three hundred
   * `section-N` siblings all continue with `page`, while `shop` continues with
   * five category names — but names further down are noise, and including them
   * makes the fingerprint unstable while the trie is still filling.
   *
   * That instability is not hypothetical: a first attempt at this recursed with
   * names all the way, so a section whose subtree held one URL fingerprinted
   * differently from its neighbour holding two. Every sibling looked unique,
   * nothing collapsed, and the corpus produced one pattern per URL — the exact
   * opposite of the over-collapse this class exists to fix.
   */
  #signature(node: TrieNode<T>, depth: number): string {
    if (depth <= 0) {
      return PatternTrie.#shapeOf(node);
    }

    if (node.paramChild !== undefined) {
      return `*>${this.#signature(node.paramChild, depth - 1)}`;
    }

    if (node.children.size === 0) {
      return "$";
    }

    // Too many to enumerate, and a node this crowded is about to become
    // variable anyway. Its identity is "branch", not its child list.
    if (node.children.size > SIGNATURE_FANOUT_CAP) {
      return "*";
    }

    return [...node.children.keys()]
      .sort()
      .map((key) => {
        const child = node.children.get(key);

        return `${key}>${child === undefined ? "$" : PatternTrie.#shapeOf(child)}`;
      })
      .join("|");
  }

  /**
   * Leaf or branch, and nothing more.
   *
   * Deliberately binary. Grading by fanout — one child, a few, many — would
   * split otherwise-identical siblings into separate groups purely because of
   * how much of each subtree happened to have arrived, and none of the groups
   * would reach the threshold to collapse.
   */
  static #shapeOf<U>(node: TrieNode<U>): string {
    return node.children.size === 0 && node.paramChild === undefined
      ? "$"
      : "*";
  }

  #collapseAll(node: TrieNode<T>): void {
    const param = createNode<T>();

    this.#nodeCount += 1;

    for (const child of node.children.values()) {
      this.#mergeNode(param, child);
    }

    node.children.clear();
    node.paramChild = param;
    node.lastCheckedFanout = 0;
  }

  #mergeNode(target: TrieNode<T>, source: TrieNode<T>): void {
    target.observations += source.observations;

    if (source.terminal !== undefined) {
      if (target.terminal === undefined) {
        target.terminal = source.terminal;
      } else {
        this.#factory.merge(target.terminal, source.terminal);
      }
    }

    if (source.paramChild !== undefined) {
      if (target.paramChild === undefined) {
        target.paramChild = source.paramChild;
        this.#nodeCount += 1;
      } else {
        this.#mergeNode(target.paramChild, source.paramChild);
      }
    }

    for (const [value, child] of source.children) {
      // Once a slot is variable, literal siblings arriving from the other side
      // belong in the variable branch too — otherwise the same pattern ends up
      // under two templates.
      if (target.paramChild !== undefined) {
        this.#mergeNode(target.paramChild, child);

        continue;
      }

      const existing = target.children.get(value);

      if (existing === undefined) {
        target.children.set(value, child);
        this.#nodeCount += 1;
      } else {
        this.#mergeNode(existing, child);
      }
    }
  }

  /**
   * Re-run collapse decisions bottom-up, so a parent is judged against subtrees
   * that have already settled.
   */
  #reevaluate(node: TrieNode<T>): void {
    // Settle the literal children first, so this node is judged against
    // subtrees whose own shape has already stopped changing.
    for (const child of node.children.values()) {
      this.#reevaluate(child);
    }

    if (node.paramChild === undefined) {
      node.lastCheckedFanout = 0;
      this.#maybeCollapse(node);
    }

    /**
     * Deliberately re-read `paramChild` rather than using the value from
     * before: `#maybeCollapse` may have just created one, and the subtree it
     * merged together has never been examined. Missing that left three hundred
     * sections correctly collapsed to `/{param}/page/…` while the page-id slot
     * underneath stayed literal — 2,985 patterns of one URL each, because each
     * section had been too thin to decide on alone and the merged node was
     * never revisited.
     */
    if (node.paramChild !== undefined) {
      this.#absorbStrandedLiterals(node);
      this.#reevaluate(node.paramChild);
    }
  }

  /**
   * Fold literal children that turned out to belong in the variable branch.
   *
   * A node created shortly before a collapse has no subtree yet, fingerprints
   * as a leaf, and is left behind while its identical siblings are merged. The
   * symptom is a handful of stragglers like `/section-12/page/11490` sitting
   * next to a healthy `/{param}/page/{param}` — each holding one URL, and each
   * counted as its own pattern.
   *
   * By the time this runs the subtree is complete, so the fingerprint is
   * trustworthy and a straggler can be recognised and folded in.
   */
  #absorbStrandedLiterals(node: TrieNode<T>): void {
    const param = node.paramChild;

    if (param === undefined || node.children.size === 0) {
      return;
    }

    const paramSignature = this.#signature(param, SIGNATURE_DEPTH);

    for (const [value, child] of [...node.children]) {
      if (this.#signature(child, SIGNATURE_DEPTH) === paramSignature) {
        this.#mergeNode(param, child);
        node.children.delete(value);
      }
    }
  }

  #walk(
    node: TrieNode<T>,
    prefix: readonly string[],
    out: { template: string; terminal: T }[]
  ): void {
    if (node.terminal !== undefined) {
      out.push({
        template: prefix.length === 0 ? "/" : `/${prefix.join("/")}`,
        terminal: node.terminal
      });
    }

    for (const [value, child] of node.children) {
      this.#walk(child, [...prefix, value], out);
    }

    if (node.paramChild !== undefined) {
      this.#walk(node.paramChild, [...prefix, PARAM_SEGMENT], out);
    }
  }
}
