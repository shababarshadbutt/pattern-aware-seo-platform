import type { Readable } from "node:stream";

const GZIP_MAGIC_BYTE_0 = 0x1f;
const GZIP_MAGIC_BYTE_1 = 0x8b;

/**
 * Whether a stream's first bytes are the gzip magic number.
 *
 * Reads the smallest possible prefix and destroys the stream once it has an
 * answer — this exists to settle one boolean question about bytes already on
 * disk, not to consume the file. A caller that goes on to parse the same
 * stored key re-opens it fresh.
 *
 * REPLACES TRUSTING A `content-encoding: gzip` RESPONSE HEADER. Undici's
 * `fetch` transparently decompresses a gzip body before a `SitemapResponse`'s
 * bytes are ever read, but leaves the header saying "gzip" on the response
 * object — so a server that compresses its XML on the wire (common; IIS and
 * nginx both do it without regard to the URL's extension) left the pipeline
 * writing `is_gzip: true` for bytes that were already plain XML, and the
 * later parse failed with `Z_DATA_ERROR: incorrect header check`. Sniffing
 * what was actually written is correct regardless of what any header claimed.
 */
export async function sniffGzip(source: Readable): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (result: boolean | Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      source.destroy();

      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };

    source.once("error", (error: Error) => {
      finish(error);
    });
    source.once("end", () => {
      finish(false);
    });
    source.on("data", (chunk: Buffer) => {
      finish(
        chunk.length >= 2 &&
          chunk[0] === GZIP_MAGIC_BYTE_0 &&
          chunk[1] === GZIP_MAGIC_BYTE_1
      );
    });
  });
}
