import { eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { sources } from "@/db/schema";
import {
  applyProcedures,
  databaseNow,
  emptyApplyStats,
  pendingProcedureKeys,
  storeRawNotices,
  type ApplyStats,
} from "./store";
import type { SourceAdapter, SyncWindow } from "./types";

export type SyncStats = ApplyStats & {
  /** Notices returned by the API, every stage. */
  fetched: number;
  /** Raw rows that were new (not an identical re-fetch). */
  rawInserted: number;
};

export const emptySyncStats = (): SyncStats => ({ ...emptyApplyStats(), fetched: 0, rawInserted: 0 });

export function addStats(total: SyncStats, part: SyncStats): SyncStats {
  return {
    fetched: total.fetched + part.fetched,
    rawInserted: total.rawInserted + part.rawInserted,
    procedures: total.procedures + part.procedures,
    inserted: total.inserted + part.inserted,
    updated: total.updated + part.updated,
    changed: total.changed + part.changed,
    skipped: total.skipped + part.skipped,
    normalizeErrors: total.normalizeErrors + part.normalizeErrors,
  };
}

export type SyncOptions = {
  log?: (message: string) => void;
  /** Called after each API page has been stored and applied. */
  onPage?: (stats: SyncStats) => void;
};

/**
 * Fetches a window page by page, stores every raw notice and re-applies the
 * procedures that received new raw rows. Running the same window again
 * stores and changes nothing.
 */
export async function syncWindow(
  db: AppDb,
  adapter: SourceAdapter,
  window: SyncWindow,
  runStartedAt?: Date,
  options: SyncOptions = {},
): Promise<SyncStats> {
  const startedAt = runStartedAt ?? (await databaseNow(db));
  let stats = emptySyncStats();
  for await (const page of adapter.pages(window)) {
    const rows = page.flatMap((payload) => {
      const keys = adapter.keys(payload);
      return keys ? [{ keys, payload }] : [];
    });
    const stored = await storeRawNotices(db, adapter.id, rows);
    const applied = await applyProcedures(db, adapter.id, stored.procedureKeys, adapter.normalize, startedAt, options.log);
    const pageStats = { ...applied, fetched: page.length, rawInserted: stored.inserted };
    options.onPage?.(pageStats);
    stats = addStats(stats, pageStats);
  }
  return stats;
}

const PENDING_BATCH = 200;

/**
 * Applies raw rows that an earlier, interrupted run stored but never folded
 * in. Without this, re-running a window would skip them: their payloads are
 * already stored, so nothing counts as new.
 */
export async function applyPending(
  db: AppDb,
  adapter: SourceAdapter,
  runStartedAt: Date,
  log?: (message: string) => void,
): Promise<SyncStats> {
  const keys = await pendingProcedureKeys(db, adapter.id);
  let stats = emptySyncStats();
  for (let i = 0; i < keys.length; i += PENDING_BATCH) {
    const applied = await applyProcedures(
      db,
      adapter.id,
      keys.slice(i, i + PENDING_BATCH),
      adapter.normalize,
      runStartedAt,
      log,
    );
    stats = addStats(stats, { ...applied, fetched: 0, rawInserted: 0 });
  }
  return stats;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function recordSuccess(db: AppDb, adapter: SourceAdapter, syncedUpTo: Date, stats: SyncStats): Promise<void> {
  const [current] = await db.select({ cursor: sources.cursor }).from(sources).where(eq(sources.id, adapter.id));
  const previous = current?.cursor ? new Date(current.cursor) : null;
  // The cursor only moves forward, so a short manual run cannot rewind it.
  const cursor = previous && previous > syncedUpTo ? previous : syncedUpTo;
  await db
    .update(sources)
    .set({
      cursor: cursor.toISOString(),
      lastSyncedAt: sql`now()`,
      // Shown on /settings; the details are in the worker or backfill log.
      lastError: stats.normalizeErrors ? `Son senkronda ${stats.normalizeErrors} ilan okunamadı.` : null,
    })
    .where(eq(sources.id, adapter.id));
}

async function recordFailure(db: AppDb, adapter: SourceAdapter, error: unknown): Promise<void> {
  await db
    .update(sources)
    .set({ lastError: errorMessage(error) })
    .where(eq(sources.id, adapter.id))
    .catch(() => undefined);
}

/** How far back each incremental run re-reads, to absorb late indexing and DST shifts. */
export const INCREMENTAL_OVERLAP_MS = 60 * 60_000;
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60_000;

/** Scheduled sync: from the stored cursor (minus overlap) to now. */
export async function syncIncremental(
  db: AppDb,
  adapter: SourceAdapter,
  options: SyncOptions = {},
): Promise<SyncStats & { window: SyncWindow }> {
  const [source] = await db.select({ cursor: sources.cursor }).from(sources).where(eq(sources.id, adapter.id));
  const to = await databaseNow(db);
  const cursor = source?.cursor ? new Date(source.cursor) : null;
  const from =
    cursor && !Number.isNaN(cursor.getTime())
      ? new Date(cursor.getTime() - INCREMENTAL_OVERLAP_MS)
      : new Date(to.getTime() - FIRST_RUN_LOOKBACK_MS);
  const window = { from, to };
  try {
    const recovered = await applyPending(db, adapter, to, options.log);
    const stats = addStats(recovered, await syncWindow(db, adapter, window, to, options));
    await recordSuccess(db, adapter, to, stats);
    return { ...stats, window };
  } catch (error) {
    await recordFailure(db, adapter, error);
    throw error;
  }
}

const DAY_MS = 24 * 60 * 60_000;

/** Loads the last `days` days in one-day windows, oldest first. Safe to re-run. */
export async function backfill(
  db: AppDb,
  adapter: SourceAdapter,
  days: number,
  options: SyncOptions & {
    onWindow?: (window: SyncWindow, stats: SyncStats) => void;
    onRecovered?: (stats: SyncStats) => void;
  } = {},
): Promise<SyncStats> {
  const end = await databaseNow(db);
  const start = new Date(end.getTime() - days * DAY_MS);
  try {
    const recovered = await applyPending(db, adapter, end, options.log);
    if (recovered.procedures || recovered.skipped) options.onRecovered?.(recovered);
    let total = recovered;
    for (let from = start; from < end; from = new Date(from.getTime() + DAY_MS)) {
      const to = new Date(Math.min(from.getTime() + DAY_MS, end.getTime()));
      // One minute of overlap so a notice exactly on a window boundary is not lost.
      const window = { from: new Date(from.getTime() - 60_000), to };
      const stats = await syncWindow(db, adapter, window, end, options);
      options.onWindow?.(window, stats);
      total = addStats(total, stats);
    }
    await recordSuccess(db, adapter, end, total);
    return total;
  } catch (error) {
    await recordFailure(db, adapter, error);
    throw error;
  }
}
