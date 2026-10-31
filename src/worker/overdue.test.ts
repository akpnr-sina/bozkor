import { afterEach, describe, expect, it, vi } from "vitest";
import { overdueSyncJobs, watchOverdueSyncs, type SourceSync } from "./overdue";

const NOW = new Date("2026-10-31T12:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

afterEach(() => {
  vi.useRealTimers();
});

describe("overdueSyncJobs", () => {
  it("asks again for a source that missed its schedule, and only for it", () => {
    expect(overdueSyncJobs([{ id: "uk_fat", lastSyncedAt: ago(2.4) }, { id: "eu_ted", lastSyncedAt: ago(1) }], NOW)).toEqual([]);
    expect(overdueSyncJobs([{ id: "uk_fat", lastSyncedAt: ago(2.6) }, { id: "eu_ted", lastSyncedAt: ago(1) }], NOW)).toEqual(["sync-uk-fat"]);
  });

  it("lets TED sleep through its 18-hour night", () => {
    expect(overdueSyncJobs([{ id: "eu_ted", lastSyncedAt: ago(18.5) }], NOW)).toEqual([]);
    expect(overdueSyncJobs([{ id: "eu_ted", lastSyncedAt: ago(19.5) }], NOW)).toEqual(["sync-eu-ted"]);
  });

  it("counts a source that never synced as overdue, and ignores unknown ones", () => {
    expect(overdueSyncJobs([{ id: "uk_fat", lastSyncedAt: null }, { id: "other", lastSyncedAt: null }], NOW)).toEqual(["sync-uk-fat"]);
  });
});

describe("watchOverdueSyncs", () => {
  it("checks every 10 minutes, sends what is overdue and survives a failed read", async () => {
    vi.useFakeTimers();
    const rows: SourceSync[] = [
      { id: "uk_fat", lastSyncedAt: ago(21) },
      { id: "eu_ted", lastSyncedAt: ago(1) },
    ];
    const read = vi.fn<() => Promise<SourceSync[]>>().mockRejectedValueOnce(new Error("read ECONNRESET")).mockResolvedValue(rows);
    const send = vi.fn(async () => undefined);
    const log = vi.fn();
    const stop = watchOverdueSyncs({ read, send, log, now: () => NOW });

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenLastCalledWith("[worker] gecikmiş senkron denetimi yapılamadı: read ECONNRESET");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send.mock.calls).toEqual([["sync-uk-fat"]]);
    expect(log).toHaveBeenLastCalledWith("[worker] sync-uk-fat gecikti, yeniden istendi");

    stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
