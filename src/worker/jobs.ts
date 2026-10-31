import type { PgBoss, Queue } from "pg-boss";
import { getDb } from "@/db";
import { sources } from "@/db/schema";
import { runFacts } from "@/analysis/facts";
import { queueAutoDeep, runDeepRequests } from "@/analysis/deep";
import { createLlmClient } from "@/analysis/llm";
import type { RunStats } from "@/analysis/runner";
import { runTranslation } from "@/analysis/translate";
import { listPortalDocuments, portalDocumentKey } from "@/documents/adapters";
import { extractFile } from "@/documents/extract";
import { createCookieJar, createHostThrottle, fetchDocument } from "@/documents/fetch";
import { fetchDocuments, type FetchStats } from "@/documents/fetch-job";
import { createRobots, extractDocumentLinks } from "@/documents/portal";
import { processDocuments, type ProcessStats } from "@/documents/process-job";
import { createDocumentStorage, type DocumentStorage, storageConfigured } from "@/documents/storage";
import { syncEcbRates } from "@/fx/sync";
import { assessTenders, type AssessStats } from "@/policy/assess";
import { createTedAdapter } from "@/sources/eu-ted";
import { createTedClient } from "@/sources/eu-ted/client";
import { enrichTedNotices } from "@/sources/eu-ted/enrich";
import { syncIncremental, type SyncStats } from "@/sources/sync";
import { databaseNow } from "@/sources/store";
import { createFatAdapter } from "@/sources/uk-fat";
import { TIMEZONE } from "./boss";
import { createCreditPause, type CreditOutcome } from "./credit-pause";
import { createTenderChanges, matchedThroughAtStart, onceADay, WRITE_MARGIN_MS } from "./incremental";
import { watchOverdueSyncs } from "./overdue";

type JobDefinition = {
  name: string;
  /** Cron expression evaluated in Europe/Istanbul; omit for on-demand jobs. */
  cron?: string;
  /** Also run once when the worker starts, so a worker that was off catches up right away. */
  runOnStart?: boolean;
  /**
   * After a stretch with no cron pass at all (the Mac asleep), run once for the latest slot missed
   * (pg-boss's `missed: "once"`) instead of waiting for the next one.
   */
  catchUp?: boolean;
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
  // failed within five minutes (superviseIntervalSeconds, boss.ts) instead of
  // holding the queue until it expires.
  heartbeatSeconds: 60,
};

/**
 * How often an idle worker asks pg-boss for a job, per queue. pg-boss's 2
 * seconds made a dozen queues poll about 500,000 times a day, each answer
 * counting against Supabase's egress quota; scheduled jobs start up to this
 * much later instead (the every-minute jobs run every minute or two).
 */
const POLL_SECONDS = 60;

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

/** The Anthropic account's credit as the LLM jobs last found it; without it they pause (see createCreditPause). */
const creditPause = createCreditPause();

