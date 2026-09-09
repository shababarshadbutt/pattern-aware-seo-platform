import { and, asc, eq, sql } from "drizzle-orm";

import { chunkRows } from "../chunk.js";
import { type Database, internalDatabase } from "../client.js";
import { sitemapFile } from "../schema/ingestion.js";
import type { SiteScope } from "../scope.js";

/**
 * `siteId, sitemapRunId, url, fileOrdinal, filename, isGzip` — one bind
 * parameter each. See `chunk.ts`.
 */
const COLUMNS_PER_ROW = 6;

/**
 * The per-file record that makes a run resumable.
 *
 * File granularity is the unit deliberately: a 90M-URL site is thousands of
 * files, so a crash costs one file's work rather than the run's. Every write
 * here is idempotent on `(run, url)` so a retried job cannot duplicate a file
 * and double-count its URLs.
 */

export type FileParseStatus =
  | "pending"
  | "downloading"
  | "parsing"
  | "parsed"
  | "failed"
  | "skipped";

export interface SitemapFileRow {
  readonly id: string;
  readonly siteId: string;
  readonly sitemapRunId: string;
  readonly url: string;
  readonly fileOrdinal: number;
  readonly filename: string | null;
  readonly parseStatus: FileParseStatus;
  readonly urlCount: number;
  readonly byteSize: number | null;
  readonly isGzip: boolean;
  readonly storageKey: string | null;
  readonly contentDigest: string | null;
  readonly parseError: string | null;
  readonly parsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const COLUMNS = {
  id: sitemapFile.id,
  siteId: sitemapFile.siteId,
  sitemapRunId: sitemapFile.sitemapRunId,
  url: sitemapFile.url,
  fileOrdinal: sitemapFile.fileOrdinal,
  filename: sitemapFile.filename,
  parseStatus: sitemapFile.parseStatus,
  urlCount: sitemapFile.urlCount,
  byteSize: sitemapFile.byteSize,
  isGzip: sitemapFile.isGzip,
  storageKey: sitemapFile.storageKey,
  contentDigest: sitemapFile.contentDigest,
  parseError: sitemapFile.parseError,
  parsedAt: sitemapFile.parsedAt,
  createdAt: sitemapFile.createdAt,
  updatedAt: sitemapFile.updatedAt
} as const;

export interface SitemapFileUpsert {
  readonly url: string;
  /** The integer that addresses this file's bytes. See the schema comment. */
  readonly fileOrdinal: number;
  readonly filename?: string | null;
  readonly isGzip?: boolean;
}

/**
 * Register the files a discovery pass found, ignoring ones already known.
 *
 * `DO NOTHING` rather than `DO UPDATE`: discovery re-running must not reset the
 * parse status of a file an earlier attempt already parsed, which is exactly
 * what would make a resumed run redo work it had finished.
 */
export async function upsertSitemapFiles(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  files: readonly SitemapFileUpsert[]
): Promise<readonly SitemapFileRow[]> {
  if (files.length === 0) {
    return [];
  }

  const values = files.map((file) => ({
    siteId: scope.siteId,
    sitemapRunId,
    url: file.url,
    fileOrdinal: file.fileOrdinal,
    filename: file.filename ?? null,
    isGzip: file.isGzip ?? false
  }));

  const conn = internalDatabase(db);

  // Each row is independently idempotent (`onConflictDoNothing` on its own
  // key), so unlike `upsertPatterns` these chunks need no shared transaction —
  // a crash mid-write just leaves some files registered and the rest to
  // register on retry, which is already how discovery is meant to resume.
  for (const chunk of chunkRows(values, COLUMNS_PER_ROW)) {
    await conn
      .insert(sitemapFile)
      .values(chunk)
      .onConflictDoNothing({
        target: [sitemapFile.siteId, sitemapFile.sitemapRunId, sitemapFile.url]
      });
  }

  return listSitemapFiles(db, scope, sitemapRunId);
}

/**
 * Every file in a run, in a stable order.
 *
 * `limit` is OPTIONAL AND UNSET BY DEFAULT on purpose. The pipeline's own
 * callers need the whole list — `finalize` counts failed files across the run,
 * and a capped read would silently judge a run on its first page — so the
 * default cannot be a number. A screen is the opposite case: a 90M-URL site is
 * thousands of files, and no reader needs them all in one response. So the cap
 * belongs to the caller that has a reason for one, and a truncated list is the
 * caller's to disclose (the run's own `total_files` counter is what it says
 * "showing n of N" against).
 */
export async function listSitemapFiles(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string,
  options: { readonly limit?: number } = {}
): Promise<readonly SitemapFileRow[]> {
  const query = internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapFile)
    .where(
      and(
        eq(sitemapFile.siteId, scope.siteId),
        eq(sitemapFile.sitemapRunId, sitemapRunId)
      )
    )
    .orderBy(asc(sitemapFile.fileOrdinal));

