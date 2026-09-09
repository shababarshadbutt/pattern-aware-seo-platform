import { PageBody, TopBar } from "../../components/app-shell";
import { DefinitionGrid } from "../../components/definition-grid";
import { Estimate, estimateFromSnapshot } from "../../components/estimate";
import { Button, TextArea, TextInput } from "../../components/form";
import {
  LayersIcon,
  SitemapIcon,
  TargetIcon,
  TerminalIcon
} from "../../components/icons";
import { Panel } from "../../components/panel";
import { ToolSection } from "../../components/tool-card";
import { type HeroTile, ToolHero } from "../../components/tool-hero";
import {
  FilterPills,
  HeaderAction,
  SearchField,
  StatusStrip
} from "../../components/toolbar";
import {
  ApiError,
  extractPatterns,
  getSamplePlan,
  type PatternExtraction,
  type SamplePlanResult,
  TOOL_FORM_MAX_CHARACTERS
} from "../../lib/api";
import { formatCount } from "../../lib/format";
import { confidenceBandTone } from "../../lib/status";
import {
  countLaunchable,
  filterSections,
  TOOL_SECTIONS
} from "../../lib/tools-catalog";

/**
 * Calculators over the logic the pipeline runs, on the Stitch design's Tools
 * composition.
 *
 * WHAT MAKES THIS SCREEN LEGITIMATE is that it computes nothing of its own and
 * fetches nothing from anybody's site. ADR-0028 ruled Tools unbuildable because
 * "a screen for it would have to invent numbers", and that is still true of the
 * conventional SEO toolbox — there is no HTML parser here, no robots.txt fetch,
 * no link graph and no outbound HTTP from the API at all, so "give us a URL and
 * we will check it" is not on offer and must never be. What was wrong was the
 * assumption that leaves nothing: `packages/sampling` is forty tested, pure,
 * dependency-free exports that no screen could reach, and the extraction trie
 * is in the same position. Every figure below is a recomputation of those, on
 * input the reader typed. See ADR-0035.
 *
 * THE COMPOSITION IS NO LONGER PROVISIONAL. ADR-0035 borrowed the analysis
 * layout because no Stitch Tools screen was recorded anywhere and Stitch is
 * unreachable from this machine; the owner has since supplied the screen, and
 * this is transcribed from it (ADR-0036): a meta row, a title with header
 * actions, a search-and-category filter row, a featured hero panel holding the
 * loaded tool, then category sections of utility cards, then a status strip.
 *
 * AND THE DESIGN'S NINE TOOLS ARE NOT THIS PRODUCT'S TWO. That gap is the whole
 * design problem of this screen, and it is resolved the way ADR-0031 resolved
 * the Settings form and ADR-0032 resolved the run detail: keep the structure,
 * refuse the figures. The catalogue is data in `lib/tools-catalog.ts` so a test
 * can assert that every card which cannot run says which capability is missing,
 * and the design's own hero tool — a live single-URL inspector — appears as the
 * first card of the section explaining why this platform will never offer it.
 *
 * THE FORMS ARE PLAIN GET FORMS. Input lives in the URL, so a result is
 * linkable — which is what makes the below-floor case and the two zero-hit
 * cases teachable rather than something you have to reproduce by hand. That
 * also keeps the whole screen a Server Component; the Settings form is a Server
 * Action because it is a MUTATION needing saved/error state, and borrowing that
 * here would force a client component and destroy the linkability.
 */

export const dynamic = "force-dynamic";

type Tool = "extractor" | "planner";

interface ToolParams {
  readonly tool?: string;
  readonly urls?: string;
  readonly host?: string;
  readonly population?: string;
  readonly sampled?: string;
  readonly hits?: string;
  /** Catalogue filters. They never affect what the hero computes. */
  readonly q?: string;
  readonly category?: string;
}

