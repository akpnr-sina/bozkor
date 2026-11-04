// Whether the worker still runs its jobs (the lasting fix the user chose on 4 November 2026). After a sleep or
// a network change the worker could stay up with broken connections and start no job for hours while a new
// process connected at once (CLAUDE.md, worker notes): pg-boss's polls and cron passes failed, and someone had
// to restart it. The watchdog notes every job a handler starts and every sync the overdue watch asks for
// again. When no job has started for 20 minutes of wakeful time, or a sync asked for again has not started
// within 20 minutes, the worker exits with STUCK_EXIT_CODE and whatever runs it starts it afresh (supervise.ts
// here, the host elsewhere). Jobs run every minute, so 20 quiet minutes are no long batch. A gap between
// ticks longer than a few minutes is the Mac asleep, not a stuck worker: the clock starts again.

/** The worker's exit code when the watchdog stops it (EX_TEMPFAIL): start it again. */
export const STUCK_EXIT_CODE = 75;
export const STUCK_AFTER_MS = 20 * 60_000;
const TICK_MS = 60_000;
/** Ticks further apart than this mean the process was suspended (the Mac asleep). */
const SLEEP_GAP_MS = 3 * TICK_MS;

export type Watchdog = {
  /** A handler started a job of this name. */
  started: (job: string, at?: Date) => void;
  /** The overdue watch asked for this job again. */
  requested: (job: string, at?: Date) => void;
  /** Why the worker is stuck at `now`, or null. */
  tick: (now: Date) => string | null;
};

const minutes = (ms: number) => Math.round(ms / 60_000);

export function createWatchdog(start: Date): Watchdog {
  let lastStart = start.getTime();
  let lastTick = start.getTime();
  /** Jobs asked for again and not started since, with when they were first asked for. */
  const asked = new Map<string, number>();
  return {
    started(job, at = new Date()) {
      lastStart = Math.max(lastStart, at.getTime());
      asked.delete(job);
    },
    requested(job, at = new Date()) {
      if (!asked.has(job)) asked.set(job, at.getTime());
    },
    tick(now) {
      const t = now.getTime();
      if (t - lastTick > SLEEP_GAP_MS) {
        // Asleep: nothing could start. The jobs get their time again after waking.
        lastStart = t;
        for (const job of asked.keys()) asked.set(job, t);
      }
      lastTick = t;
      if (t - lastStart >= STUCK_AFTER_MS) return `${minutes(t - lastStart)} dakikadır hiçbir iş başlamadı`;
      for (const [job, at] of asked) {
        if (t - at >= STUCK_AFTER_MS) return `${job} yeniden istendi, ${minutes(t - at)} dakikadır başlamadı`;
      }
      return null;
    },
  };
}

/** Ticks every minute and calls onStuck once, when the worker is stuck. Returns a function that stops the watch. */
export function watchWorker(watchdog: Watchdog, onStuck: (reason: string) => void, now: () => Date = () => new Date()): () => void {
  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    const reason = watchdog.tick(now());
    if (!reason) return;
    fired = true;
    onStuck(reason);
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
