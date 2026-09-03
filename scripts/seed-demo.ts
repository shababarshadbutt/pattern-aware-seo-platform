import { argv } from "node:process";

import {
  type AuditSnapshotInsert,
  createDatabase,
  createOrganization,
  createSite,
  findOrganizationBySlug,
  finishRun,
  insertAuditSnapshot,
  listPatternsByPopulation,
  listSites,
  recordPatternSample,
  appendSampleObservations,
  setFileParseStatus,
  setPatternStatus,
  siteScopeWithin,
  startRun,
  systemOrganizationScope,
  updateRunProgress,
  upsertPatternPopulations,
  upsertPatterns,
  upsertSamplingHealth,
  upsertSitemapFiles,
  type SiteScope
} from "../packages/database/src/index.js";
import {
  confidenceBandFor,
  DEFAULT_CONFIDENCE_LEVEL,
  ESTIMATOR_VERSION,
  RATIFIED_SEVERITY_TABLE,
  classifyOutcome,
  estimateStratified,
  firstRoundSampleSize,
  severityFor,
  stableHash,
  type ProbeOutcome,
  type SeverityClass
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
const SITE_BASE_URL = "https://www.skyline-aviation-parts.example";
const WORKER_ID = "seed-demo-script";

interface PatternPlan {
  readonly template: string;
  readonly segmentCount: number;
  readonly populationCount: number;
  readonly fileIndex: number; // which of the 3 demo files this pattern's URLs live in
  readonly kind:
    | "census-healthy"
    | "measured"
    | "blocked"
    | "needs-review";
  /** Only for "measured": the finding this pattern's audit_snapshot is about. */
  readonly finding?: {
    readonly httpStatus: number;
    readonly outcome: ProbeOutcome;
    readonly hitRate: number; // target share of the draw matching `outcome`
    readonly escalates: boolean; // does matching this outcome require a GET?
  };
}

const PATTERN_PLANS: readonly PatternPlan[] = [
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

const FILES = [
  { filename: "parts-sitemap.xml", fileOrdinal: 1 },
  { filename: "content-sitemap.xml", fileOrdinal: 2 },
  { filename: "legacy-sitemap.xml", fileOrdinal: 3 }
] as const;

function urlFor(template: string, index: number): string {
  const slug = template
    .replace("{sku}", `SKU-${1000 + index}`)
    .replace("{slug}", `topic-${index}`)
    .replace("{page}", `page-${index}`)
    .replace("{id}", `${index}`);

  return `${SITE_BASE_URL}${slug}`;
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
  template: string,
  count: number,
  hits: number,
  finding: PatternPlan["finding"] | undefined
): readonly SyntheticObservation[] {
  const rows: SyntheticObservation[] = [];

  for (let i = 0; i < count; i += 1) {
    const url = urlFor(template, i);
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
    let orgScope = org
      ? systemOrganizationScope(org.id)
      : undefined;

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
    const host = new URL(SITE_BASE_URL).host.toLowerCase();
    const existing = existingSites.find((s) => s.host === host);

    if (existing && !force) {
      console.log(
        `Demo site already seeded (${existing.name}, ${existing.id}). Re-run with --force to add another run.`
      );
      return;
    }

    const siteScope: SiteScope = existing
      ? siteScopeWithin(orgScope, existing.id)
      : (
          await createSite(db, orgScope, {
            name: "Skyline Aviation Parts",
            baseUrl: SITE_BASE_URL,
            tier: "priority"
          })
        ).scope;

    if (!existing) {
      console.log(`Created site ${siteScope.siteId} (Skyline Aviation Parts)`);
    }

    const run = await startRun(db, siteScope, {
      workerId: WORKER_ID,
      isDryRun: false
    });

    console.log(`Started run ${run.id}`);

    const fileRows = await upsertSitemapFiles(
      db,
      siteScope,
      run.id,
      FILES.map((f) => ({ filename: f.filename, fileOrdinal: f.fileOrdinal }))
    );

    for (const file of fileRows) {
      await setFileParseStatus(db, siteScope, file.id, "parsed", {
        urlCount: PATTERN_PLANS.filter(
          (p) => FILES[p.fileIndex]?.fileOrdinal === file.fileOrdinal
        ).reduce((sum, p) => sum + p.populationCount, 0)
      });
    }

    await upsertPatterns(
      db,
      siteScope,
      run.id,
      PATTERN_PLANS.map((p) => ({
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
      PATTERN_PLANS.length
    );
    const patternByTemplate = new Map(patternRows.map((p) => [p.template, p]));

    let samplesDrawn = 0;
    let httpRequests = 0;
    let getEscalations = 0;
    let patternsLowConfidence = 0;
    let patternsExpanded = 0;
    const patternsBlocked = PATTERN_PLANS.filter(
      (p) => p.kind === "blocked"
    ).length;
    const patternsNeedsReview = PATTERN_PLANS.filter(
      (p) => p.kind === "needs-review"
    ).length;
    let circuitBreaks = 0;

    for (const plan of PATTERN_PLANS) {
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
          const url = urlFor(plan.template, i);

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
        httpRequests += attempted;
        circuitBreaks += 1;
        continue;
      }

      if (plan.kind === "needs-review") {
        // GET-escalation cap tripped: the host doesn't answer HEAD, so every
        // probe had to escalate, and sampling stopped rather than keep
        // burning budget. Also an absence of measurement — no snapshot.
        const requested = firstRoundSampleSize(plan.populationCount);
        const observations = Array.from({ length: requested }, (_, i) => {
          const url = urlFor(plan.template, i);

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
        httpRequests += requested * 2; // HEAD attempt + forced GET, each probe
        getEscalations += requested;
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
      httpRequests += k + observations.filter((o) => o.escalatedToGet).length;
      getEscalations += observations.filter((o) => o.escalatedToGet).length;

      const outcome: ProbeOutcome =
        plan.kind === "census-healthy"
          ? { httpStatus: 200 }
          : (plan.finding?.outcome ?? { httpStatus: 200 });
      const httpStatus =
        plan.kind === "census-healthy" ? 200 : (plan.finding?.httpStatus ?? 200);

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

    const totalUrls = PATTERN_PLANS.reduce(
      (sum, p) => sum + p.populationCount,
      0
    );

    await updateRunProgress(db, siteScope, run.id, {
      totalFiles: FILES.length,
      parsedFiles: FILES.length,
      totalUrls,
      totalPatterns: PATTERN_PLANS.length
    });

    const finished = await finishRun(db, siteScope, run.id, {
      status: "complete"
    });

    await upsertSamplingHealth(db, siteScope, {
      sitemapRunId: run.id,
      windowStart: run.startedAt ?? new Date(),
      windowEnd: finished?.completedAt ?? new Date(),
      patternsTotal: PATTERN_PLANS.length,
      patternsLowConfidence,
      patternsExpanded,
      patternsBlocked,
      patternsNeedsReview,
      samplesDrawn,
      httpRequests,
      getEscalations,
      circuitBreaks
    });

    console.log(
      `Seeded site ${siteScope.siteId}, run ${run.id}: ${PATTERN_PLANS.length} patterns, ${totalUrls.toLocaleString()} URLs, ${samplesDrawn} draws.`
    );
  } finally {
    await close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
