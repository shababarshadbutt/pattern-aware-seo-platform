import type { SiteScope } from "@pattern-aware/database";

import type { PipelineDeps } from "./deps.js";
import type { PipelineStage } from "./queue-names.js";
import { runDiscover } from "./stages/discover.js";
import { runEstimate } from "./stages/estimate.js";
import { runFinalize } from "./stages/finalize.js";
import { runIngest } from "./stages/ingest.js";
import { runVerify } from "./stages/verify.js";

/**
 * Dispatch one job to its stage.
 *
 * The single place that maps a stage name to a handler, so the worker does not
 * grow a switch statement that can silently fall through — an unknown stage
 * throws rather than being treated as a no-op success, which would leave a run
 * stalled forever with no failed job to show for it.
 */

export type StageResult =
  | Awaited<ReturnType<typeof runDiscover>>
  | Awaited<ReturnType<typeof runIngest>>
  | Awaited<ReturnType<typeof runVerify>>
  | Awaited<ReturnType<typeof runEstimate>>
  | Awaited<ReturnType<typeof runFinalize>>;

/** Thrown when a job arrives on a queue whose stage nothing implements. */
export class UnknownStageError extends Error {
  public override readonly name = "UnknownStageError";
}

export async function runStage(
  stage: PipelineStage,
  deps: PipelineDeps,
  scope: SiteScope,
  data: unknown
): Promise<StageResult> {
  switch (stage) {
    case "discover":
      return runDiscover(deps, scope, data);
    case "ingest":
      return runIngest(deps, scope, data);
    case "verify":
      return runVerify(deps, scope, data);
    case "estimate":
      return runEstimate(deps, scope, data);
    case "finalize":
      return runFinalize(deps, scope, data);
    default: {
      /**
       * Exhaustiveness, checked by the compiler. Adding a stage to
       * `PIPELINE_STAGES` without adding it here stops compiling, rather than
       * producing a queue that accepts jobs and does nothing with them.
       */
      const unreachable: never = stage;

      throw new UnknownStageError(
        `no handler for stage ${String(unreachable)}`
      );
    }
  }
}
