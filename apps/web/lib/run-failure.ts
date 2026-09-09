/**
 * Translates `sitemap_run.status_reason` — a precise, grep-able machine string
 * such as `STAGE_EXHAUSTED_RETRIES:DISCOVER:EACCES: permission denied, mkdir
 * '.sitemaps'` — into a sentence a reader who isn't debugging the worker can
 * act on, without discarding the original string.
 *
 * The raw value is never replaced, only translated alongside: `detail` always
 * carries exactly what the database holds, the same rule `lib/status.ts`'s
 * tone mappings and the run-state banners on `/projects` already follow —
 * a friendly label is never the only channel.
 */

export interface RunFailureDescription {
  readonly summary: string;
  readonly detail: string | null;
}

const STAGE_PHRASES: Record<string, string> = {
  DISCOVER: "while discovering the site's sitemaps",
  INGEST: "while streaming and parsing sitemap files",
  VERIFY: "while verifying sampled URLs over HTTP",
  ESTIMATE: "while computing confidence estimates",
  FINALIZE: "while finalizing the run's results"
};

/**
 * Node/OS error codes that can appear inside a `STAGE_EXHAUSTED_RETRIES`
 * message, mapped to a one-sentence cause. Distinguishes a deployment/
 * configuration defect (this platform's fault) from the target site's server
 * being unreachable (a fact about the site, not necessarily a defect here) —
 * the same distinction `packages/shared/src/errors.ts`'s `isExpected` draws
 * between a bug and something true about the world.
 */
const ERROR_CODE_CAUSES: Record<string, string> = {
  EACCES:
    "the worker didn't have permission to write to its local storage — a deployment/configuration issue, not a problem with the site being audited",
  ENOENT:
    "a required file or directory was missing — a deployment/configuration issue, not a problem with the site being audited",
  ECONNREFUSED: "the target site's server refused the connection",
  ENOTFOUND: "the target site's hostname could not be resolved",
  ETIMEDOUT: "the target site's server did not respond in time",
  ECONNRESET: "the connection to the target site's server was reset"
};

const EXHAUSTED_RETRIES_PATTERN = /^STAGE_EXHAUSTED_RETRIES:([A-Z]+):(.*)$/s;

function phraseForStage(stage: string): string {
  return STAGE_PHRASES[stage] ?? `during the ${stage.toLowerCase()} step`;
}

function causeForMessage(message: string): string | undefined {
  for (const [code, cause] of Object.entries(ERROR_CODE_CAUSES)) {
    if (message.includes(code)) {
      return cause;
    }
  }

  return undefined;
}

/**
 * `statusReason` is `null` for any run that isn't `failed`/`degraded` with an
 * explicit reason recorded — `summary` is `null` too in that case, since there
 * is nothing to explain.
 */
export function describeRunFailure(
  statusReason: string | null
): RunFailureDescription {
  if (statusReason === null) {
    return { summary: "", detail: null };
  }

  const match = EXHAUSTED_RETRIES_PATTERN.exec(statusReason);

  if (match === undefined || match === null) {
    return {
      summary: "This run failed unexpectedly. See the technical detail below.",
      detail: statusReason
    };
  }

  const [, stage, message] = match;
  const cause = causeForMessage(message ?? "");
  const stagePhrase = phraseForStage(stage ?? "");

  const summary =
    cause === undefined
      ? `This run failed ${stagePhrase}. See the technical detail below.`
      : `This run failed ${stagePhrase}: ${cause}.`;

  return { summary, detail: statusReason };
}
