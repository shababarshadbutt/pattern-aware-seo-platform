import { jobSiteScope } from "@pattern-aware/database";
import { describe, expect, it } from "vitest";
import { assertScopeMatchesPayload } from "./deps.js";
import {
  InvalidJobPayloadError,
  parsePayload,
  verifyPayloadSchema
} from "./payloads.js";

const SITE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const RUN = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PATTERN = "b7b3f3a2-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const SAMPLE = "c8c4f4b3-2d3e-4f60-9bac-1d2e3f4a5b6c";
const ORG = "d9d5f5c4-3e4f-4a71-8bcd-2e3f4a5b6c7d";

const scopeFor = (siteId: string) =>
  jobSiteScope({ organizationId: ORG, siteId });

function validVerifyPayload(): Record<string, unknown> {
  return {
    siteId: SITE,
    sitemapRunId: RUN,
    patternId: PATTERN,
    patternSampleId: SAMPLE,
    baseUrl: "https://shop.test",
    expectedHost: "shop.test",
    candidates: [{ hash: 12, fileId: 1, ordinal: 4 }],
    plannedSampleSize: 30,
    fileIds: [1]
  };
}

describe("job payloads", () => {
  it("accepts a well-formed payload", () => {
    expect(
      parsePayload(verifyPayloadSchema, "verify", validVerifyPayload())
    ).toMatchObject({ siteId: SITE, plannedSampleSize: 30 });
  });

  it("reports every problem at once, not the first", () => {
    /**
     * Same reasoning as the startup config schema: learning about four wrong
     * fields across four redeploys is the expensive way to find out there were
     * four.
     */
    let message = "";

    try {
      parsePayload(verifyPayloadSchema, "verify", {
        ...validVerifyPayload(),
        siteId: "nope",
        plannedSampleSize: -1,
        baseUrl: "not-a-url"
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain("siteId");
    expect(message).toContain("plannedSampleSize");
    expect(message).toContain("baseUrl");
  });

  it("refuses a payload with no candidates", () => {
    // An empty candidate list is not a small sample, it is no sample; the stage
    // would otherwise probe nothing and report a measured pattern.
    expect(() =>
      parsePayload(verifyPayloadSchema, "verify", {
        ...validVerifyPayload(),
        candidates: []
      })
    ).toThrow(InvalidJobPayloadError);
  });

  it("refuses a zero plannedSampleSize", () => {
    /**
     * The exact bad input M5's manual review pass found: zero disabled the
     * escalation cap and returned "measured" off sixty requests with no signal.
     * Rejected here as well as in `verifyPattern`, so a malformed job never
     * reaches the prober.
     */
    expect(() =>
      parsePayload(verifyPayloadSchema, "verify", {
        ...validVerifyPayload(),
        plannedSampleSize: 0
      })
    ).toThrow(InvalidJobPayloadError);
  });

  it("names the stage in the error, since one handler cannot tell another's payload", () => {
    expect(() =>
      parsePayload(verifyPayloadSchema, "verify", { siteId: SITE })
    ).toThrow(/stage "verify"/u);
  });
});

describe("scope and payload agreement", () => {
  it("passes when the queue's site and the payload's site agree", () => {
    expect(() =>
      assertScopeMatchesPayload(scopeFor(SITE), { siteId: SITE }, "verify")
    ).not.toThrow();
  });

  it("refuses to write across a tenant boundary", () => {
    /**
     * THE WORST AVAILABLE FAILURE in a multi-tenant system: a job enqueued into
     * the wrong site's lane would otherwise write one tenant's rows under
     * another tenant's id, and every row it wrote would look ordinary.
     */
    expect(() =>
      assertScopeMatchesPayload(scopeFor(SITE), { siteId: RUN }, "verify")
    ).toThrow(/refusing to write across a tenant boundary/u);
  });
});