/** A positive integer from a query param, or undefined. */
function intParam(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A link back to this screen that keeps everything the reader has already put
 * into it.
 *
 * Filtering the catalogue must not wipe the URLs pasted into the hero, and
 * loading a different tool must not reset the filter — both are in the same
 * querystring, so every link is built from the current params rather than from
 * scratch.
 */
function href(params: ToolParams, overrides: Record<string, string>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries({ ...params, ...overrides })) {
    if (typeof value === "string" && value !== "") {
      search.set(key, value);
    }
  }

  const query = search.toString();

  return query === "" ? "/tools" : `/tools?${query}`;
}

export default async function ToolsPage({
  searchParams
}: {
  readonly searchParams: Promise<ToolParams>;
}) {
  const params = await searchParams;
  const tool: Tool = params.tool === "planner" ? "planner" : "extractor";
  const category = params.category ?? "all";
  const sections = filterSections(category, params.q);

  return (
    <>
      <TopBar items={[{ label: "Tools" }]} />
      <PageBody>
        {/*
          The design's meta strip above the title. Its figures there are a suite
          version and a Puppeteer cluster's health; ours are the two facts a
          reader needs before trusting anything below — how many utilities can
          actually be run, and that none of them touch the network.
        */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs tracking-wider text-accent-text">
            SAMPLING SUITE
          </span>
          <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
            · {countLaunchable()} utilities available
          </span>
          <span className="font-mono text-2xs tracking-wider text-tertiary uppercase">
            · compute only — no outbound http
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Sampling Tools &amp; Utilities
            </h1>
            <p className="mt-2 max-w-prose text-sm text-secondary">
              On-demand calculators over the sampling engine, the pattern
              extractor and the configured budget. Nothing here contacts a
              website — every figure is the same calculation the pipeline
              performs, on input you supply.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <HeaderAction
              disabledReason="There is no job dispatch endpoint. The API is read-only apart from a single site update, and nothing in the UI can enqueue work — see ADR-0026."
              icon={LayersIcon}
              label="Batch execution"
            />
            <HeaderAction
              href="#api-endpoints"
              icon={TerminalIcon}
              label="API endpoints"
            />
          </div>
        </div>

        {/* The design's filter bar: a search field, then category pills. */}
        <form
          action="/tools"
          className="mt-5 flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-surface-raised p-2"
          method="get"
        >
          <SearchField
            defaultValue={params.q ?? ""}
            hidden={hiddenPairs(params, ["q", "category"])}
            label="Search utilities by name, capability or tag"
            name="q"
            placeholder="Search tools, protocols, or capabilities..."
          />
          <FilterPills
            items={[
              {
                label: "All utilities",
                href: href(params, { category: "" }),
                current: category === "all"
              },
              ...TOOL_SECTIONS.map((section) => ({
                label: section.title,
                href: href(params, { category: section.id }),
                current: category === section.id
              }))
            ]}
          />
        </form>

        {tool === "extractor" ? (
          <ExtractorTool params={params} />
        ) : (
          <PlannerTool params={params} />
        )}

        {sections.length === 0 ? (
          <Panel title="No utility matched">
            <p className="max-w-prose text-sm text-secondary">
              Nothing in the catalogue matches{" "}
              <span className="font-mono text-xs text-primary">{params.q}</span>
              . The filter is working; there are {TOOL_SECTIONS.length}{" "}
              categories and{" "}
              {TOOL_SECTIONS.reduce(
                (total, section) => total + section.tools.length,
                0
              )}{" "}
              utilities in total.
            </p>
          </Panel>
        ) : (
          sections.map((section) => (
            <ToolSection
              activeToolId={tool}
              key={section.id}
              section={section}
            />
          ))
        )}

        <div className="mt-8" id="api-endpoints">
          <Panel title="API endpoints">
            <p className="max-w-prose text-sm text-secondary">
              Both utilities are plain HTTP. The route registrar that serves
              them takes no database handle at all, which is what makes a POST
              safe on an otherwise read-only API — it cannot write, rather than
              being trusted not to.
            </p>
            <dl className="mt-4 flex flex-col gap-3">
              <EndpointRow
                description="Returns the sample the budget would draw, and — once you say what it found — the Wilson interval, the confidence band and the expansion plan."
                method="GET"
                path="/tools/sample-plan?population=&sampled=&hits="
              />
              <EndpointRow
                description="Collapses a body of URLs into templates with their populations and planned draws. Refuses rather than truncates past its cap, because every figure it returns is a function of the whole input."
                method="POST"
                path="/tools/pattern-extraction"
              />
            </dl>
          </Panel>
        </div>

        <StatusStrip
          actions={
            <a
              className="font-mono text-2xs tracking-wider text-accent-text uppercase hover:underline"
              href="/settings?tab=limits"
            >
              Policy limits
            </a>
          }
          facts={[
            "No outbound HTTP from the API",
            "No HTML parser, no headless browser, no link graph",
            "Every figure recomputes packages/sampling"
          ]}
        />
      </PageBody>
    </>
  );
}

/** Params a nested GET form has to carry so submitting it loses nothing. */
function hiddenPairs(
  params: ToolParams,
  omit: readonly string[]
): readonly (readonly [string, string])[] {
  return Object.entries(params).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" &&
      entry[1] !== "" &&
      !omit.includes(entry[0])
  );
}