/** Notes what a run found; says in Turkish, once, what to do when the account is out of credit. */
function noteCredit(job: string, outcome: CreditOutcome) {
  const change = creditPause.record(outcome);
  if (change === "ran-out") {
    console.log(
      `[${job}] Anthropic hesabının kredisi bitti; console.anthropic.com > Plans & Billing'den kredi yükleyin. Yüklenince işler en geç yarım saat içinde kendiliğinden devam eder.`,
    );
  }
  if (change === "back") console.log(`[${job}] Anthropic hesabında yine kredi var; işler devam ediyor.`);
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

/** Jobs that have already logged missing storage settings; each says it once. */
const warnedNoStorage = new Set<string>();

function hasStorage(job: string): boolean {
  if (storageConfigured()) return true;
  if (!warnedNoStorage.has(job)) console.log(`[${job}] SUPABASE_SECRET_KEY ya da SUPABASE_STORAGE_BUCKET tanımlı değil; doküman işleri atlanıyor.`);
  warnedNoStorage.add(job);
  return false;
}

let storage: DocumentStorage | null = null;
const documentStorage = () => (storage ??= createDocumentStorage());

/** One host spacing for the worker's life, so robots.txt requests keep it too; robots.txt is read once per host. */
const throttle = createHostThrottle();
const robots = createRobots({ wait: (url) => throttle.wait(url) });

/** Links per fetch run: most answer in a second, a slow one takes up to the 60-second timeout. */
const FETCH_BATCH = 30;
/** Files per processing run; a full run queues the next at once. */
const PROCESS_BATCH = 20;
/** Deep analyses per run: each takes minutes (SPEC 7.2). */
const DEEP_BATCH = 2;

function formatFetchStats(stats: FetchStats): string {
  return (
    `attempted=${stats.attempted} fetched=${stats.fetched} manual=${stats.manual} unsupported=${stats.unsupported}` +
    ` failed=${stats.failed} retry=${stats.retry} pageFiles=${stats.pageFiles} robotsBlocked=${stats.blocked} termsBlocked=${stats.forbidden}` +
    (stats.stoppedBy ? ` stoppedBy=${stats.stoppedBy}` : "")
  );
}

function formatProcessStats(stats: ProcessStats): string {
  return (
    `processed=${stats.processed} members=${stats.members} skipped=${stats.skipped} failed=${stats.failed}` +
    (stats.stoppedBy ? ` stoppedBy=${stats.stoppedBy}` : "")
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
    catchUp: true,
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
    catchUp: true,
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
      const limits = creditPause.limits(LLM_BATCH, FACTS_CONCURRENCY);
      if (!limits) return;
      const db = getDb();
      const startedAt = await databaseNow(db);
      const stats = await runFacts(db, createLlmClient(), { limit: limits.limit, concurrency: limits.concurrency, log: (m) => console.warn(m) });
      if (stats.attempted || stats.stoppedBy) console.log(`[facts] ${formatRunStats(stats)}`);
      noteCredit("facts", stats);
      if (stats.valid) {
        const assessed = await assessTenders(db, { changedSince: new Date(startedAt.getTime() - WRITE_MARGIN_MS) });
        console.log(`[facts] assess ${formatAssessStats(assessed)}`);
      }
      // Drain a backlog without waiting for the schedule (also right after a try finds credit again).
      if (stats.attempted >= limits.limit && !stats.stoppedBy) await runAgain("facts");
    },
  },
  {
    // Every tender, when the worker starts (a new policy version) and once an
    // Istanbul day: the time left changes verdicts by the day (working days to
    // the deadline). Facts runs and syncs assess the tenders they change right
    // away. The hourly check reads nothing until the day turns, so a Mac that
    // slept through midnight catches up when it wakes. The detail page works
    // verdicts out live.
    name: "assess",
    cron: "5 * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      await assessDaily();
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
      const limits = creditPause.limits(LLM_BATCH, TRANSLATE_CONCURRENCY);
      if (!limits) return;
      const stats = await runTranslation(getDb(), createLlmClient(), {
        limit: limits.limit,
        concurrency: limits.concurrency,
        log: (m) => console.warn(m),
      });
      if (stats.attempted || stats.stoppedBy) console.log(`[translate] ${formatRunStats(stats)}`);
      noteCredit("translate", stats);
      if (stats.attempted >= limits.limit && !stats.stoppedBy) await runAgain("translate");
    },
  },
  {
    // Structured details (duration, criteria) for TED tenders stored before
    // TED_FIELDS had them and matched only later; newer notices carry them.
    name: "enrich-ted",
    cron: "45 5 * * *",
    catchUp: true,
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
    // Document links of the tenders the team may bid on (SPEC Faz 5). Most
    // are portal pages, which the team downloads from and uploads.
    name: "fetch-documents",
    cron: "15,45 * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      if (!hasStorage("fetch-documents")) return;
      // Cookies a site sets for anonymous visitors, for this run only.
      const cookies = createCookieJar();
      const stats = await fetchDocuments(
        getDb(),
        {
          // The guard (terms and robots.txt) is asked before every request, redirects included.
          fetchDocument: (url, { guard, maxBytes }) => fetchDocument(url, { cookies, guard, maxBytes }),
          wait: (url) => throttle.wait(url),
          robots: (url) => robots.check(url),
          extractLinks: (html, pageUrl) => extractDocumentLinks(html, pageUrl),
          listDocuments: (url, guard) => listPortalDocuments(url, guard),
          documentKey: (url) => portalDocumentKey(url),
          storage: documentStorage(),
          log: (m) => console.warn(m),
        },
        { limit: FETCH_BATCH },
      );
      if (stats.attempted) console.log(`[fetch-documents] ${formatFetchStats(stats)}`);
    },
  },
  {
    // Text, page counts and ZIP members of fetched and uploaded files; an
    // upload is read within a minute or two.
    name: "process-documents",
    cron: "* * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      if (!hasStorage("process-documents")) return;
      const stats = await processDocuments(
        getDb(),
        { extract: (bytes, kind) => extractFile(bytes, kind), storage: documentStorage(), log: (m) => console.warn(m) },
        { limit: PROCESS_BATCH },
      );
      const handled = stats.processed + stats.skipped + stats.failed;
      if (handled) console.log(`[process-documents] ${formatProcessStats(stats)}`);
      if (handled >= PROCESS_BATCH && !stats.stoppedBy) await runAgain("process-documents");
    },
  },
  {
    // Deep analyses the team asked for on the tender page, and the first one
    // of tenders a profile with autoAnalyze matches (SPEC 7.2). Past the
    // monthly budget only the team's requests run (CLAUDE.md rule 7).
    name: "deep-analysis",
    cron: "* * * * *",
    runOnStart: true,
    queue: syncQueue,
    handler: async () => {
      if (!hasStorage("deep-analysis")) return;
      const db = getDb();
      const queued = await queueAutoDeep(db);
      // The team's requests run without credit too, so the page says why one failed; the others hear of it.
      const stats = await runDeepRequests(db, { llm: createLlmClient(), storage: documentStorage(), log: (m) => console.warn(m) }, { limit: DEEP_BATCH });
      noteCredit("deep-analysis", { stoppedBy: stats.stoppedBy, attempted: stats.analysed + stats.failed });
      if (queued || stats.analysed || stats.failed) {
        console.log(
          `[deep-analysis] queued=${queued} analysed=${stats.analysed} failed=${stats.failed} cost=${stats.costUsd.toFixed(4)}` +
            (stats.stoppedBy ? ` stoppedBy=${stats.stoppedBy}` : ""),
        );
      }
      if (stats.analysed + stats.failed >= DEEP_BATCH && !stats.stoppedBy) await runAgain("deep-analysis");
    },
  },
  {
    // ECB publishes around 16:00 CET; this runs after it, and on worker start.
    name: "fx-ecb",
    cron: "30 18 * * *",
    runOnStart: true,
    catchUp: true,
    queue: syncQueue,
    handler: async () => {
      const db = getDb();
      const fx = await syncEcbRates(db);
      console.log(`[fx-ecb] ${fx.source} latest=${fx.latestDate} rows=${fx.rows} new=${fx.inserted} updated=${fx.updated}`);
      // New rates can turn unknown EUR values into known ones and change those
      // worked out from an earlier day's rate; weekends and holidays bring
      // none, so there is nothing to recompute.
      if (fx.inserted + fx.updated > 0) await afterTenderChanges(db, "fx-ecb", { recheckValues: true });
    },
  },
];

