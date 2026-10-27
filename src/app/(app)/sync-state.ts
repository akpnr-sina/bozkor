// The sources' health as the menu, the top bar and the sources page show it.

const HOUR_MS = 60 * 60_000;
/** A source is late past about twice its schedule (Find a Tender every 2 hours, TED twice a day). */
const LATE_AFTER_MS: Record<string, number> = { uk_fat: 6 * HOUR_MS, eu_ted: 26 * HOUR_MS };

export type SyncState = {
  tone: "ok" | "warn" | "err";
  sources: number;
  /** Sources whose last run ended with an error. */
  failing: number;
  /** Sources not synced for longer than their schedule allows (the worker stopped, say). */
  late: number;
  lastSyncedAt: Date | null;
};

export function syncState(rows: readonly { id: string; lastSyncedAt: Date | null; lastError: string | null }[], now: Date): SyncState {
  const failing = rows.filter((row) => row.lastError).length;
  const late = rows.filter(
    (row) => !row.lastSyncedAt || now.getTime() - row.lastSyncedAt.getTime() > (LATE_AFTER_MS[row.id] ?? 26 * HOUR_MS),
  ).length;
  const times = rows.flatMap((row) => (row.lastSyncedAt ? [row.lastSyncedAt.getTime()] : []));
  return {
    tone: failing ? "err" : late ? "warn" : "ok",
    sources: rows.length,
    failing,
    late,
    lastSyncedAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

/** The square status dot of the source health, with its soft ring. */
export const SYNC_DOT: Record<SyncState["tone"], string> = {
  ok: "bg-ok shadow-[0_0_0_3px_rgba(63,122,85,0.22)]",
  warn: "bg-warn shadow-[0_0_0_3px_rgba(138,98,22,0.25)]",
  err: "bg-err shadow-[0_0_0_3px_rgba(166,61,42,0.28)]",
};

export function syncText(sync: SyncState): string {
  if (sync.failing) return `${sync.failing} kaynakta hata`;
  if (sync.late) return `${sync.late} kaynakta senkron gecikti`;
  return `${sync.sources} kaynak izleniyor`;
}
