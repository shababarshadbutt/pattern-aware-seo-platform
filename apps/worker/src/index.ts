import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

// Placeholder queue — replace with the real pipeline as Phase 1 lands:
// sitemap-discovery -> sitemap-download -> sitemap-parse -> pattern-extraction -> sampling -> ...
const worker = new Worker(
  "sitemap-discovery",
  async (job: Job) => {
    console.log(`processing job ${job.id} (${job.name})`, job.data);
    return { ok: true };
  },
  { connection }
);

worker.on("completed", (job) => {
  console.log(`job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`job ${job?.id} failed:`, err.message);
});

console.log("worker started, listening on queue: sitemap-discovery");

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
