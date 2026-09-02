import { z } from "zod";

/**
 * Job payloads, validated at the boundary rather than trusted.
 *
 * A job payload is JSON that has been sitting in Redis, possibly since before
 * the last deploy. Treating it as a typed object because the enqueueing code
 * was typed is how a renamed field becomes `undefined` halfway through a stage,
 * three stages after the one that could have rejected it. Every handler parses
 * its own payload first, so a stale or malformed job fails immediately and
 * loudly instead of doing part of its work.
 */

const uuid = z.string().uuid();

/**
 * Shared by every stage.
 *
 * `siteId` is present even though the queue name already carries it: the queue
 * name is routing, and a handler that trusted routing for identity would write
 * one site's rows under another's id if a job were ever enqueued to the wrong
 * queue. Cross-checked in the handler.
 */
const runContext = z.object({
  siteId: uuid,
  sitemapRunId: uuid
});

export const discoverPayloadSchema = runContext.extend({
  /** The sitemap or sitemap-index URL to start from. */
  sitemapUrl: z.string().url()
});

export const ingestPayloadSchema = runContext.extend({
  /**
   * Site base URL, for resolving relative `<loc>` values, and the host every
   * URL is expected to be on. Carried on the job rather than re-read from the
   * site row so a run stays reproducible if the site's URL is later edited.
   */
  baseUrl: z.string().url(),
  expectedHost: z.string().min(1)
});

/** One candidate, as it travels between the sample draw and verification. */
export const sampleCandidateSchema = z.object({
  hash: z.number().int().nonnegative(),
  fileId: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative()
});

export const verifyPayloadSchema = runContext.extend({
  patternId: uuid,
  patternSampleId: uuid,
  baseUrl: z.string().url(),
  expectedHost: z.string().min(1),
  /**
   * The drawn candidates, carried on the job rather than re-read.
   *
   * Twelve bytes each in memory and a little more as JSON, so a 1,200-candidate
   * expansion is tens of kilobytes — acceptable per pattern, and it keeps the
   * draw and the probe from disagreeing about what was sampled if a
   * re-draw happens in between.
   */
  candidates: z.array(sampleCandidateSchema).min(1),
  /**
   * What the sample was PLANNED to be, which is what the escalation cap is
   * budgeted against (ADR-0015). Not `candidates.length`: verification may run
   * in chunks, and re-granting the budget per chunk is exactly the bug M5
   * closed.
   */
  plannedSampleSize: z.number().int().positive(),
  /** Which file each candidate's ordinals refer to, as a store key. */
  fileIds: z.array(z.number().int().nonnegative()).min(1)
});

export const estimatePayloadSchema = runContext.extend({
  patternId: uuid,
  patternSampleId: uuid
});

export const finalizePayloadSchema = runContext;

export type DiscoverPayload = z.infer<typeof discoverPayloadSchema>;
export type IngestPayload = z.infer<typeof ingestPayloadSchema>;
export type VerifyPayload = z.infer<typeof verifyPayloadSchema>;
export type EstimatePayload = z.infer<typeof estimatePayloadSchema>;
export type FinalizePayload = z.infer<typeof finalizePayloadSchema>;

/** Thrown when a job's payload is not the shape its handler requires. */
export class InvalidJobPayloadError extends Error {
  public override readonly name = "InvalidJobPayloadError";
}

/**
 * Parse a payload, reporting every problem at once.
 *
 * All issues rather than the first, for the same reason the startup config
 * schema does it: fixing one field at a time across four redeploys is the
 * expensive way to learn there were four wrong fields.
 */
export function parsePayload<T>(
  schema: z.ZodType<T>,
  stage: string,
  data: unknown
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new InvalidJobPayloadError(
      `invalid payload for stage "${stage}":\n${detail}`
    );
  }

  return result.data;
}
