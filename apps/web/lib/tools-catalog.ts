import type { ReactNode } from "react";

import {
  BranchIcon,
  CodeIcon,
  ExpandIcon,
  GaugeIcon,
  GlobeIcon,
  RobotIcon,
  ScaleIcon,
  SitemapIcon,
  TargetIcon
} from "../components/icons";

/**
 * The utility catalogue the Tools screen renders as the Stitch design's card
 * grid.
 *
 * WHY THIS IS DATA AND NOT MARKUP. The design ships nine cards in three
 * sections of three, and this platform has two working utilities. The
 * temptation a screen file invites is to write nine cards and let the seven
 * that cannot exist read as though they might — a status pill saying
 * "Operational" over a tool that would need a headless browser we do not have.
 * Holding the catalogue as data lets a test assert the rule instead: every
 * entry that is not launchable must state, in words, the missing capability
 * that makes it impossible here, and every entry that IS launchable must name
 * a route that exists. See `tools-catalog.test.ts`.
 *
 * THE COMPOSITION IS THE DESIGN'S; THE TOOLS ARE THIS PRODUCT'S. That is the
 * rule ADR-0031 set for a Stitch form whose fields outrun the product and
 * ADR-0032 scaled to a whole screen. It applies at its sharpest here, because
 * the design's Tools screen leads with an "Instant Single URL Live Inspector"
 * and this API makes no outbound HTTP request at all — there is no HTML
 * parser, no robots.txt fetch, no redirect follower and no browser anywhere in
 * the process. "Give us a URL and we will check it" is the one thing this
 * screen must never offer, so it appears as the first card of a section whose
 * own heading says why every card in it is dark.
 */

/**
 * Three states, not two.
 *
 * `advisory` exists because the expansion planner is a real, tested
 * computation that no pipeline stage runs — calling it `operational` would
 * promise that acting on it changes what the platform samples, and calling it
 * `unavailable` would hide a calculator that genuinely answers the question.
 */
export type ToolAvailability = "operational" | "advisory" | "unavailable";

export interface CatalogTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The design's chip row under the description. */
  readonly tags: readonly string[];
  readonly icon: (props: {
    readonly className?: string | undefined;
  }) => ReactNode;
  readonly availability: ToolAvailability;
  /** The card footer's left-hand meta — where the computation comes from. */
  readonly provenance: string;
  /** Present exactly when the tool can be launched. */
  readonly href?: string;
  /** Present exactly when it cannot: the capability this platform lacks. */
  readonly unavailableReason?: string;
}

export interface CatalogSection {
  /** Also the `?category=` value that filters to this section. */
  readonly id: string;
  readonly title: string;
  /** The design's right-aligned small-caps section label. */
  readonly label: string;
  readonly tools: readonly CatalogTool[];
}