  return options.limit === undefined ? query : query.limit(options.limit);
}

/**
 * How many files a run has.
 *
 * Exists so a capped read of {@link listSitemapFiles} can be disclosed as
 * "n of N". Deliberately not served from `sitemap_run.total_files`: that is a
 * progress counter a stage writes, so it states what a run believes rather than
 * what the table holds, and the two disagreeing is a fact worth being able to
 * see rather than one to hide behind a single number.
 */
export async function countSitemapFiles(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<number> {
  const [row] = await internalDatabase(db)
    // Counted as bigint and coerced once here: node-postgres hands int8 back
    // as a string rather than guessing at precision.
    .select({ count: sql<string>`count(*)::bigint` })
    .from(sitemapFile)
    .where(
      and(
        eq(sitemapFile.siteId, scope.siteId),
        eq(sitemapFile.sitemapRunId, sitemapRunId)
      )
    );

  return Number(row?.count ?? 0);
}

/**
 * Record that a file's bytes are stored, with the digest of what was written.
 *
 * The digest is not a checksum for its own sake — it answers "has this site's
 * sitemap changed since last run?" without re-parsing, and it is the only way
 * to tell a genuinely shrunken sitemap from a truncated download.
 *
 * `isGzip`, when given, OVERWRITES whatever `upsertSitemapFiles` guessed from
 * the URL's suffix. A child file is only a named URL until this call — there
 * are no bytes to sniff before it — so the registration guess is exactly that,
 * a guess, and this is the first point a caller can correct it from what was
 * actually written to disk.
 */
export async function markFileDownloaded(
  db: Database,
  scope: SiteScope,
  fileId: string,
  stored: {
    readonly storageKey: string;
    readonly contentDigest: string;
    readonly byteSize: number;
    readonly isGzip?: boolean;
  }
): Promise<void> {
  await internalDatabase(db)
    .update(sitemapFile)
    .set({
      parseStatus: "pending",
      storageKey: stored.storageKey,
      contentDigest: stored.contentDigest,
      byteSize: stored.byteSize,
      ...(stored.isGzip === undefined ? {} : { isGzip: stored.isGzip }),
      updatedAt: sql`now()`
    })
    .where(
      and(eq(sitemapFile.siteId, scope.siteId), eq(sitemapFile.id, fileId))
    );
}

/** Move a file into a terminal or in-flight state. */
export async function setFileParseStatus(
  db: Database,
  scope: SiteScope,
  fileId: string,
  status: FileParseStatus,
  detail: {
    readonly urlCount?: number;
    readonly parseError?: string | null;
  } = {}
): Promise<void> {
  await internalDatabase(db)
    .update(sitemapFile)
    .set({
      parseStatus: status,
      ...(detail.urlCount === undefined ? {} : { urlCount: detail.urlCount }),
      // Cleared on success so a file that failed and later parsed does not keep
      // a stale reason that would read as a warning on a healthy run.
      parseError: status === "parsed" ? null : (detail.parseError ?? null),
      ...(status === "parsed" ? { parsedAt: sql`now()` } : {}),
      updatedAt: sql`now()`
    })
    .where(
      and(eq(sitemapFile.siteId, scope.siteId), eq(sitemapFile.id, fileId))
    );
}

/**
 * The next file a resumed run should parse, or undefined when none remain.
 *
 * Ordered so a resume is deterministic and a retried run does the same work in
 * the same order — which is what makes an interrupted run's output comparable
 * to an uninterrupted one.
 */
export async function nextUnparsedFile(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<SitemapFileRow | undefined> {
  const [row] = await internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapFile)
    .where(
      and(
        eq(sitemapFile.siteId, scope.siteId),
        eq(sitemapFile.sitemapRunId, sitemapRunId),
        eq(sitemapFile.parseStatus, "pending")
      )
    )
    .orderBy(asc(sitemapFile.fileOrdinal))
    .limit(1);

  return row;
}
