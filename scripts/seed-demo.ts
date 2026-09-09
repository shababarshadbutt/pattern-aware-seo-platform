import { argv } from "node:process";

import {
  type AuditSnapshotInsert,
  appendSampleObservations,
  countExpandedPatterns,
  createDatabase,
  createOrganization,
  createSite,
  findOrganizationBySlug,
  finishRun,
  insertAuditSnapshot,
  listPatternsByPopulation,
  listSites,
  recordPatternSample,
  type SiteScope,
  setFileParseStatus,
  setPatternStatus,
  siteScopeWithin,
  startRun,
  summariseRunRequests,
  systemOrganizationScope,
  updateRunProgress,
  upsertPatternPopulations,
  upsertPatterns,
  upsertSamplingHealth,
  upsertSitemapFiles
} from "../packages/database/src/index.js";
import {
  classifyOutcome,
  confidenceBandFor,
  DEFAULT_CONFIDENCE_LEVEL,
  ESTIMATOR_VERSION,
  estimateStratified,
  firstRoundSampleSize,
  type ProbeOutcome,
  RATIFIED_SEVERITY_TABLE,
  type SeverityClass,
  severityFor,
  stableHash
} from "../packages/sampling/src/index.js";

/**
 * Seeds one realistic demo site so `apps/web`'s screens have real data to
 * render, end to end, without needing a real sitemap or real HTTP traffic.
 *
 * Every published number below is produced by the actual estimator
 * (`wilsonInterval` / `estimateStratified` / `classifyOutcome` / `severityFor`)
 * against synthetic sample_observation rows, not hand-typed — so every row
 * this writes satisfies the same CHECK constraints a real pipeline run would
 * have to satisfy. Where a scenario has no honest claim to publish (blocked,
 * needs_review), it deliberately writes no audit_snapshot row, matching how
 * the real pipeline treats those as absences of measurement rather than
 * measurements.
 *
 *   pnpm seed:demo
 */

const ORG_SLUG = "asapsemi-demo";
const WORKER_ID = "seed-demo-script";

/**
 * Population scales for each seeded run, oldest first.
 *
 * The last is 1 — the newest run is the plan at full size, so every figure
 * elsewhere in this file still describes what a reader sees on the latest
 * run.
 */
const RUN_GENERATIONS = [0.82, 0.91, 1] as const;

interface PatternPlan {
  readonly template: string;
  readonly segmentCount: number;
  readonly populationCount: number;
  readonly fileIndex: number; // which of the 3 demo files this pattern's URLs live in
  readonly kind: "census-healthy" | "measured" | "blocked" | "needs-review";
  /** Only for "measured": the finding this pattern's audit_snapshot is about. */
  readonly finding?: {
    readonly httpStatus: number;
    readonly outcome: ProbeOutcome;
    readonly hitRate: number; // target share of the draw matching `outcome`
    readonly escalates: boolean; // does matching this outcome require a GET?
  };
}

/**
 * One demo site.
 *
 * TWO of them, deliberately. The fleet screens — `/issues` and `/runs` — read
 * across every site in the organization, and with a single seeded site they
 * render a one-row table that looks identical to a broken cross-site query.
 * A second site is what makes the difference between "this works" and "this
 * cannot be distinguished from not working" visible on screen, the same
 * reasoning the cross-tenant tests use real rows rather than empty ones.
 */
interface SitePlan {
  readonly name: string;
  readonly baseUrl: string;
  readonly tier: "standard" | "priority" | "bulk";
  readonly patterns: readonly PatternPlan[];
}

