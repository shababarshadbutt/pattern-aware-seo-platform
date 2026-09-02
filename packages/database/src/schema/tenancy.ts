import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { siteTierEnum } from "./enums.js";

/**
 * The tenant boundary.
 *
 * Only the internal team logs in today, so in practice there is one row here.
 * It exists from day one anyway because retrofitting a tenant boundary across
 * every partitioned table after 650 sites have data is the migration this whole
 * schema is shaped to avoid — and because "will external clients ever log in?"
 * was answered "internal now, external later" rather than "never". Row-level
 * security attaches to this column in M7, behind the same SiteScope token that
 * already gates every read.
 */
export const organization = pgTable(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => [uniqueIndex("uq_organization_slug").on(t.slug)]
);

/**
 * A monitored property — the entity the legacy engine has no equivalent of.
 *
 * The legacy schema's root is `session`: one ad-hoc migration run, with no
 * notion that the same site gets audited again next month. Everything the
 * product needs that the legacy tool cannot do — trends, regression detection,
 * a fleet view, per-pattern history to train on — follows from a site existing
 * independently of any one run. See ADR-0004.
 */
export const site = pgTable(
  "site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    /**
     * Stored rather than derived from `base_url` on every read because this is
     * the key the outbound rate limiter buckets on, and it is consulted on the
     * hot path for every probe.
     */
    host: text("host").notNull(),
    tier: siteTierEnum("tier").notNull().default("standard"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Per-site override of HTTP_PER_SITE_DAILY_REQUEST_CAP. Null means "use the
     * platform default", so raising the global figure lifts every site that has
     * not been deliberately pinned.
     */
    dailyRequestCap: integer("daily_request_cap"),
    /**
     * Floor on the gap between two requests to this host, in milliseconds. This
     * is where a `robots.txt` Crawl-delay or a contractual rate limit lands —
     * the open question the action plan tracks about the 650 target sites. Null
     * means the tier default applies.
     */
    minRequestIntervalMs: integer("min_request_interval_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (t) => [
    foreignKey({
      columns: [t.organizationId],
      foreignColumns: [organization.id],
      name: "fk_site_organization"
    }),
    /**
     * One site row per host per organization. Two rows for the same host would
     * each be granted the per-site daily budget, quietly doubling what the
     * target origin actually receives.
     *
     * Scoped to the organization rather than global so two tenants can
     * legitimately monitor the same domain later. The per-HOST rate limiter
     * (M4/M7) must therefore bucket across organizations, not per site row —
     * the unit being protected is one origin server, not one customer's view
     * of it.
     */
    uniqueIndex("uq_site_organization_host").on(t.organizationId, t.host),
    index("idx_site_organization_id").on(t.organizationId),
    // Fleet scheduling reads "which active sites are due?", so the partial index
    // matches the predicate rather than scanning soft-deleted and paused rows.
    index("idx_site_active_tier")
      .on(t.tier)
      .where(sql`${t.deletedAt} is null and ${t.isActive}`)
  ]
);
