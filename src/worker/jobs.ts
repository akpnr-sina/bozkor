import type { PgBoss, Queue } from "pg-boss";
import { getDb } from "@/db";
import { runFacts } from "@/analysis/facts";
import { createLlmClient } from "@/analysis/llm";
import type { RunStats } from "@/analysis/runner";
import { runTranslation } from "@/analysis/translate";
import { syncEcbRates } from "@/fx/sync";
import { rematch } from "@/matching/apply";
import { assessTenders, type AssessStats } from "@/policy/assess";
import { createTedAdapter } from "@/sources/eu-ted";
import { createTedClient } from "@/sources/eu-ted/client";
import { enrichTedNotices } from "@/sources/eu-ted/enrich";
import { syncIncremental, type SyncStats } from "@/sources/sync";
import { createFatAdapter } from "@/sources/uk-fat";
import { fillValueEur } from "@/sources/value-eur";
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
    `outOfScope=${stats.outOfScope}`,
    `removed=${stats.removed}`,
    `outOfScopeKept=${stats.outOfScopeKept}`,
    `normalizeErrors=${stats.normalizeErrors}`,
  ].join(" ");
}

const syncQueue: Omit<Queue, "name"> = {
  // One queued and one active at most, so slow runs never pile up.
  policy: "stately",
  expireInSeconds: 60 * 60,
  retryLimit: 1,
  retryDelay: 10 * 60,
  // A running worker refreshes the heartbeat; a stopped one leaves its job
  // failed within a minute instead of holding the queue until it expires.
  heartbeatSeconds: 60,
};

/** LLM runs stay short (a few minutes), so a restart cuts little off. */
const LLM_BATCH = 60;
/** Calls in flight per LLM job; the SDK waits out a rate limit (429) by itself. */
const FACTS_CONCURRENCY = 3;
const TRANSLATE_CONCURRENCY = 4;

/** Queues another run of a job at once; set by registerJobs. A full batch means more is waiting. */
let runAgain: (name: string) => Promise<void> = async () => {};

/** Jobs that have already logged a missing API key; each says it once. */
const warnedNoApiKey = new Set<string>();

function hasApiKey(job: string, skipped: string): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (!warnedNoApiKey.has(job)) console.log(`[${job}] ANTHROPIC_API_KEY tanımlı değil; ${skipped} atlanıyor.`);
  warnedNoApiKey.add(job);
  return false;
}

function formatRunStats(stats: RunStats): string {
  return (
    `attempted=${stats.attempted} valid=${stats.valid} invalid=${stats.invalid} apiErrors=${stats.apiErrors}` +
    ` cost=${stats.costUsd.toFixed(4)} monthSpent=${(stats.spentBeforeUsd + stats.costUsd).toFixed(2)}/${stats.budgetUsd}` +
    (stats.stoppedBy ? ` stoppedBy=${stats.stoppedBy}` : "")
  );
}

let warnedNoCredit = false;

/** Says once, in Turkish, what to do when the Anthropic account is out of credit. */
function warnNoCredit(job: string, stats: RunStats) {
  if (stats.stoppedBy !== "credit") {
    if (stats.valid) warnedNoCredit = false;
    return;
  }
  if (!warnedNoCredit) {
    console.log(`[${job}] Anthropic hesabının kredisi bitti; console.anthropic.com > Plans & Billing'den kredi yükleyin. Yüklenince işler kendiliğinden devam eder.`);
  }
  warnedNoCredit = true;
}