const assessDaily = onceADay(async () => {
  console.log(`[assess] ${formatAssessStats(await assessTenders(getDb()))}`);
});

/** EUR values, matching and verdicts after tender writes, only for what changed (see createTenderChanges); set by registerJobs. */
let tenderChanges = createTenderChanges();

async function afterTenderChanges(db: ReturnType<typeof getDb>, job: string, options: { recheckValues?: boolean } = {}): Promise<void> {
  const { full, value, match, assess } = await tenderChanges(db, options);
  console.log(
    `[${job}] valueEur checked=${value.checked} updated=${value.updated} unconverted=${value.unconverted}` +
      ` | matching ${full ? "all" : "changed"} tenders=${match.tenders} profiles=${match.profiles} matched=${match.matched}` +
      ` new=${match.created} unmatched=${match.unmatched}` +
      (assess.assessed ? ` | assess ${formatAssessStats(assess)}` : ""),
  );
}

/** An error's message with its cause's: Drizzle's "Failed query" keeps the reason (a reset connection) in the cause. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (neden: ${error.cause.message})` : "";
  return `${error.message.slice(0, 300)}${cause}`;
}

export async function registerJobs(boss: PgBoss): Promise<void> {
  // Before this process's syncs move last_synced_at (see matchedThroughAtStart).
  tenderChanges = createTenderChanges({ log: (m) => console.warn(m), handledThrough: await matchedThroughAtStart(getDb()) });
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
      await boss.schedule(job.name, job.cron, null, { tz: TIMEZONE, missed: job.catchUp ? "once" : "skip" });
    }
    await boss.work(job.name, { pollingIntervalSeconds: POLL_SECONDS }, async (batch) => {
      for (const { id, data } of batch) {
        try {
          await job.handler(id, data);
        } catch (error) {
          // pg-boss keeps the error in the job's row; the log should show it too.
          console.error(`[${job.name}] hata: ${describeError(error)}`);
          throw error;
        }
      }
    });
    // The stately policy drops this if a run is already queued.
    if (job.runOnStart) await boss.send(job.name, {});
    console.log(`[worker] registered ${job.name}${job.cron ? ` (${job.cron} ${TIMEZONE})` : ""}`);
  }
  watchOverdueSyncs({
    read: () => getDb().select({ id: sources.id, lastSyncedAt: sources.lastSyncedAt }).from(sources),
    send: (job) => boss.send(job, {}),
    log: (message) => console.warn(message),
  });
}
