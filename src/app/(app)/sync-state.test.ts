import { describe, expect, it } from "vitest";
import { syncState, syncText } from "./sync-state";

const now = new Date("2026-10-20T15:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60_000);

describe("syncState", () => {
  it("is fine when every source synced within its schedule", () => {
    const state = syncState(
      [
        { id: "uk_fat", lastSyncedAt: hoursAgo(1), lastError: null },
        { id: "eu_ted", lastSyncedAt: hoursAgo(20), lastError: null },
      ],
      now,
    );
    expect(state).toEqual({ tone: "ok", sources: 2, failing: 0, late: 0, lastSyncedAt: hoursAgo(1) });
    expect(syncText(state)).toBe("2 kaynak izleniyor");
  });

  it("is late past a source's schedule (Find a Tender after 6 hours, TED after 26) or when it never synced", () => {
    expect(syncState([{ id: "uk_fat", lastSyncedAt: hoursAgo(7), lastError: null }], now)).toMatchObject({ tone: "warn", late: 1 });
    expect(syncState([{ id: "eu_ted", lastSyncedAt: hoursAgo(20), lastError: null }], now)).toMatchObject({ tone: "ok", late: 0 });
    expect(syncState([{ id: "eu_ted", lastSyncedAt: hoursAgo(27), lastError: null }], now)).toMatchObject({ tone: "warn", late: 1 });
    const never = syncState([{ id: "uk_fat", lastSyncedAt: null, lastError: null }], now);
    expect(never).toMatchObject({ tone: "warn", late: 1, lastSyncedAt: null });
    expect(syncText(never)).toBe("1 kaynakta senkron gecikti");
  });

  it("says an error first", () => {
    const state = syncState(
      [
        { id: "uk_fat", lastSyncedAt: hoursAgo(9), lastError: null },
        { id: "eu_ted", lastSyncedAt: hoursAgo(1), lastError: "429" },
      ],
      now,
    );
    expect(state).toMatchObject({ tone: "err", failing: 1, late: 1 });
    expect(syncText(state)).toBe("1 kaynakta hata");
  });
});