function formatAssessStats(stats: AssessStats): string {
  const byStatus = Object.entries(stats.byStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");
  return (
    `assessed=${stats.assessed} changed=${stats.changed} statusChanged=${stats.statusChanged}` +
    (stats.errors ? ` errors=${stats.errors}` : "") +
    (stats.removed ? ` removed=${stats.removed}` : "") +
    (byStatus ? ` | ${byStatus}` : "")
  );
}

/** Jobs that no longer run; their schedules are removed so pg-boss stops queuing them. */
const RETIRED_JOBS = [
  // Profile-level relevance scores, replaced by facts and the qualification policy (team decision, 15 October 2026).
  "triage",
];

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
      const db = getDb();
      const stats = await syncIncremental(db, createFatAdapter());
      console.log(
        `[sync-uk-fat] ${stats.window.from.toISOString()} .. ${stats.window.to.toISOString()} ${formatSyncStats(stats)}`,
      );
      await afterTenderChanges(db, "sync-uk-fat");
    },
  },
  {
    // TED publishes one edition per working day, in the morning Luxembourg
    // time; the afternoon run catches a late edition.
    name: "sync-eu-ted",
    cron: "30 11,17 * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      const db = getDb();
      const stats = await syncIncremental(db, createTedAdapter());
      console.log(
        `[sync-eu-ted] ${stats.window.from.toISOString()} .. ${stats.window.to.toISOString()} ${formatSyncStats(stats)}`,
      );
      await afterTenderChanges(db, "sync-eu-ted");
    },
  },
  {
    // Facts from the notices the team sees (qualification policy part XII.2),
    // then the policy's verdict on them; stops at the monthly budget.
    name: "facts",
    cron: "*/10 * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      if (!hasApiKey("facts", "olgu çıkarma")) return;
      const db = getDb();
      const stats = await runFacts(db, createLlmClient(), { limit: LLM_BATCH, concurrency: FACTS_CONCURRENCY, log: (m) => console.warn(m) });
      if (stats.attempted || stats.stoppedBy) console.log(`[facts] ${formatRunStats(stats)}`);
      warnNoCredit("facts", stats);
      if (stats.valid) console.log(`[facts] assess ${formatAssessStats(await assessTenders(db))}`);
      // Drain a backlog without waiting for the schedule.
      if (stats.attempted >= LLM_BATCH && !stats.stoppedBy) await runAgain("facts");
    },
  },
  {
    // The time left changes verdicts (deadlines pass, partners can no longer
    // be found in time), and a new policy version reassesses everything. The
    // detail page works verdicts out live; the inbox lags by at most this.
    name: "assess",
    cron: "*/15 * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      const stats = await assessTenders(getDb());
      if (stats.changed) console.log(`[assess] ${formatAssessStats(stats)}`);
    },
  },
  {
    // Turkish titles, descriptions and lots for the notices the team sees.
    name: "translate",
    cron: "*/10 * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      if (!hasApiKey("translate", "çeviri")) return;
      const stats = await runTranslation(getDb(), createLlmClient(), {
        limit: LLM_BATCH,
        concurrency: TRANSLATE_CONCURRENCY,
        log: (m) => console.warn(m),
      });
      if (stats.attempted || stats.stoppedBy) console.log(`[translate] ${formatRunStats(stats)}`);
      warnNoCredit("translate", stats);
      if (stats.attempted >= LLM_BATCH && !stats.stoppedBy) await runAgain("translate");
    },
  },
  {
    // Structured details (duration, criteria) for TED tenders stored before
    // TED_FIELDS had them and matched only later; newer notices carry them.
    name: "enrich-ted",
    cron: "45 5 * * *",
    queue: syncQueue,
    handler: async () => {
      const stats = await enrichTedNotices(getDb(), createTedClient(), { onlyMissingDetails: true, log: (m) => console.warn(`[enrich-ted] ${m.trim()}`) });
      if (stats.tenders) {
        console.log(
          `[enrich-ted] tenders=${stats.tenders} requested=${stats.requested} fetched=${stats.fetched} rawNew=${stats.rawInserted}` +
            ` updated=${stats.updated} normalizeErrors=${stats.normalizeErrors}`,
        );
      }
    },
  },
  {
    // ECB publishes around 16:00 CET; this runs after it, and on worker start.
    name: "fx-ecb",
    cron: "30 18 * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      const db = getDb();
      const fx = await syncEcbRates(db);
      console.log(`[fx-ecb] ${fx.source} latest=${fx.latestDate} rows=${fx.rows} new=${fx.inserted} updated=${fx.updated}`);
      // New rates can turn unknown EUR values into known ones; weekends and
      // holidays bring none, so there is nothing to recompute.
      if (fx.inserted + fx.updated > 0) await afterTenderChanges(db, "fx-ecb");
    },
  },
];

/**
 * EUR values first, then matching, so value filters see fresh values. Both
 * look at everything rather than only this run's changes, so work left by an
 * earlier run that failed half way is picked up too.
 */
async function afterTenderChanges(db: ReturnType<typeof getDb>, job: string): Promise<void> {
  const value = await fillValueEur(db);
  const match = await rematch(db, { log: (m) => console.warn(m) });
  console.log(
    `[${job}] valueEur checked=${value.checked} updated=${value.updated} unconverted=${value.unconverted}` +
      ` | matching profiles=${match.profiles} matched=${match.matched} new=${match.created} unmatched=${match.unmatched}`,
  );
}

export async function registerJobs(boss: PgBoss): Promise<void> {
  // The stately policy keeps it to one queued run while one is active.
  runAgain = async (name) => {
    await boss.send(name, {});
  };
  for (const name of RETIRED_JOBS) {
    if ((await boss.getSchedules(name)).length) {
      await boss.unschedule(name);
      console.log(`[worker] unscheduled retired job ${name}`);
    }
  }
  for (const job of jobs) {
    if (!(await boss.getQueue(job.name))) {
      await boss.createQueue(job.name, job.queue);
    } else if (job.queue) {
      // Options other than the policy can change on an existing queue.
      const { expireInSeconds, retryLimit, retryDelay, heartbeatSeconds } = job.queue;
      await boss.updateQueue(job.name, { expireInSeconds, retryLimit, retryDelay, heartbeatSeconds });
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