const SKYLINE_PATTERNS: readonly PatternPlan[] = [
  {
    template: "/company/{page}",
    segmentCount: 2,
    populationCount: 18,
    fileIndex: 2,
    kind: "census-healthy"
  },
  {
    template: "/parts/{sku}/discontinued",
    segmentCount: 3,
    populationCount: 6200,
    fileIndex: 0,
    kind: "measured",
    finding: {
      httpStatus: 404,
      outcome: { httpStatus: 404 },
      hitRate: 0.9,
      escalates: true
    }
  },
  {
    template: "/category/{slug}",
    segmentCount: 2,
    populationCount: 940,
    fileIndex: 1,
    kind: "measured",
    finding: {
      httpStatus: 200,
      outcome: { httpStatus: 200, isSoft404: true },
      hitRate: 0.55,
      escalates: true
    }
  },
  {
    template: "/api/legacy/{id}",
    segmentCount: 3,
    populationCount: 3100,
    fileIndex: 2,
    kind: "measured",
    finding: {
      httpStatus: 500,
      outcome: { httpStatus: 500 },
      hitRate: 0.12,
      escalates: true
    }
  },
  {
    template: "/blog/{slug}/amp",
    segmentCount: 3,
    populationCount: 1500,
    fileIndex: 1,
    kind: "measured",
    finding: {
      httpStatus: 301,
      outcome: { httpStatus: 301, redirectHops: 2 },
      hitRate: 0.5,
      escalates: true
    }
  },
  {
    template: "/parts/{sku}/pricing",
    segmentCount: 3,
    populationCount: 8700,
    fileIndex: 0,
    kind: "blocked"
  },
  {
    template: "/search",
    segmentCount: 1,
    populationCount: 2400,
    fileIndex: 0,
    kind: "needs-review"
  },
  {
    template: "/legacy/{id}.asp",
    segmentCount: 2,
    populationCount: 40,
    fileIndex: 2,
    kind: "measured",
    finding: {
      httpStatus: 404,
      outcome: { httpStatus: 404 },
      hitRate: 0, // the zero-hit case wilsonInterval exists for
      escalates: true
    }
  }
];

/**
 * A smaller second site, on the standard tier.
 *
 * Deliberately not a copy of the first: different severities (a redirect chain
 * and a gone page rather than a soft 404 and a 5xx) and a smaller population,
 * so the fleet list has a genuine ranking to produce rather than two identical
 * blocks of rows. Its worst finding is milder than Skyline's, which is what
 * makes the worst-first ordering observable across sites instead of within one.
 */
const NORTHWIND_PATTERNS: readonly PatternPlan[] = [
  /*
   * DEPTHS 1 THROUGH 7, deliberately. Every Northwind pattern used to sit at
   * segment count 2, which made the path-depth histogram a single bar — the
   * chart was correct and the data had no shape. A demo whose distribution
   * widgets cannot distribute is a demo of nothing.
   */
  {
    template: "/support",
    segmentCount: 1,
    populationCount: 12,
    fileIndex: 1,
    kind: "census-healthy"
  },
  {
    template: "/docs/{slug}/spec/{rev}",
    segmentCount: 4,
    populationCount: 2_600,
    fileIndex: 1,
    kind: "measured",
    finding: {
      httpStatus: 404,
      outcome: { httpStatus: 404 },
      hitRate: 0.12,
      escalates: false
    }
  },
  {
    template: "/parts/{sku}/docs/{slug}/rev/{rev}",
    segmentCount: 6,
    populationCount: 840,
    fileIndex: 2,
    kind: "measured",
    finding: {
      httpStatus: 301,
      outcome: { httpStatus: 301, redirectHops: 3 },
      hitRate: 0.4,
      escalates: false
    }
  },
  {
    template: "/archive/{slug}/{rev}/legacy/{id}/print/{page}",
    segmentCount: 7,
    populationCount: 310,
    fileIndex: 2,
    kind: "needs-review"
  },
  {
    template: "/catalog/{slug}",
    segmentCount: 2,
    populationCount: 4200,
    fileIndex: 0,
    kind: "measured",
    finding: {
      httpStatus: 301,
      outcome: { httpStatus: 301, redirectHops: 2 },
      hitRate: 0.3,
      escalates: false
    }
  },
  {
    template: "/clearance/{sku}",
    segmentCount: 2,
    populationCount: 1500,
    fileIndex: 0,
    kind: "measured",
    finding: {
      httpStatus: 410,
      outcome: { httpStatus: 410 },
      hitRate: 0.45,
      escalates: false
    }
  },
  {
    template: "/manuals/{id}",
    segmentCount: 2,
    populationCount: 26,
    fileIndex: 1,
    kind: "census-healthy"
  }
];

