import { describe, expect, it } from "vitest";

import {
  InvalidQueueNameError,
  isPipelineStage,
  isSiteTier,
  PIPELINE_STAGES,
  parseQueueName,
  queueName,
  queueNamesForSite
} from "./queue-names.js";

const SITE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("queue namespacing", () => {
  it("names a queue by tier, site and stage", () => {
    expect(queueName({ tier: "standard", siteId: SITE, stage: "ingest" })).toBe(
      `standard:${SITE}:ingest`
    );
  });

  it("gives two sites disjoint queue names for every stage", () => {
    /**
     * The isolation guarantee, asserted rather than assumed. One shared queue
     * per stage is what lets a single 90-million-URL site's job flood sit in
     * front of every other site's work — and it would never show up in a test
     * with one site in it.
     */
    const mine = new Set(queueNamesForSite("bulk", SITE));
    const theirs = new Set(queueNamesForSite("priority", OTHER));

    expect(mine.size).toBe(PIPELINE_STAGES.length);

    for (const name of theirs) {
      expect(mine.has(name)).toBe(false);
    }
  });

  it("keeps the same site's tiers apart", () => {
    // Tier is part of the namespace, so re-tiering a site does not silently
    // leave its old jobs being consumed by a worker watching the new tier.
    expect(queueName({ tier: "bulk", siteId: SITE, stage: "verify" })).not.toBe(
      queueName({ tier: "priority", siteId: SITE, stage: "verify" })
    );
  });

  it("round-trips through parseQueueName", () => {
    for (const stage of PIPELINE_STAGES) {
      const name = queueName({ tier: "standard", siteId: SITE, stage });

      expect(parseQueueName(name)).toEqual({
        tier: "standard",
        siteId: SITE,
        stage
      });
    }
  });

  it("refuses a site id that is not a UUID", () => {
    /**
     * The name is also a Redis key prefix, and `:` is the separator. A site id
     * containing a colon would split into a different namespace than intended
     * — and two sites could then land in the same one, which is the single
     * failure this whole scheme exists to prevent.
     */
    for (const bad of ["standard:evil", "", "not-a-uuid", `${SITE}:extra`]) {
      expect(() =>
        queueName({ tier: "standard", siteId: bad, stage: "verify" })
      ).toThrow(InvalidQueueNameError);
    }
  });

  it("rejects a malformed queue name rather than guessing at it", () => {
    for (const bad of [
      "standard:ingest",
      `standard:${SITE}:not-a-stage`,
      `nosuchtier:${SITE}:ingest`,
      `standard:not-a-uuid:ingest`,
      `standard:${SITE}:ingest:extra`
    ]) {
      expect(() => parseQueueName(bad)).toThrow(InvalidQueueNameError);
    }
  });

  it("recognises exactly the stages and tiers it declares", () => {
    expect(isPipelineStage("ingest")).toBe(true);
    expect(isPipelineStage("nonsense")).toBe(false);
    expect(isSiteTier("bulk")).toBe(true);
    expect(isSiteTier("gold")).toBe(false);
  });

  it("orders the stages the way the pipeline actually runs", () => {
    // The order is the contract each stage's enqueue relies on; a reordering
    // here would silently mean a stage handing work backwards.
    expect([...PIPELINE_STAGES]).toEqual([
      "discover",
      "ingest",
      "verify",
      "estimate",
      "finalize"
    ]);
  });
});
