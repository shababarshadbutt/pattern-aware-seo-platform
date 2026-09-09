import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { sniffGzip } from "./gzip-sniff.js";

describe("sniffGzip", () => {
  it("recognises real gzip bytes", async () => {
    const compressed = gzipSync(Buffer.from("<urlset></urlset>"));

    await expect(sniffGzip(Readable.from(compressed))).resolves.toBe(true);
  });

  it("does not mistake plain XML for gzip", async () => {
    const plain = Buffer.from('<?xml version="1.0"?><urlset></urlset>', "utf8");

    await expect(sniffGzip(Readable.from(plain))).resolves.toBe(false);
  });

  it("is false, not a thrown error, on an empty stream", async () => {
    await expect(sniffGzip(Readable.from(Buffer.alloc(0)))).resolves.toBe(
      false
    );
  });

  /**
   * THE EXACT REGRESSION THIS FUNCTION EXISTS TO FIX, made concrete: the byte
   * on disk is the only thing that matters, regardless of what a server
   * claimed in a header that never reaches this function at all. `sniffGzip`
   * takes a stream of bytes, full stop — there is no `content-encoding`
   * parameter to get wrong.
   */
  it("has no header to trust or mistrust — only ever reads bytes", async () => {
    // A byte sequence that merely starts with plausible-looking bytes but is
    // not a real gzip stream. Detection is a magic-number check on the first
    // two bytes only, so this still reads true here — that is by design
    // (cheap, prefix-only) and is exactly why the caller in `ingest.ts` lets
    // the real `zlib` gunzip fail loudly on genuinely corrupt input rather
    // than trying to fully validate gzip-ness up front.
    const looksLikeGzip = Buffer.from([0x1f, 0x8b, 0x00, 0x00]);

    await expect(sniffGzip(Readable.from(looksLikeGzip))).resolves.toBe(true);
  });
});