function EndpointRow({
  method,
  path,
  description
}: {
  readonly method: string;
  readonly path: string;
  readonly description: string;
}) {
  return (
    <div className="rounded-sm border border-border-subtle bg-base px-3 py-3">
      <dt className="flex flex-wrap items-center gap-2">
        <span className="rounded-xs border border-border-subtle px-2 py-0.5 font-mono text-2xs tracking-wider text-accent-text">
          {method}
        </span>
        <span className="font-mono text-xs text-primary">{path}</span>
      </dt>
      <dd className="mt-2 max-w-prose text-2xs leading-relaxed text-tertiary">
        {description}
      </dd>
    </div>
  );
}

async function ExtractorTool({ params }: { readonly params: ToolParams }) {
  const urls = params.urls ?? "";
  const host = params.host?.trim() ?? "";

  let result: PatternExtraction | undefined;
  let failure: string | undefined;

  if (urls.trim() !== "") {
    try {
      result = await extractPatterns(urls, host === "" ? undefined : host);
    } catch (error) {
      failure =
        error instanceof ApiError
          ? error.message
          : "Unknown error contacting the API.";
    }
  }

  return (
    <>
      <ToolHero
        badge="PREFIX TRIE"
        description="Collapses pasted URLs into the patterns this platform would audit, and reports the population each one carries alongside the sample the min-heap would draw."
        icon={SitemapIcon}
        metaLabel="Computed by"
        metaValue="packages/sitemap"
        name="URL Pattern Extractor"
        tiles={result === undefined ? undefined : extractionTiles(result)}
        controls={
          <form action="/tools" method="get">
            <input name="tool" type="hidden" value="extractor" />
            {hiddenPairs(params, ["tool", "urls", "host"]).map(
              ([key, value]) => (
                <input key={key} name={key} type="hidden" value={value} />
              )
            )}
            <label
              className="block font-mono text-2xs font-medium tracking-wider text-tertiary uppercase"
              htmlFor="urls"
            >
              one URL per line
            </label>
            <div className="mt-2">
              <TextArea
                defaultValue={urls}
                id="urls"
                maxLength={TOOL_FORM_MAX_CHARACTERS}
                name="urls"
                placeholder={
                  "https://example.com/product/1\nhttps://example.com/product/2"
                }
                rows={8}
              />
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-tertiary">
              Up to {formatCount(TOOL_FORM_MAX_CHARACTERS)} characters, so the
              result stays in a shareable link. Full URLs or bare paths both
              work. Paste at least 30 URLs sharing a path position to see them
              collapse — below that the extraction rules deliberately refuse to
              parameterise anything, and the result will explain why.
            </p>

            {/* The design's hero control row: a wide input, then the action. */}
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <label
                  className="block font-mono text-2xs font-medium tracking-wider text-tertiary uppercase"
                  htmlFor="host"
                >
                  host
                </label>
                <div className="mt-2">
                  <TextInput
                    defaultValue={host}
                    id="host"
                    name="host"
                    placeholder="derived from the URLs"
                  />
                </div>
              </div>
              <Button type="submit" variant="primary">
                Extract patterns
              </Button>
            </div>
            <p className="mt-2 text-2xs leading-relaxed text-tertiary">
              Leave the host empty and it is taken from whichever appears most
              often, so one stray off-domain URL cannot make every other line
              foreign.
            </p>
          </form>
        }
      />

      {failure !== undefined && (
        <div className="mt-3">
          <Panel title="Could not extract">
            <p className="max-w-prose text-sm text-secondary">{failure}</p>
          </Panel>
        </div>
      )}

      {result !== undefined && <ExtractionResult result={result} />}
    </>
  );
}