const SITE_PLANS: readonly SitePlan[] = [
  {
    name: "Skyline Aviation Parts",
    baseUrl: "https://www.skyline-aviation-parts.example",
    tier: "priority",
    patterns: SKYLINE_PATTERNS
  },
  {
    name: "Northwind Avionics",
    baseUrl: "https://shop.northwind-avionics.example",
    tier: "standard",
    patterns: NORTHWIND_PATTERNS
  }
];

const FILES = [
  { filename: "parts-sitemap.xml", fileOrdinal: 1 },
  { filename: "content-sitemap.xml", fileOrdinal: 2 },
  { filename: "legacy-sitemap.xml", fileOrdinal: 3 }
] as const;

function urlFor(baseUrl: string, template: string, index: number): string {
  const slug = template
    .replace("{sku}", `SKU-${1000 + index}`)
    .replace("{slug}", `topic-${index}`)
    .replace("{page}", `page-${index}`)
    .replace("{id}", `${index}`);

  return `${baseUrl}${slug}`;
}

interface SyntheticObservation {
  readonly url: string;
  readonly urlHash: number;
  readonly locOrdinal: number;
  readonly httpStatus: number | null;
  readonly isSoft404: boolean;
  readonly methodUsed: "HEAD" | "GET";
  readonly escalatedToGet: boolean;
  readonly errorReason: string | null;
}

/** Build `count` synthetic probes for one pattern, `hits` of them matching the finding. */
function buildObservations(
  baseUrl: string,
  template: string,
  count: number,
  hits: number,
  finding: PatternPlan["finding"] | undefined
): readonly SyntheticObservation[] {
  const rows: SyntheticObservation[] = [];

  for (let i = 0; i < count; i += 1) {
    const url = urlFor(baseUrl, template, i);
    const isHit = i < hits;
    const httpStatus = isHit ? (finding?.httpStatus ?? 200) : 200;
    const isSoft404 = isHit ? (finding?.outcome.isSoft404 ?? false) : false;
    const escalatedToGet = isHit ? (finding?.escalates ?? false) : false;

    rows.push({
      url,
      urlHash: stableHash(url),
      locOrdinal: i + 1,
      httpStatus,
      isSoft404,
      methodUsed: escalatedToGet ? "GET" : "HEAD",
      escalatedToGet,
      errorReason: null
    });
  }

  return rows;
}

