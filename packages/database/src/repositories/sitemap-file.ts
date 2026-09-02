import { and, asc, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { sitemapFile } from "../schema/ingestion.js";
import type { SiteScope } from "../scope.js";

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

  await internalDatabase(db)
    .insert(sitemapFile)
    .values(
      files.map((file) => ({
        siteId: scope.siteId,
        sitemapRunId,
        url: file.url,
        fileOrdinal: file.fileOrdinal,
        filename: file.filename ?? null,
        isGzip: file.isGzip ?? false
      }))
    )
    .onConflictDoNothing({
      target: [sitemapFile.siteId, sitemapFile.sitemapRunId, sitemapFile.url]
    });

  return listSitemapFiles(db, scope, sitemapRunId);
}

/** Every file in a run, in a stable order. */
export async function listSitemapFiles(
  db: Database,
  scope: SiteScope,
  sitemapRunId: string
): Promise<readonly SitemapFileRow[]> {
  return internalDatabase(db)
    .select(COLUMNS)
    .from(sitemapFile)
    .where(
      and(
        eq(sitemapFile.siteId, scope.siteId),
        eq(sitemapFile.sitemapRunId, sitemapRunId)
      )
    )
    .orderBy(asc(sitemapFile.fileOrdinal));
}

/**
 * Record that a file's bytes are stored, with the digest of what was written.
 *
 * The digest is not a checksum for its own sake — it answers "has this site's
 * sitemap changed since last run?" without re-parsing, and it is the only way
 * to tell a genuinely shrunken sitemap from a truncated download.
 */
export async function markFileDownloaded(
  db: Database,
  scope: SiteScope,
  fileId: string,
  stored: {
    readonly storageKey: string;
    readonly contentDigest: string;
    readonly byteSize: number;
  }
): Promise<void> {
  await internalDatabase(db)
    .update(sitemapFile)
    .set({
      parseStatus: "pending",
      storageKey: stored.storageKey,
      contentDigest: stored.contentDigest,
      byteSize: stored.byteSize,
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