function extractionTiles(result: PatternExtraction): readonly HeroTile[] {
  const { outcome, parameterisation } = result;

  return [
    {
      label: "urls analysed",
      value: formatCount(outcome.matched),
      title: "Lines that resolved to a URL on the chosen host."
    },
    {
      label: "patterns",
      value: formatCount(parameterisation.templatesTotal)
    },
    {
      label: "off-domain",
      value: formatCount(outcome.foreign),
      title:
        "URLs pointing at another host. Usually a botched migration where the old host was never rewritten — reported rather than dropped.",
      ...(outcome.foreign > 0 ? { tone: "warning" as const } : {})
    },
    {
      label: "unparseable",
      value: formatCount(outcome.unparseable),
      title: "Lines that were not usable URLs at all.",
      ...(outcome.unparseable > 0 ? { tone: "warning" as const } : {})
    }
  ];
}

function ExtractionResult({ result }: { readonly result: PatternExtraction }) {
  const { parameterisation } = result;

  return (
    <div className="mt-3 flex flex-col gap-3">
      <Panel title="How the host was chosen">
        <p className="max-w-prose text-sm text-secondary">
          {result.hostSource === "supplied" &&
            `Measured against ${result.host}, as you specified.`}
          {result.hostSource === "derived" &&
            `Measured against ${result.host}, which ${formatCount(result.hostBreakdown[0]?.count ?? 0)} of ${formatCount(result.input.analysed)} lines pointed at.`}
          {result.hostSource === "none" &&
            "Every line was a bare path, so nothing could be off-domain and no host was needed."}
        </p>
        {result.hostBreakdown.length > 1 && (
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Other hosts present:{" "}
            {result.hostBreakdown
              .slice(1)
              .map((entry) => `${entry.host} (${formatCount(entry.count)})`)
              .join(", ")}
          </p>
        )}
      </Panel>

      {/*
        THE STATE THIS TOOL IS MOST LIKELY TO BE MISREAD IN. Twelve URLs produce
        twelve templates and no {param} anywhere, which reads as a broken tool
        unless the screen says otherwise. Three distinct states, never one
        generic empty message.
      */}
      {parameterisation.belowFloor && (
        <Panel title="Below the parameterisation floor">
          <p className="max-w-prose text-sm text-secondary">
            You supplied {formatCount(parameterisation.observedUrls)} URLs.
            Parameterising a path position needs{" "}
            {formatCount(parameterisation.minObservedUrls)} observations through
            it, so every URL here is its own template.{" "}
            <strong className="text-primary">
              This is the extraction rules working, not the tool failing.
            </strong>
          </p>
          <p className="mt-3 max-w-prose text-sm text-secondary">
            About {formatCount(parameterisation.urlsShortOfFloor)} more URLs
            through one section would let the rule fire. The floor exists
            because the legacy engine used three, which merged 2,946 unrelated
            static pages into a single meaningless template while reporting a
            perfectly successful run.
          </p>
        </Panel>
      )}

      {!parameterisation.belowFloor &&
        parameterisation.templatesParameterised === 0 && (
          <Panel title="Above the floor, but nothing was variable enough">
            <p className="max-w-prose text-sm text-secondary">
              {formatCount(parameterisation.observedUrls)} URLs cleared the
              floor of {formatCount(parameterisation.minObservedUrls)}, but the
              rule is applied PER PATH POSITION rather than to the list as a
              whole — so URLs spread thinly across many sections leave every
              position below the threshold. A position parameterises once it has
              seen {formatCount(parameterisation.minObservedUrls)} URLs and at
              least {Math.round(parameterisation.uniqueRatioThreshold * 100)}%
              of the values it saw were distinct.
            </p>
          </Panel>
        )}

      <Panel title="Patterns">
        {result.patterns.length === 0 ? (
          <p className="text-sm text-secondary">
            Nothing resolved to the chosen host, so there is nothing to group.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <caption className="sr-only">
                Every pattern extracted from the supplied URLs, largest
                population first.
              </caption>
              <thead>
                <tr className="border-b border-border-strong">
                  {["template", "depth", "urls", "would probe"].map(
                    (heading, index) => (
                      <th
                        className={`px-3 py-2 font-mono text-2xs font-medium tracking-wider text-tertiary uppercase ${index > 1 ? "text-right" : ""}`}
                        key={heading}
                        scope="col"
                      >
                        {heading}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {result.patterns.map((pattern) => (
                  <tr
                    className="border-b border-border-subtle last:border-b-0 hover:bg-surface"
                    key={pattern.template}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-primary">
                      {pattern.template}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-secondary">
                      {pattern.segmentCount}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-mono text-xs tabular-nums"
                      data-numeric
                    >
                      {formatCount(pattern.populationCount)}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-mono text-xs tabular-nums text-secondary"
                      data-numeric
                      title="What the platform would request for a pattern this size, from the configured sample budget."
                    >
                      {formatCount(pattern.plannedSampleSize)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {(result.foreignSamples.length > 0 ||
        result.unparseableSamples.length > 0) && (
        <Panel title="Lines that did not count">
          {result.foreignSamples.length > 0 && (
            <>
              <p className="font-mono text-2xs tracking-wider text-tertiary uppercase">
                off-domain
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {result.foreignSamples.map((url) => (
                  <li className="font-mono text-xs text-secondary" key={url}>
                    {url}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.unparseableSamples.length > 0 && (
            <>
              <p className="mt-4 font-mono text-2xs tracking-wider text-tertiary uppercase">
                unparseable
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {result.unparseableSamples.map((line) => (
                  <li className="font-mono text-xs text-secondary" key={line}>
                    {line}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
    </div>
  );
}

async function PlannerTool({ params }: { readonly params: ToolParams }) {
  const population = intParam(params.population);
  const sampled = intParam(params.sampled);
  const hits = intParam(params.hits);

  let result: SamplePlanResult | undefined;
  let failure: string | undefined;

  if (population !== undefined && population > 0) {
    try {
      result = await getSamplePlan({
        population,
        ...(sampled === undefined ? {} : { sampled }),
        ...(hits === undefined ? {} : { hits })
      });
    } catch (error) {
      failure =
        error instanceof ApiError
          ? error.message
          : "Unknown error contacting the API.";
    }
  }

  return (
    <>
      <ToolHero
        badge="WILSON + FPC"
        description="What the platform would probe for a population of a given size, and what it would conclude from what came back — through the same composition that writes every published finding."
        icon={TargetIcon}
        metaLabel="Computed by"
        metaValue="packages/sampling"
        name="Sample & Confidence Planner"
        tiles={result === undefined ? undefined : plannerTiles(result)}
        controls={
          <form action="/tools" method="get">
            <input name="tool" type="hidden" value="planner" />
            {hiddenPairs(params, ["tool", "population", "sampled", "hits"]).map(
              ([key, value]) => (
                <input key={key} name={key} type="hidden" value={value} />
              )
            )}
            <div className="flex flex-wrap items-end gap-2">
              <PlannerField
                defaultValue={params.population ?? ""}
                grow
                label="population"
                name="population"
                placeholder="90000000"
              />
              <PlannerField
                defaultValue={params.sampled ?? ""}
                label="probed"
                name="sampled"
                placeholder="from the budget"
              />
              <PlannerField
                defaultValue={params.hits ?? ""}
                label="came back broken"
                name="hits"
                placeholder="0"
              />
              <Button type="submit" variant="primary">
                Compute
              </Button>
            </div>
            <p className="mt-3 max-w-prose text-2xs leading-relaxed text-tertiary">
              Leave PROBED empty to use the sample size the platform would draw.
              Leave CAME BACK BROKEN empty for the plan alone — zero is a real
              answer, and the interesting one.
            </p>
          </form>
        }
      />

      {failure !== undefined && (
        <div className="mt-3">
          <Panel title="Could not compute">
            <p className="max-w-prose text-sm text-secondary">{failure}</p>
          </Panel>
        </div>
      )}

      {result === undefined && failure === undefined && (
        <div className="mt-3">
          <Panel title="Two worth trying">
            <p className="max-w-prose text-sm text-secondary">
              The same zero findings produce different answers:{" "}
              <a
                className="text-accent-text hover:underline"
                href="/tools?tool=planner&population=3000&hits=0"
              >
                3,000 URLs with nothing found
              </a>{" "}
              is reported as low confidence, while{" "}
              <a
                className="text-accent-text hover:underline"
                href="/tools?tool=planner&population=40000&hits=0"
              >
                40,000 with nothing found
              </a>{" "}
              is confident. Thirty probes leave far more unaccounted for than
              four hundred do.
            </p>
          </Panel>
        </div>
      )}

      {result !== undefined && <PlanResult result={result} />}
    </>
  );
}

function PlannerField({
  name,
  label,
  defaultValue,
  placeholder,
  grow
}: {
  readonly name: string;
  readonly label: string;
  readonly defaultValue: string;
  readonly placeholder: string;
  readonly grow?: boolean;
}) {
  return (
    <div className={grow ? "min-w-[200px] flex-1" : "min-w-[150px]"}>
      <label
        className="block font-mono text-2xs font-medium tracking-wider text-tertiary uppercase"
        htmlFor={name}
      >
        {label}
      </label>
      <div className="mt-2">
        <TextInput
          defaultValue={defaultValue}
          id={name}
          inputMode="numeric"
          name={name}
          placeholder={placeholder}
        />
      </div>
    </div>
  );
}

/**
 * The hero's four result tiles.
 *
 * COUNTED FIGURES AND A BAND NAME, never the estimate itself. The point
 * estimate and its interval go through `<Estimate>` in the panel below, which
 * is the only module allowed to format them (ADR-0008, enforced by
 * `lib/adr-0008-guard.test.ts`); a tile cannot carry an interval, so it must
 * not carry the number that needs one.
 */
function plannerTiles(result: SamplePlanResult): readonly HeroTile[] {
  const tiles: HeroTile[] = [
    {
      label: "population",
      value: formatCount(result.plan.populationTotal)
    },
    {
      label: "would probe",
      value: formatCount(result.plan.sampleTotal),
      title: "The first-round sample size, from the budget the worker applies."
    },
    {
      label: "of the population",
      value: `${(result.plan.effectiveRate * 100).toFixed(
        result.plan.effectiveRate < 0.001 ? 4 : 2
      )}%`,
      title:
        "A small number here is the product working, not a shortfall — auditing a large site without requesting all of it is the entire design."
    }
  ];

  if (result.measurement !== undefined) {
    /*
      Said as a WORD and tinted, never tinted alone (DESIGN.md section 8) — and
      the tone comes from `lib/status.ts`, where `low` maps to `unknown`
      because a wide interval is missing evidence rather than bad news.
    */
    tiles.push({
      label: "confidence",
      value: result.measurement.confidenceBand,
      tone: confidenceBandTone(result.measurement.confidenceBand),
      title:
        "The band the interval's width falls into, relative to both the estimate and the population."
    });
  }

  return tiles;
}

function PlanResult({ result }: { readonly result: SamplePlanResult }) {
  const { measurement } = result;

  return (
    <div className="mt-3 flex flex-col gap-3">
      {measurement !== undefined && (
        <Panel title="What that sample would support">
          {/*
            THROUGH `<Estimate>`, WHICH IS THE ONLY MODULE ALLOWED TO FORMAT A
            SAMPLED FIGURE (ADR-0008, enforced by lib/adr-0008-guard.test.ts).
            This screen must never read pointEstimate, ciLow or ciHigh itself,
            not even for a tooltip.
          */}
          <div className="text-lg">
            <Estimate {...estimateFromSnapshot(measurement)} />
          </div>
          <p className="mt-3 max-w-prose text-sm text-secondary">
            {measurement.evidenceTier === "counted"
              ? "The sample covered the whole population, so this is a count rather than an estimate and carries no interval."
              : `Affected URLs across the population, at ${(measurement.confidenceLevel * 100).toFixed(0)}% confidence, with a finite-population correction applied.`}
          </p>
          {measurement.observedCount === 0 &&
            measurement.evidenceTier === "estimated" && (
              <p className="mt-3 max-w-prose text-sm text-secondary">
                Nothing was found in {formatCount(measurement.sampleSize)}{" "}
                probes — and the honest answer is still not zero. The legacy
                engine reported an interval of [0, 0] here, claiming certainty
                from a partial sample; that defect is the reason this platform
                computes an upper bound at all.
              </p>
            )}
        </Panel>
      )}

      <Panel title="The budget behind it">
        <DefinitionGrid
          items={[
            {
              label: "min sample",
              value: formatCount(result.budget.minSample),
              title: "Never probe fewer than this, however small the pattern."
            },
            {
              label: "max first round",
              value: formatCount(result.budget.maxFirstRound),
              title: "The ceiling on a first draw, however large the pattern."
            },
            {
              label: "sample rate",
              value: `${(result.budget.sampleRate * 100).toFixed(2)}%`
            },
            {
              label: "max expanded",
              value: formatCount(result.budget.maxExpanded),
              title:
                "The ceiling a second round could reach. Nothing in the pipeline performs an expansion yet."
            }
          ]}
        />
      </Panel>

      {result.expansion !== undefined && (
        <Panel title="Whether a second round would help">
          <p className="max-w-prose text-sm text-secondary">
            {result.expansion.shouldExpand
              ? `The interval is wide enough to be worth ${formatCount(result.expansion.additionalTotal)} more probes.`
              : "A second round would not change the answer materially."}{" "}
            <span className="font-mono text-xs text-tertiary">
              ({result.expansion.reason.replace(/_/g, " ")})
            </span>
          </p>
          {/*
            §1.9's shape if it were left out: `planExpansion` has no caller in
            the pipeline, so this describes what the budget implies rather than
            work that is scheduled. Saying "would" without saying "does not"
            would let a reader infer a behaviour the platform does not have.
          */}
          <p className="mt-3 max-w-prose text-xs text-tertiary">
            Advisory only — adaptive expansion is implemented and tested but no
            pipeline stage runs it today, so no sample is currently widened on
            the strength of this.
          </p>
        </Panel>
      )}
    </div>
  );
}
