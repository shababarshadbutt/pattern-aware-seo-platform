import {
  DEFAULT_CONFIDENCE_THRESHOLDS,
  firstRoundSampleSize,
  measureProportion,
  planExpansionFor,
  planFirstRound
} from "@pattern-aware/sampling";
import type { PolicyConfig } from "@pattern-aware/shared";

import type { ApiInstance } from "../app.js";
import { ApiProblem } from "../errors.js";
import {
  errorResponse,
  patternExtractionBody,
  patternExtractionResponse,
  samplePlanQuery,
  samplePlanResponse,
  TOOL_MAX_URLS
} from "../schemas.js";
import { policySampleBudget } from "../tools/budget.js";
import { extractPatterns, linesOf } from "../tools/extract.js";

/**
 * Calculators over the logic the pipeline already runs.
 *
 * WHAT MAKES THESE HONEST is that they compute nothing of their own. The
 * sample plan goes through `measureProportion`, the same composition
 * `runEstimate` writes to `audit_snapshot` with; the extractor goes through
 * `LocObserver` and `PatternAccumulator`, the same objects a real sitemap pass
 * folds into. A tool that re-derived either would be a second source of truth,
 * correct on the day it was written and free to drift afterwards while looking
 * authoritative for calling the same underlying functions.
 *
 * THIS REGISTRAR TAKES NO `Database`, and that is the load-bearing part of
 * putting a POST on a read-only API. `POST /tools/pattern-extraction` computes
 * and returns; it cannot do otherwise, because the handler holds no handle to
 * write through. Non-mutating by construction rather than by convention — the
 * same argument shape as the opaque `Database` type itself, and directly
 * testable, which `tools-routes.test.ts` does with a database proxy that throws
 * on every property access.
 *
 * NOTHING HERE REACHES THE NETWORK EITHER. There is no HTML parser, no
 * robots.txt fetch and no outbound HTTP anywhere in this process, so no tool
 * can offer "give us a URL and we will check it". Every input is typed by the
 * caller and every output is a recomputation.
 *
 * ON CONFIGURED VERSUS DEFAULT VALUES — see `tools/budget.ts` for the rule.
 * The sample budget comes from config because the worker applies it; the
 * confidence thresholds come from the package default because nothing applies
 * the configured ones, which is why `measureProportion` accepts no thresholds
 * argument and why no file under `tools/` may name a `CONFIDENCE_*` key.
 */
export function registerToolRoutes(
  app: ApiInstance,
  config: PolicyConfig
): void {
  const budget = policySampleBudget(config);

  app.get(
    "/tools/sample-plan",
    {
      schema: {
        querystring: samplePlanQuery,
        response: { 200: samplePlanResponse, 400: errorResponse }
      }
    },
    (request) => {
      const { population } = request.query;

      /*
       * Clamped to the population: a caller asking to sample 500 of 100 is
       * describing a census, not an error, and `estimateStratified` would
       * reject `sampled > population` outright.
       */
      const sampled = Math.min(
        request.query.sampled ?? firstRoundSampleSize(population, budget),
        population
      );

      const plan = planFirstRound([{ label: "all", population }], budget);

      const { hits } = request.query;

      if (hits === undefined) {
        return {
          budget,
          plan: {
            populationTotal: plan.populationTotal,
            sampleTotal: plan.sampleTotal,
            effectiveRate: plan.effectiveRate
          },
          thresholds: DEFAULT_CONFIDENCE_THRESHOLDS,
          thresholdSource: "package-default" as const
        };
      }

      if (hits > sampled) {
        /*
         * Reachable even though the schema refines, because `sampled` may have
         * been CLAMPED above after passing that check. Caught here rather than
         * left to `estimateStratified`, whose `InvalidProportionError` is not a
         * shape this API maps.
         */
        throw ApiProblem.badRequest(
          "INVALID_PROPORTION",
          `hits (${hits}) cannot exceed the ${sampled} URLs a sample of that population can cover.`
        );
      }

      const observations = [{ label: "all", population, sampled, hits }];

      const measurement = measureProportion(observations);

      /*
       * FROM THE OBSERVATIONS, not from an estimate assembled here. An earlier
       * version built a `StratifiedEstimate` out of the `Measurement` and had
       * to invent `strata: []` for it, which made `planExpansion` answer
       * `already_precise` for a sample its own band called `low` — the screen
       * said a second round would not help, directly beneath an interval
       * spanning 11% of the population. Nothing failed; a screenshot caught it.
       * `planExpansionFor` exists so that construction is not available.
       *
       * WHAT THE PLATFORM *WOULD* DO, not what it does: `planExpansion` has no
       * caller in the pipeline — adaptive expansion is implemented, tested and
       * never run — so the screen presents this as the plan the budget implies
       * rather than as work that will happen.
       */
      const expansion = planExpansionFor(observations, sampled, { budget });

      return {
        budget,
        plan: {
          populationTotal: plan.populationTotal,
          sampleTotal: plan.sampleTotal,
          effectiveRate: plan.effectiveRate
        },
        measurement,
        expansion: {
          shouldExpand: expansion.shouldExpand,
          reason: expansion.reason,
          additionalTotal: expansion.additionalTotal
        },
        thresholds: DEFAULT_CONFIDENCE_THRESHOLDS,
        thresholdSource: "package-default" as const
      };
    }
  );

  app.post(
    "/tools/pattern-extraction",
    {
      schema: {
        body: patternExtractionBody,
        response: { 200: patternExtractionResponse, 400: errorResponse }
      }
    },
    (request) => {
      const { text } = request.body;
      const lineCount = linesOf(text).length;

      if (lineCount > TOOL_MAX_URLS) {
        /*
         * Rejected, not truncated. Every figure this route returns is a
         * function of the whole input — populations, the sample draw, and the
         * parameterisation decision above all — so a truncated answer would be
         * wrong about the input while looking like a partial one.
         */
        throw ApiProblem.badRequest(
          "TOO_MANY_URLS",
          `${lineCount} URLs exceeds the ${TOOL_MAX_URLS} this tool will analyse. Truncating would change every figure it returns, including whether the URLs parameterise at all, so the request is refused rather than partially answered.`
        );
      }

      return extractPatterns(
        text,
        budget,
        request.body.host === undefined ? undefined : request.body.host
      );
    }
  );
}
