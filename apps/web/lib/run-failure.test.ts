import { describe, expect, it } from "vitest";
import { describeRunFailure } from "./run-failure";

describe("describeRunFailure", () => {
  it("returns no detail for a run with no recorded reason", () => {
    const result = describeRunFailure(null);

    expect(result.detail).toBeNull();
  });

  it("explains the discover-stage EACCES/mkdir case in plain English", () => {
    const result = describeRunFailure(
      "STAGE_EXHAUSTED_RETRIES:DISCOVER:EACCES: permission denied, mkdir '.sitemaps'"
    );

    expect(result.summary).toContain("discovering the site's sitemaps");
    expect(result.summary).toContain("didn't have permission to write");
    expect(result.summary).toContain(
      "not a problem with the site being audited"
    );
    expect(result.detail).toBe(
      "STAGE_EXHAUSTED_RETRIES:DISCOVER:EACCES: permission denied, mkdir '.sitemaps'"
    );
  });

  it("names a network cause for an unreachable target host", () => {
    const result = describeRunFailure(
      "STAGE_EXHAUSTED_RETRIES:VERIFY:ETIMEDOUT: connect ETIMEDOUT 203.0.113.1:443"
    );

    expect(result.summary).toContain("verifying sampled URLs");
    expect(result.summary).toContain("did not respond in time");
  });

  it("falls back to a generic message for an unrecognized reason, keeping the raw string", () => {
    const raw =
      "STAGE_EXHAUSTED_RETRIES:INGEST:some future error nobody mapped yet";
    const result = describeRunFailure(raw);

    expect(result.summary).toContain("streaming and parsing sitemap files");
    expect(result.summary).toContain("See the technical detail below");
    expect(result.detail).toBe(raw);
  });

  it("falls back to a fully generic message for a reason outside the known shape", () => {
    const result = describeRunFailure("something unrelated entirely");

    expect(result.summary).toBe(
      "This run failed unexpectedly. See the technical detail below."
    );
    expect(result.detail).toBe("something unrelated entirely");
  });
});
