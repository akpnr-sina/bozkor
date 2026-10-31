const HOUR = 3_600_000;
const CHECK_EVERY_MS = 10 * 60_000;

/**
 * How long a source may go without a successful sync before its job is asked for again: a little
 * over its longest gap between scheduled runs (UK every 2 hours; TED at 11:30 and 17:30 Istanbul,
 * 18 hours overnight).
 */
export const SYNC_OVERDUE: Record<string, { job: string; afterMs: number }> = {
  uk_fat: { job: "sync-uk-fat", afterMs: 2.5 * HOUR },
  eu_ted: { job: "sync-eu-ted", afterMs: 19 * HOUR },
};

export type SourceSync = { id: string; lastSyncedAt: Date | null };

/** The sync jobs whose source has gone longer without a success than its schedule allows. */
export function overdueSyncJobs(rows: SourceSync[], now: Date): string[] {
  return rows.flatMap((row) => {
    const rule = SYNC_OVERDUE[row.id];
    if (!rule) return [];
    return !row.lastSyncedAt || now.getTime() - row.lastSyncedAt.getTime() > rule.afterMs ? [rule.job] : [];
  });
}

/**
 * pg-boss sends nothing for a slot whose cron pass failed, and on the Mac passes failed for hours
 * after the connections broke (30-31 October 2026: no sync for 21 hours while other jobs still ran
 * now and then). Every 10 minutes a sync whose source is overdue is asked for again, apart from the
 * cron; the stately queue keeps it to one queued run. Returns a function that stops the watch.
 */
export function watchOverdueSyncs(deps: {
  read: () => Promise<SourceSync[]>;
  send: (job: string) => Promise<unknown>;
  log: (message: string) => void;
  now?: () => Date;
}): () => void {
  const now = deps.now ?? (() => new Date());
  const check = async () => {
    try {
      for (const job of overdueSyncJobs(await deps.read(), now())) {
        await deps.send(job);
        deps.log(`[worker] ${job} gecikti, yeniden istendi`);
      }
    } catch (error) {
      deps.log(`[worker] gecikmiş senkron denetimi yapılamadı: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
