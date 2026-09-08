import { and, eq, sql } from "drizzle-orm";

import { type Database, internalDatabase } from "../client.js";
import { sitemapFile } from "../schema/ingestion.js";
import { patternPopulation } from "../schema/pattern.js";
import type { SiteScope } from "../scope.js";

/**
 * Which files hold a pattern's URLs, and how many each holds.
 *
 * This is the index the legacy engine did not have, and its absence is what
 * forced a full re-read of every `<loc>` of every file whenever a pattern's
 * sample needed resolving. With it, resolving a twelve-URL sample means opening
 * the two or three files those URLs actually live in.
 *
 * Counts, never URLs. A pattern with 40 million URLs has one row per file here,
 * not 40 million rows anywhere.
 */

export interface PatternPopulationRow {
  readonly id: string;
  readonly siteId: string;
  readonly patternId: string;
  readonly sitemapFileId: string;
  readonly urlCount: number;
}

const COLUMNS = {
  id: patternPopulation.id,
  siteId: patternPopulation.siteId,
  patternId: patternPopulation.patternId,
  sitemapFileId: patternPopulation.sitemapFileId,
  urlCount: patternPopulation.urlCount
} as const;

export interface PatternPopulationUpsert {
  readonly patternId: string;
  readonly sitemapFileId: string;
  readonly urlCount: number;
}

/**
 * Record per-file counts for a parsed file.
 *
 * `DO UPDATE` on the count rather than `DO NOTHING`, because a re-parse of the
 * same file is a correction, not a duplicate: the row must end up holding what
 * the latest parse of that file actually saw. Idempotent by construction, so a
 * retried parse job converges instead of accumulating.
 *
 * Rows with a zero count are dropped rather than written — the table has a
 * `url_count > 0` CHECK, and "this pattern does not appear in this file" is
 * expressed by the absence of a row.
 */
export async function upsertPatternPopulations(
  db: Database,
  scope: SiteScope,
  populations: readonly PatternPopulationUpsert[]
): Promise<number> {
  const rows = populations.filter((population) => population.urlCount > 0);

  if (rows.length === 0) {
    return 0;
  }

  await internalDatabase(db)
    .insert(patternPopulation)
    .values(
      rows.map((population) => ({
        siteId: scope.siteId,
        patternId: population.patternId,
        sitemapFileId: population.sitemapFileId,
        urlCount: population.urlCount
      }))
    )
    .onConflictDoUpdate({
      target: [
        patternPopulation.siteId,
        patternPopulation.patternId,
        patternPopulation.sitemapFileId
      ],
      set: {
        urlCount: sql`excluded.url_count`,
        updatedAt: sql`now()`
      }
    });

  return rows.length;
}

/**
 * One file's contribution to a pattern, named rather than referenced.
 *
 * The population row holds a `sitemap_file_id` and nothing a reader could act
 * on. Which file a pattern's URLs concentrate in is the point of the table —
 * both for resolution and for anyone asking why a pattern's sample keeps
 * landing in one place — so the file's URL and ordinal travel with the count.
 */
export interface PatternFileRow extends PatternPopulationRow {
  readonly fileUrl: string;
  readonly filename: string | null;
  readonly fileOrdinal: number;
}

/**
 * The files a pattern's URLs live in, largest contributor first.
 *
 * Ordered by count because resolution reads files in this order: the file
 * holding most of a pattern's population is the one most of its sample will be
 * drawn from, so it is usually the only file that has to be opened.
 */
export async function listPatternFiles(
  db: Database,
  scope: SiteScope,
  patternId: string
): Promise<readonly PatternFileRow[]> {
  return (
    internalDatabase(db)
      .select({
        ...COLUMNS,
        fileUrl: sitemapFile.url,
        filename: sitemapFile.filename,
        fileOrdinal: sitemapFile.fileOrdinal
      })
      .from(patternPopulation)
      /**
       * Joined on BOTH key columns, not just the file id.
       *
       * `sitemap_file` is partitioned by `site_id` with a composite primary key
       * (ADR-0010); pairing the site id is what keeps the join inside one
       * partition, and it is the pairing the post-M3 hardening pass added FKs
       * for after finding a row could reference another site's parent.
       */
      .innerJoin(
        sitemapFile,
        and(
          eq(sitemapFile.siteId, patternPopulation.siteId),
          eq(sitemapFile.id, patternPopulation.sitemapFileId)
        )
      )
      .where(
        and(
          eq(patternPopulation.siteId, scope.siteId),
          eq(patternPopulation.patternId, patternId)
        )
      )
      .orderBy(sql`${patternPopulation.urlCount} desc`)
  );
}

/**
 * A pattern's population summed across files.
 *
 * The authoritative N for an estimate. Summed from the per-file rows rather
 * than read from `pattern.population_count` so the two can be compared — a
 * disagreement means a file was parsed twice or not at all, which is worth
 * knowing about rather than papering over.
 */
export async function sumPatternPopulation(
  db: Database,
  scope: SiteScope,
  patternId: string
): Promise<number> {
  const [row] = await internalDatabase(db)
    .select({
      // Typed as a string because that is what node-postgres returns for
      // bigint: the value can exceed a JS safe integer, so the driver refuses
      // to guess. Coerced once, here, rather than trusted as a number.
      total: sql<string>`coalesce(sum(${patternPopulation.urlCount}), 0)::bigint`
    })
    .from(patternPopulation)
    .where(
      and(
        eq(patternPopulation.siteId, scope.siteId),
        eq(patternPopulation.patternId, patternId)
      )
    );

  return Number(row?.total ?? 0);
}
