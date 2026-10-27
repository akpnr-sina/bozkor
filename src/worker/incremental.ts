import type { AppDb } from "@/db";
import { sources } from "@/db/schema";
import { toZonedLocal } from "@/lib/time";
import { rematch, type RematchStats } from "@/matching/apply";
import { assessTenders, type AssessStats } from "@/policy/assess";
import { databaseNow } from "@/sources/store";
import { fillValueEur, type ValueEurStats } from "@/sources/value-eur";

// What the worker keeps between runs so that periodic work reads only what
// changed: the database is on Supabase's free plan, where every byte a query
// returns counts against the monthly egress quota (5 GB).

/**
 * Writes are stamped with the start of their transaction (now()), so one that
 * began before a run read the tenders and committed after it must still fall
 * in the next run's window. Tender writes take a second or two and both stamps
 * come from the database clock; a wider margin made each run judge the tail of
 * the run before again (2,488 tenders after a large TED sync).
 */
export const WRITE_MARGIN_MS = 2 * 60_000;

/** More changed EUR values than this (a first load of rates) go to a full matching run, not a list of ids. */
export const MAX_CHANGED_IDS = 5_000;

/**
 * Up to when earlier worker processes matched what they wrote, read when the
 * worker starts, before its own syncs move it. Every tender a sync writes is
 * stamped after the sync's start, which last_synced_at keeps, so the oldest of
 * them bounds the writes whose matching a stop may have cut off (during a sync
 * or right after it). Null while a source has never synced.
 */
export async function matchedThroughAtStart(db: AppDb): Promise<Date | null> {
  const rows = await db.select({ lastSyncedAt: sources.lastSyncedAt }).from(sources);
  if (!rows.length || rows.some((r) => r.lastSyncedAt === null)) return null;
  return new Date(Math.min(...rows.map((r) => r.lastSyncedAt!.getTime())));
}

export type TenderChangeStats = {
  /** Whether matching judged every open tender. */
  full: boolean;
  value: ValueEurStats;
  match: RematchStats;
  assess: AssessStats;
};

/**
 * What follows tender writes (a sync, new ECB rates): EUR values first, so
 * value filters see fresh values, then matching, then the verdicts of changed
 * tenders with facts. Each run judges the tenders written since the last run
 * that finished, and those whose EUR value changed; the first run of a process
 * those since `handledThrough` (see matchedThroughAtStart), or every open
 * tender without it. A full matching run reads every open tender with its lots
 * (about 32 MB in October 2026); a later run a few KB. A change to the
 * matching code needs `pnpm rematch`.
 *
 * `recheckValues`: check every EUR value, not only those of recent writes
 * (new rates can change the value of a tender written before them).
 */
export function createTenderChanges(options: { log?: (message: string) => void; marginMs?: number; handledThrough?: Date | null } = {}) {
  const margin = options.marginMs ?? WRITE_MARGIN_MS;
  const processStartedAt = new Date();
  let handledThrough = options.handledThrough ?? null;
  // One run at a time (matching takes a database lock anyway), so the two
  // syncs a starting worker runs do not both judge every open tender.
  let previous: Promise<unknown> = Promise.resolve();
  return function afterTenderChanges(db: AppDb, run: { recheckValues?: boolean } = {}): Promise<TenderChangeStats> {
    const result = previous.then(() => handle(db, run));
    previous = result.catch(() => {});
    return result;
  };

  async function handle(db: AppDb, run: { recheckValues?: boolean }): Promise<TenderChangeStats> {
    const runStartedAt = await databaseNow(db);
    const since = handledThrough ? new Date(handledThrough.getTime() - margin) : null;
    const value = await fillValueEur(db, since && !run.recheckValues ? { since } : {});
    const full = !since || value.changedIds.length > MAX_CHANGED_IDS;
    const match = await rematch(db, full ? { log: options.log } : { changedSince: since, tenderIds: value.changedIds, log: options.log });
    // The assess job assesses every tender when the process starts; this covers what was written after.
    const assess = await assessTenders(db, {
      changedSince: since ?? new Date(processStartedAt.getTime() - margin),
      tenderIds: value.changedIds,
      log: options.log,
    });
    if (!handledThrough || runStartedAt > handledThrough) handledThrough = runStartedAt;
    return { full, value, match, assess };
  }
}

/** The calendar day in Istanbul, "YYYY-MM-DD". */
const istanbulDate = (instant: Date) => toZonedLocal(instant, "Europe/Istanbul").slice(0, 10);

/**
 * Runs `work` on the first call of a process and then on the first call of
 * each Istanbul day; the other calls do nothing (false). A run that fails is
 * tried again on the next call.
 */
export function onceADay(work: () => Promise<void>, now: () => Date = () => new Date()): () => Promise<boolean> {
  let lastDay: string | null = null;
  return async () => {
    const day = istanbulDate(now());
    if (day === lastDay) return false;
    await work();
    lastDay = day;
    return true;
  };
}
