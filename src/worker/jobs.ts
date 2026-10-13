import type { PgBoss } from "pg-boss";
import { TIMEZONE } from "./boss";

type JobDefinition = {
  name: string;
  /** Cron expression evaluated in Europe/Istanbul; omit for on-demand jobs. */
  cron?: string;
  handler: (jobId: string, data: unknown) => Promise<void>;
};

const jobs: JobDefinition[] = [
  {
    // Phase 0 smoke test: proves scheduling and workers run end to end.
    name: "heartbeat",
    cron: "* * * * *",
    handler: async (jobId) => {
      console.log(`[heartbeat] ${new Date().toISOString()} job=${jobId}`);
    },
  },
];

export async function registerJobs(boss: PgBoss): Promise<void> {
  for (const job of jobs) {
    if (!(await boss.getQueue(job.name))) {
      await boss.createQueue(job.name);
    }
    if (job.cron) {
      await boss.schedule(job.name, job.cron, null, { tz: TIMEZONE });
    }
    await boss.work(job.name, async (batch) => {
      for (const { id, data } of batch) {
        await job.handler(id, data);
      }
    });
    console.log(`[worker] registered ${job.name}${job.cron ? ` (${job.cron} ${TIMEZONE})` : ""}`);
  }
}