export const TOOL_SECTIONS: readonly CatalogSection[] = [
  {
    id: "sampling",
    title: "Sampling & Confidence",
    label: "SAMPLE SIZE & INTERVALS",
    tools: [
      {
        id: "planner",
        name: "Sample & Confidence Planner",
        description:
          "How many URLs the platform would probe for a population of a given size, and what interval the result supports — Wilson score with a finite-population correction.",
        tags: ["Wilson + FPC", "Min-heap draw", "Budget from config"],
        icon: TargetIcon,
        availability: "operational",
        provenance: "packages/sampling",
        href: "/tools?tool=planner"
      },
      {
        id: "expansion",
        name: "Adaptive Expansion Planner",
        description:
          "Whether a second sampling round would narrow the interval enough to be worth the requests, and how many more probes it would cost.",
        tags: ["planExpansionFor", "Advisory only"],
        icon: ExpandIcon,
        availability: "advisory",
        provenance: "no pipeline stage runs it",
        href: "/tools?tool=planner&population=3000&hits=0"
      },
      {
        id: "budget",
        name: "Sample Budget & Policy Inspector",
        description:
          "The configured operational limits, each marked with whether any code path actually applies it. Twelve of the twenty-three are applied by nothing.",
        tags: ["POLICY_LIMITS", "Enforcement guard"],
        icon: GaugeIcon,
        availability: "operational",
        provenance: "apps/api policy manifest",
        href: "/settings?tab=limits"
      }
    ]
  },
  {
    id: "patterns",
    title: "Patterns & Structure",
    label: "URL COLLAPSE & POPULATIONS",
    tools: [
      {
        id: "extractor",
        name: "URL Pattern Extractor",
        description:
          "Collapses pasted URLs into the templates this platform would audit, using the same prefix trie a real sitemap pass runs, and reports the population and draw for each.",
        tags: ["Prefix trie", "ADR-0012", "Population counts"],
        icon: SitemapIcon,
        availability: "operational",
        provenance: "packages/sitemap",
        href: "/tools?tool=extractor"
      },
      {
        id: "sitemap-validator",
        name: "Sitemap XML & Index Validator",
        description:
          "Parse a sitemap or sitemap index and report malformed entries, nested index depth, and files that yield no URLs at all.",
        tags: ["XML 1.0", "GZIP stream"],
        icon: CodeIcon,
        availability: "unavailable",
        provenance: "parser is ingest-stage only",
        unavailableReason:
          "The streaming SAX parser exists, but the ingest stage drives it against a fetched file. There is no upload endpoint and the API makes no outbound request, so there is nothing here for it to read."
      },
      {
        id: "impact",
        name: "Impact Score Calculator",
        description:
          "What a given finding volume and severity class works out to as an impact score, and where it would rank against a site's other findings.",
        tags: ["severityFor", "ADR-0014"],
        icon: ScaleIcon,
        availability: "unavailable",
        provenance: "computed in the pipeline only",
        unavailableReason:
          "The severity table and the scoring function are real and tested, but they run inside the estimate stage and no route computes one on demand. This is a missing route rather than a missing capability."
      }
    ]
  },
  {
    id: "live",
    title: "Live Site Inspection",
    label: "NOT AVAILABLE — NO OUTBOUND HTTP",
    tools: [
      {
        id: "url-inspector",
        name: "Instant Single URL Live Inspector",
        description:
          "Fetch one URL and report its status, canonical, index directives and render timing without running a full audit.",
        tags: ["Live fetch", "Index directives"],
        icon: GlobeIcon,
        availability: "unavailable",
        provenance: "the design's hero tool",
        unavailableReason:
          "This API issues no outbound HTTP at all. Verification runs in the worker, under a rate limiter and a circuit breaker, against a sample the pipeline planned — an on-demand fetch from a web request would bypass both, which is the behaviour those two exist to prevent."
      },
      {
        id: "robots",
        name: "Robots.txt Tester & Sandbox",
        description:
          "Simulate crawler behaviour against custom disallow rules and wildcards before deploying them.",
        tags: ["Googlebot RFC", "Regex match"],
        icon: RobotIcon,
        availability: "unavailable",
        provenance: "robots.txt is never fetched",
        unavailableReason:
          "Nothing in this platform reads robots.txt — not the sampler, not the verifier. There is no rule parser to test against and no fetch to test with."
      },
      {
        id: "render",
        name: "Headless DOM & Render Comparison",
        description:
          "Diff server-rendered HTML against the client-rendered DOM to find content that only exists once JavaScript has run.",
        tags: ["Headless browser", "DOM diff"],
        icon: BranchIcon,
        availability: "unavailable",
        provenance: "no browser, no HTML parser",
        unavailableReason:
          "There is no headless browser here and nothing parses HTML. The verifier reads a capped byte prefix of a response purely to match soft-404 phrases, then discards it."
      }
    ]
  }
];

export const ALL_TOOLS: readonly CatalogTool[] = TOOL_SECTIONS.flatMap(
  (section) => section.tools
);

/** How many utilities the header's meta row may honestly claim. */
export function countLaunchable(): number {
  return ALL_TOOLS.filter((tool) => tool.availability !== "unavailable").length;
}

/**
 * Sections narrowed by the screen's category pills and search box.
 *
 * A section that loses every tool is dropped rather than rendered empty, and
 * an empty result is returned as an empty array so the screen can say "nothing
 * matched" in words — a silently empty grid is indistinguishable from a broken
 * filter, which is the section 1.5 failure in presentational form.
 */
export function filterSections(
  category: string | undefined,
  query: string | undefined
): readonly CatalogSection[] {
  const term = (query ?? "").trim().toLowerCase();

  return TOOL_SECTIONS.filter(
    (section) =>
      category === undefined || category === "all" || category === section.id
  )
    .map((section) => ({
      ...section,
      tools:
        term === ""
          ? section.tools
          : section.tools.filter((tool) => matches(tool, term))
    }))
    .filter((section) => section.tools.length > 0);
}

function matches(tool: CatalogTool, term: string): boolean {
  return [tool.name, tool.description, ...tool.tags]
    .join(" ")
    .toLowerCase()
    .includes(term);
}
