import type { PgBoss, Queue } from "pg-boss";
import { getDb } from "@/db";
import { syncIncremental, type SyncStats } from "@/sources/sync";
import { createFatAdapter } from "@/sources/uk-fat";
import { TIMEZONE } from "./boss";

type JobDefinition = {
  name: string;
  /** Cron expression evaluated in Europe/Istanbul; omit for on-demand jobs. */
  cron?: string;
  /** Also run once when the worker starts, so a worker that was off catches up right away. */
  runOnStart?: boolean;
  queue?: Omit<Queue, "name">;
  handler: (jobId: string, data: unknown) => Promise<void>;
};

export function formatSyncStats(stats: SyncStats): string {
  return [
    `fetched=${stats.fetched}`,
    `rawNew=${stats.rawInserted}`,
    `tendersNew=${stats.inserted}`,
    `tendersUpdated=${stats.updated}`,
    `changed=${stats.changed}`,
    `skipped=${stats.skipped}`,
    `normalizeErrors=${stats.normalizeErrors}`,
  ].join(" ");
}

const syncQueue: Omit<Queue, "name"> = {
  // One queued and one active at most, so slow runs never pile up.
  policy: "stately",
  expireInSeconds: 60 * 60,
  retryLimit: 1,
  retryDelay: 10 * 60,
};

const jobs: JobDefinition[] = [
  {
    // Liveness signal in the logs.
    name: "heartbeat",
    cron: "*/30 * * * *",
    handler: async (jobId) => {
      console.log(`[heartbeat] ${new Date().toISOString()} job=${jobId}`);
    },
  },
  {
    name: "sync-uk-fat",
    cron: "0 */2 * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      const stats = await syncIncremental(getDb(), createFatAdapter());
      console.log(
        `[sync-uk-fat] ${stats.window.from.toISOString()} .. ${stats.window.to.toISOString()} ${formatSyncStats(stats)}`,
      );
    },
  },
];

export async function registerJobs(boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    if (!(await boss.getQueue(job.name))) {
      await boss.createQueue(job.name, job.queue);
    }
    if (job.cron) {
      await boss.schedule(job.name, job.cron, null, { tz: TIMEZONE });
    }
    await boss.work(job.name, async (batch) => {
      for (const { id, data } of batch) {
        await job.handler(id, data);
      }
    });
    // The stately policy drops this if a run is already queued.
    if (job.runOnStart) await boss.send(job.name, {});
    console.log(`[worker] registered ${job.name}${job.cron ? ` (${job.cron} ${TIMEZONE})` : ""}`);
  }
}
