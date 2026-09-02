import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Where a run's sitemap files live between pipeline stages.
 *
 * A contract rather than a path, because the stages are separate jobs: the
 * worker that downloads a file is not necessarily the worker that parses it,
 * and is very unlikely to be the one that resolves a sample candidate out of it
 * days later. Local disk is correct for development and a single worker; S3 is
 * correct on ECS. Neither belongs in a stage's own code, so stages take this
 * interface and never learn which one they got.
 */

/** Identifies one stored file. Scoped by run, since file ids are run-local. */
export interface StoredFileKey {
  readonly runId: string;
  /**
   * The small integer the parser packs into sample candidates, NOT the
   * `sitemap_file` UUID — see `SitemapFileSource.fileId`. Storage is keyed the
   * same way so a candidate can be traced to its bytes without a second lookup.
   */
  readonly fileId: number;
}

export interface StoredFile {
  readonly key: StoredFileKey;
  readonly bytes: number;
  /**
   * SHA-256 of the stored bytes.
   *
   * THIS IS LOAD-BEARING, not bookkeeping. A sample candidate is a
   * `(hash, fileId, ordinal)` triple, so recovering its URL means re-reading
   * this file and counting to that ordinal. If the bytes changed in between —
   * the site regenerated its sitemap, which large sites do nightly — ordinal
   * 4,271 is now a different URL, and verification would probe the wrong page
   * and report the result against the right one. Nothing about that failure
   * looks like a failure. The digest is what makes it detectable, so it is
   * recorded at write time and checked at every resolution.
   */
  readonly digest: string;
  /** Opaque locator for the backing store, recorded so a read need not guess. */
  readonly storageKey: string;
}

export interface SitemapFileStore {
  /** Store a file's bytes, returning its size and digest. */
  put(key: StoredFileKey, source: Readable): Promise<StoredFile>;
  /** Open stored bytes for reading. Throws {@link StoredFileMissingError}. */
  open(key: StoredFileKey): Promise<Readable>;
  /** Size and locator, or undefined when nothing is stored. */
  stat(key: StoredFileKey): Promise<Omit<StoredFile, "digest"> | undefined>;
  /** Remove one run's files. Called when a run is discarded, not per file. */
  removeRun(runId: string): Promise<void>;
}

/** Thrown when a stage asks for bytes that are not there. */
export class StoredFileMissingError extends Error {
  public override readonly name = "StoredFileMissingError";
}

/**
 * Local-filesystem store: `<root>/<runId>/<fileId>`.
 *
 * Writes to a temporary sibling and renames into place, so a process killed
 * mid-download leaves nothing rather than a truncated file. Truncation is the
 * dangerous outcome: a short sitemap still parses, so it would be read as a
 * legitimately smaller population and every count downstream would be quietly
 * wrong. Rename on the same filesystem is atomic, which turns that into a
 * missing file instead — which every stage already handles.
 */
export class LocalDiskFileStore implements SitemapFileStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  public async put(key: StoredFileKey, source: Readable): Promise<StoredFile> {
    const target = this.#pathFor(key);
    const temporary = `${target}.partial`;

    await mkdir(dirname(target), { recursive: true });

    const hash = createHash("sha256");
    let bytes = 0;

    /**
     * Hashed INSIDE the pipeline, not from a `data` listener on the source.
     *
     * Attaching `data` puts the stream into flowing mode immediately, so bytes
     * can be emitted and lost before `pipeline` attaches its own consumer — a
     * short file with a digest computed over different bytes than were written.
     * A transform sees exactly what reaches the disk, by construction.
     */
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        hash.update(chunk);
        bytes += chunk.byteLength;

        callback(null, chunk);
      }
    });

    try {
      await pipeline(source, measure, createWriteStream(temporary));
      await rename(temporary, target);
    } catch (error) {
      // Leave nothing behind for a later stage to mistake for a complete file.
      await rm(temporary, { force: true });

      throw error;
    }

    return {
      key,
      bytes,
      digest: hash.digest("hex"),
      storageKey: target
    };
  }

  public async open(key: StoredFileKey): Promise<Readable> {
    const path = this.#pathFor(key);

    if ((await this.stat(key)) === undefined) {
      throw new StoredFileMissingError(
        `no stored sitemap file for run ${key.runId} file ${key.fileId} at ${path}`
      );
    }

    return createReadStream(path);
  }

  public async stat(
    key: StoredFileKey
  ): Promise<Omit<StoredFile, "digest"> | undefined> {
    const path = this.#pathFor(key);

    try {
      const stats = await stat(path);

      return { key, bytes: stats.size, storageKey: path };
    } catch {
      return undefined;
    }
  }

  public async removeRun(runId: string): Promise<void> {
    await rm(join(this.#root, runId), { recursive: true, force: true });
  }

  #pathFor(key: StoredFileKey): string {
    // fileId is an integer from the parser, never user input, but it lands in a
    // path — so it is formatted, not interpolated, and a non-integer is a bug
    // worth failing on rather than writing to a surprising filename.
    if (!Number.isInteger(key.fileId) || key.fileId < 0) {
      throw new TypeError(
        `fileId must be a non-negative integer; got ${key.fileId}`
      );
    }

    return join(this.#root, key.runId, `${key.fileId}`);
  }
}
