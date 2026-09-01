import { Transform, type TransformCallback } from "node:stream";

/**
 * Strip non-XML junk from the front of a sitemap before the parser sees it.
 *
 * Ported from the legacy engine, which learned this against real client files.
 * Sitemaps served by misconfigured hosts routinely arrive with a stray BOM, a
 * blank line, an HTML comment, or a PHP warning printed before the declaration.
 * A strict XML parser rejects the whole file, and the sitemap is then reported
 * as broken when its contents are perfectly fine — a false finding that costs
 * an investigation.
 *
 * Only the first {@link PREAMBLE_PEEK_BYTES} are inspected, and only once; after
 * that every chunk passes straight through, so this costs nothing on the
 * millions of bytes that follow.
 *
 * Recovery is deliberately conservative. Junk is dropped only when what remains
 * begins with something recognisably a sitemap. If it does not, the file is
 * genuinely not a sitemap and saying so is the correct outcome — quietly
 * hunting further into the body for an angle bracket would turn "this is an
 * HTML error page" into "this is an empty sitemap", which is much worse than a
 * parse failure.
 */
export const PREAMBLE_PEEK_BYTES = 500;

export const NON_XML_PREAMBLE_MESSAGE =
  "File contains non-XML preamble and could not be recovered";

/** Raised when the leading bytes cannot be recovered into a sitemap. */
export class NonRecoverablePreambleError extends Error {
  public override readonly name = "NonRecoverablePreambleError";

  public constructor() {
    super(NON_XML_PREAMBLE_MESSAGE);
  }
}

export function isNonRecoverablePreambleError(error: unknown): boolean {
  return error instanceof NonRecoverablePreambleError;
}

function normalizeXmlStart(value: string): string {
  return value.replace(/^[﻿\s]+/u, "").toLowerCase();
}

/** Does this look like the start of a sitemap or sitemap index? */
export function hasRecognizedSitemapStart(value: string): boolean {
  const normalized = normalizeXmlStart(value);

  return (
    normalized.startsWith("<?xml") ||
    normalized.startsWith("<urlset") ||
    normalized.startsWith("<sitemapindex")
  );
}

export class PreambleStrippingTransform extends Transform {
  public hadPreambleStripped = false;

  #buffer: Buffer = Buffer.alloc(0);
  #inspected = false;

  public override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this.#inspected) {
      callback(null, chunk);

      return;
    }

    const next = Buffer.concat([
      this.#buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    ]);

    // Wait until there is enough to judge; a tiny first chunk says nothing.
    if (next.length < PREAMBLE_PEEK_BYTES) {
      this.#buffer = next;
      callback();

      return;
    }

    this.#flushInitial(next, callback);
  }

  public override _flush(callback: TransformCallback): void {
    if (this.#inspected) {
      callback();

      return;
    }

    // A file shorter than the peek window still has to be judged.
    this.#flushInitial(this.#buffer, callback);
  }

  #flushInitial(buffer: Buffer, callback: TransformCallback): void {
    this.#inspected = true;

    try {
      const prepared = this.#prepare(buffer);

      if (prepared.length > 0) {
        this.push(prepared);
      }

      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #prepare(buffer: Buffer): Buffer {
    const peek = buffer.subarray(0, PREAMBLE_PEEK_BYTES);

    if (hasRecognizedSitemapStart(peek.toString("utf8"))) {
      return buffer;
    }

    const firstTag = peek.indexOf("<");

    if (firstTag === -1) {
      throw new NonRecoverablePreambleError();
    }

    if (firstTag === 0) {
      // Starts with a tag, just not one we recognise. Let the XML parser have
      // it and report whatever it finds — that error is more informative.
      return buffer;
    }

    const stripped = buffer.subarray(firstTag);

    if (
      !hasRecognizedSitemapStart(
        stripped.subarray(0, PREAMBLE_PEEK_BYTES).toString("utf8")
      )
    ) {
      throw new NonRecoverablePreambleError();
    }

    this.hadPreambleStripped = true;

    return stripped;
  }
}