function maxHash(rows: readonly SyntheticObservation[]): number {
  return rows.reduce((max, row) => Math.max(max, row.urlHash), 0);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString === undefined || connectionString === "") {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env (or export it) before running the seed script."
    );
  }

  const force = argv.includes("--force");
  const { db, close } = createDatabase({ connectionString });

  try {
    let org = await findOrganizationBySlug(db, ORG_SLUG);
    let orgScope = org ? systemOrganizationScope(org.id) : undefined;

    if (!org) {
      const created = await createOrganization(db, {
        name: "Asapsemi (demo)",
        slug: ORG_SLUG
      });

      org = created.row;
      orgScope = created.scope;
    }

    if (!orgScope) {
      throw new Error("unreachable: orgScope must be set once org exists");
    }

    const existingSites = await listSites(db, orgScope, {
      includeInactive: true
    });

    for (const sitePlan of SITE_PLANS) {
      const host = new URL(sitePlan.baseUrl).host.toLowerCase();
      const existing = existingSites.find((s) => s.host === host);

      /*
      `continue`, not `return`. With one site this was an early exit from the
      whole script; with several, returning here would silently skip every
      site after the first already-seeded one — so re-running after adding a
      site to SITE_PLANS would appear to do nothing.
    */
      if (existing && !force) {
        console.log(
          `Demo site already seeded (${existing.name}, ${existing.id}). Re-run with --force to add another run.`
        );
        continue;
      }

      const siteScope: SiteScope = existing
        ? siteScopeWithin(orgScope, existing.id)
        : (
            await createSite(db, orgScope, {
              name: sitePlan.name,
              baseUrl: sitePlan.baseUrl,
              tier: sitePlan.tier
            })
          ).scope;

      if (!existing) {
        console.log(`Created site ${siteScope.siteId} (${sitePlan.name})`);
      }

      /*
       * THREE RUNS PER SITE, OLDEST FIRST.
       *
       * One run per site meant the trend chip had nothing to compare
       * against and a time series had a single point — both widgets rendered
       * empty against data that was correct but had no history. Populations
       * scale below the current run so the series slopes, which is what a
       * growing sitemap actually looks like.
       *
       * Sequential rather than concurrent, because the partial unique index
       * allows exactly one run in flight per site: each generation finishes
       * before the next starts, which is the constraint a real scheduler
       * works under too.
       */
      for (const scale of RUN_GENERATIONS) {
        const runPatterns: readonly PatternPlan[] = sitePlan.patterns.map(
          (pattern) => ({
            ...pattern,
            // Never below one: a pattern that exists holding zero URLs is a
            // different fact from a smaller pattern, and not the one being
            // simulated here.
            populationCount: Math.max(
              1,
              Math.round(pattern.populationCount * scale)
            )
          })
        );

        /*
      MARKED AS A DRY RUN, and that is the point.
      
      These observations were manufactured, not measured — no HTTP request was
      ever sent (the host is a reserved .example domain that cannot resolve).
      Stamped `isDryRun: false`, the resulting rows were indistinguishable at
      the data layer from a real audit: status `complete`, patterns `measured`,
      intervals computed by the real estimator. The only markers were an org
      slug and a worker id, neither of which any query filters on. A row that
      cannot say it was never measured is exactly the kind of plausible-looking
      wrong answer this project spends its effort preventing.
    */
        const run = await startRun(db, siteScope, {
          workerId: WORKER_ID,
          isDryRun: true
        });

        console.log(`Started run ${run.id}`);

        const fileRows = await upsertSitemapFiles(
          db,
          siteScope,
          run.id,
          /*
        `url` is required and is the idempotency key: uq_sitemap_file_run_url
        is (site, run, url), so omitting it would make every re-seed collide
        on an empty string rather than on the file it describes.
      */
          FILES.map((f) => ({
            url: `${sitePlan.baseUrl}/${f.filename}`,
            filename: f.filename,
            fileOrdinal: f.fileOrdinal
          }))
        );

        /*
         * NOT EVERY FILE PARSES CLEANLY, and the demo should not pretend so.
         * The third file is left `skipped` on the newest run so the files table
         * exercises its own warning path — a skipped file undercounts the
         * population by whatever it held, which is a real thing a reader has to
         * be able to see rather than a state that only exists in tests.
         */
        for (const file of fileRows) {
          const urlCount = runPatterns
            .filter((p) => FILES[p.fileIndex]?.fileOrdinal === file.fileOrdinal)
            .reduce((sum, p) => sum + p.populationCount, 0);

          if (file.fileOrdinal === 3 && urlCount === 0) {
            await setFileParseStatus(db, siteScope, file.id, "skipped", {
              urlCount: 0,
              parseError:
                "empty after gzip decode; skipped by the oversize guard"
            });
            continue;
          }

          await setFileParseStatus(db, siteScope, file.id, "parsed", {
            urlCount
          });
        }

        await upsertPatterns(
          db,
          siteScope,
          run.id,
          runPatterns.map((p) => ({
            template: p.template,
            segmentCount: p.segmentCount,
            populationCount: p.populationCount,
            fileCount: 1
          }))
        );

        // Re-read to get generated ids, keyed by template (unique per run).
        const patternRows = await listPatternsByPopulation(
          db,
          siteScope,
          run.id,
          runPatterns.length
        );
        const patternByTemplate = new Map(
          patternRows.map((p) => [p.template, p])
        );

        let samplesDrawn = 0;
        let patternsLowConfidence = 0;
        /** At most one expansion per run — see the round-2 draw below. */
        let expandedThisRun = false;
        const patternsBlocked = runPatterns.filter(
          (p) => p.kind === "blocked"
        ).length;
        const patternsNeedsReview = runPatterns.filter(
          (p) => p.kind === "needs-review"
        ).length;

        for (const plan of runPatterns) {
          const patternRow = patternByTemplate.get(plan.template);

          if (!patternRow) {
            throw new Error(`pattern ${plan.template} was not inserted`);
          }

          const file = fileRows[plan.fileIndex];

          if (!file) {
            throw new Error(`file index ${plan.fileIndex} out of range`);
          }

          await upsertPatternPopulations(db, siteScope, [
            {
              patternId: patternRow.id,
              sitemapFileId: file.id,
              urlCount: plan.populationCount
            }
          ]);

          if (plan.kind === "blocked") {
            // A host refusal, not a measurement. Recorded as attempted probes so
            // the sample-evidence view has something real to show, but no claim
            // is published — see the module comment.
            const attempted = Math.min(
              20,
              firstRoundSampleSize(plan.populationCount)
            );
            const observations = Array.from({ length: attempted }, (_, i) => {
              const url = urlFor(sitePlan.baseUrl, plan.template, i);

              return {
                url,
                urlHash: stableHash(url),
                locOrdinal: i + 1,
                httpStatus: 403,
                isSoft404: false,
                methodUsed: "HEAD" as const,
                escalatedToGet: false,
                errorReason: null
              };
            });

            const sample = await recordPatternSample(db, siteScope, {
              patternId: patternRow.id,
              sitemapRunId: run.id,
              kRequested: firstRoundSampleSize(plan.populationCount),
              kThresholdHash: maxHash(observations),
              sampleSize: attempted,
              populationAtDraw: plan.populationCount
            });

            await appendSampleObservations(
              db,
              siteScope,
              observations.map((o) => ({
                patternId: patternRow.id,
                patternSampleId: sample.id,
                sitemapFileId: file.id,
                locOrdinal: o.locOrdinal,
                urlHash: o.urlHash,
                url: o.url,
                httpStatus: o.httpStatus,
                methodUsed: o.methodUsed,
                escalatedToGet: o.escalatedToGet,
                isSoft404: o.isSoft404
              }))
            );

            await setPatternStatus(
              db,
              siteScope,
              patternRow.id,
              "blocked",
              "Host returned 403 on every probe; circuit opened after 20 consecutive refusals."
            );

            samplesDrawn += 1;
            continue;
          }

          if (plan.kind === "needs-review") {
            // GET-escalation cap tripped: the host doesn't answer HEAD, so every
            // probe had to escalate, and sampling stopped rather than keep
            // burning budget. Also an absence of measurement — no snapshot.
            const requested = firstRoundSampleSize(plan.populationCount);
            const observations = Array.from({ length: requested }, (_, i) => {
              const url = urlFor(sitePlan.baseUrl, plan.template, i);

              return {
                url,
                urlHash: stableHash(url),
                locOrdinal: i + 1,
                httpStatus: i % 3 === 0 ? 404 : 200,
                isSoft404: false,
                methodUsed: "GET" as const,
                escalatedToGet: true,
                errorReason: null
              };
            });

            const sample = await recordPatternSample(db, siteScope, {
              patternId: patternRow.id,
              sitemapRunId: run.id,
              kRequested: requested,
              kThresholdHash: maxHash(observations),
              sampleSize: requested,
              populationAtDraw: plan.populationCount
            });

            await appendSampleObservations(
              db,
              siteScope,
              observations.map((o) => ({
                patternId: patternRow.id,
                patternSampleId: sample.id,
                sitemapFileId: file.id,
                locOrdinal: o.locOrdinal,
                urlHash: o.urlHash,
                url: o.url,
                httpStatus: o.httpStatus,
                methodUsed: o.methodUsed,
                escalatedToGet: o.escalatedToGet,
                isSoft404: o.isSoft404
              }))
            );

            await setPatternStatus(
              db,
              siteScope,
              patternRow.id,
              "needs_review",
              `GET-escalation cap tripped at ${requested}/${requested} probes (host does not support HEAD); sampling stopped rather than continue burning budget.`
            );

            samplesDrawn += 1;
            continue;
          }

          // "census-healthy" and "measured" both draw a real sample and publish a
          // real snapshot computed by the actual estimator.
          const k =
            plan.kind === "census-healthy"
              ? plan.populationCount
              : firstRoundSampleSize(plan.populationCount);
          const hits =
            plan.kind === "census-healthy"
              ? k
              : Math.round(k * (plan.finding?.hitRate ?? 0));

          const observations = buildObservations(
            sitePlan.baseUrl,
            plan.template,
            k,
            plan.kind === "census-healthy" ? 0 : hits,
            plan.finding
          );

          // For the census-healthy pattern every observation is a clean 200 —
          // buildObservations' "hits" parameter drives the FINDING outcome, and
          // there is no finding here, so pass 0 and treat every row as healthy.

          const sample = await recordPatternSample(db, siteScope, {
            patternId: patternRow.id,
            sitemapRunId: run.id,
            kRequested: k,
            kThresholdHash: maxHash(observations),
            sampleSize: k,
            populationAtDraw: plan.populationCount
          });

          await appendSampleObservations(
            db,
            siteScope,
            observations.map((o) => ({
              patternId: patternRow.id,
              patternSampleId: sample.id,
              sitemapFileId: file.id,
              locOrdinal: o.locOrdinal,
              urlHash: o.urlHash,
              url: o.url,
              httpStatus: o.httpStatus,
              methodUsed: o.methodUsed,
              escalatedToGet: o.escalatedToGet,
              isSoft404: o.isSoft404
            }))
          );

          samplesDrawn += 1;

          /**
           * ONE PATTERN PER RUN GETS A SECOND DRAW, so `patternsExpanded` is a
           * non-zero figure somewhere in the demo.
           *
           * Without this the Analytics screen renders a column of zeros for a
           * query that is genuinely correct, and a manual check of it would
           * "pass" while proving nothing — the vacuous-verification shape that
           * has bitten this project at D1, D3d and D3e. The pipeline records no
           * round above 1 yet, so the demo is the only place the expansion path
           * is exercised at all.
           *
           * ADR-0002's superset property: round 2 must CONTAIN round 1, which a
           * reviewer verifies by comparing thresholds. So the round-2 threshold
           * is raised above round 1's and the same observations are re-recorded
           * under the new draw plus nothing else — a wider net over the same
           * water, not a different sample.
           */
          if (plan.kind === "measured" && !expandedThisRun) {
            expandedThisRun = true;

            const expansion = await recordPatternSample(db, siteScope, {
              patternId: patternRow.id,
              sitemapRunId: run.id,
              round: 2,
              kRequested: Math.min(k * 2, plan.populationCount),
              kThresholdHash: maxHash(observations) + 1_000,
              sampleSize: Math.min(k * 2, plan.populationCount),
              populationAtDraw: plan.populationCount
            });

            await appendSampleObservations(
              db,
              siteScope,
              observations.map((o) => ({
                patternId: patternRow.id,
                patternSampleId: expansion.id,
                sitemapFileId: file.id,
                locOrdinal: o.locOrdinal,
                urlHash: o.urlHash,
                url: o.url,
                httpStatus: o.httpStatus,
                methodUsed: o.methodUsed,
                escalatedToGet: o.escalatedToGet,
                isSoft404: o.isSoft404
              }))
            );

            samplesDrawn += 1;
          }

          const outcome: ProbeOutcome =
            plan.kind === "census-healthy"
              ? { httpStatus: 200 }
              : (plan.finding?.outcome ?? { httpStatus: 200 });
          const httpStatus =
            plan.kind === "census-healthy"
              ? 200
              : (plan.finding?.httpStatus ?? 200);

          const estimate = estimateStratified([
            {
              label: "all",
              population: plan.populationCount,
              sampled: k,
              hits
            }
          ]);

          const severityClass: SeverityClass = classifyOutcome(outcome);
          const weight = severityFor(severityClass, RATIFIED_SEVERITY_TABLE);
          const impactScore = estimate.pointEstimate * weight;
          const confidenceBand = confidenceBandFor({
            pointEstimate: estimate.pointEstimate,
            ciLow: estimate.ciLow,
            ciHigh: estimate.ciHigh,
            populationCount: estimate.populationCount,
            isCounted: estimate.isCounted
          });

          if (confidenceBand === "low") {
            patternsLowConfidence += 1;
          }

          const snapshot: AuditSnapshotInsert = {
            patternId: patternRow.id,
            patternSampleId: sample.id,
            sitemapRunId: run.id,
            httpStatus,
            evidenceTier: estimate.isCounted ? "counted" : "estimated",
            observedCount: estimate.observedCount,
            sampleSize: estimate.sampleSize,
            populationCount: estimate.populationCount,
            pointEstimate: estimate.pointEstimate,
            ciLow: estimate.ciLow,
            ciHigh: estimate.ciHigh,
            confidenceLevel: DEFAULT_CONFIDENCE_LEVEL,
            confidenceBand,
            estimatorVersion: ESTIMATOR_VERSION,
            severityClass,
            severityWeight: weight,
            impactScore
          };

          await insertAuditSnapshot(db, siteScope, snapshot);
          await setPatternStatus(db, siteScope, patternRow.id, "measured");
        }

        const totalUrls = runPatterns.reduce(
          (sum, p) => sum + p.populationCount,
          0
        );

        await updateRunProgress(db, siteScope, run.id, {
          totalFiles: FILES.length,
          parsedFiles: FILES.length,
          totalUrls,
          totalPatterns: runPatterns.length
        });

        const finished = await finishRun(db, siteScope, run.id, {
          status: "complete"
        });

        /**
         * DERIVED FROM THE ROWS, exactly as `runFinalize` derives them.
         *
         * The seed used to accumulate its own `httpRequests` and
         * `getEscalations` while walking the plan. Those accumulators happened
         * to agree with the real charging rule, but "happened to agree" is a
         * drift waiting to happen — and the reason the demo looked healthy for
         * two milestones while the pipeline wrote literal zeros is precisely
         * that the seed and the stage computed this figure in two places. One
         * rule now, and the demo exercises the same query production does.
         */
        const requests = await summariseRunRequests(db, siteScope, run.id);
        const patternsExpanded = await countExpandedPatterns(
          db,
          siteScope,
          run.id
        );

        await upsertSamplingHealth(db, siteScope, {
          sitemapRunId: run.id,
          windowStart: run.startedAt ?? new Date(),
          windowEnd: finished?.completedAt ?? new Date(),
          patternsTotal: runPatterns.length,
          patternsLowConfidence,
          patternsExpanded,
          patternsBlocked,
          patternsNeedsReview,
          samplesDrawn,
          httpRequests: requests.httpRequests,
          getEscalations: requests.getEscalations,
          /*
           * A LITERAL ZERO, no longer fabricated. The seed used to increment
           * this once per blocked pattern, which made the screens look
           * populated for a figure nothing in the platform can produce. The
           * interface now says "not measured"; manufacturing a number here
           * would contradict it.
           */
          circuitBreaks: 0
        });

        console.log(
          `Seeded site ${siteScope.siteId}, run ${run.id}: ${runPatterns.length} patterns, ${totalUrls.toLocaleString()} URLs, ${samplesDrawn} draws.`
        );
      }
    }
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
