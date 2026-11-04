import { afterEach, describe, expect, it, vi } from "vitest";
import { createWatchdog, STUCK_AFTER_MS, watchWorker } from "./watchdog";

// The watchdog on a made-up clock: a worker whose jobs start is fine, one that starts none for 20 minutes of
// wakeful time is stuck, a sleep restarts the clock, and a sync asked for again must start in time.

const T0 = new Date("2026-11-04T16:12:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
/** Ticks every minute from `from` to `to`, as the timer would; the first reason, or null. */
function tickThrough(watchdog: ReturnType<typeof createWatchdog>, from: number, to: number): string | null {
  for (let m = from; m <= to; m++) {
    const reason = watchdog.tick(at(m));
    if (reason) return `${m}: ${reason}`;
  }
  return null;
}

describe("createWatchdog", () => {
  it("is fine while jobs start, and stuck after 20 minutes without one", () => {
    const watchdog = createWatchdog(T0);
    watchdog.started("process-documents", at(5));
    expect(tickThrough(watchdog, 1, 24)).toBeNull();
    expect(tickThrough(watchdog, 25, 30)).toBe("25: 20 dakikadır hiçbir iş başlamadı");
    expect(STUCK_AFTER_MS).toBe(20 * 60_000);
  });

  it("starts the clock again after a sleep, then still sees a worker that never recovers", () => {
    const watchdog = createWatchdog(T0);
    expect(tickThrough(watchdog, 1, 10)).toBeNull();
    // Three hours asleep: the next tick is no stuck worker.
    expect(watchdog.tick(at(190))).toBeNull();
    expect(tickThrough(watchdog, 191, 209)).toBeNull();
    expect(tickThrough(watchdog, 210, 215)).toBe("210: 20 dakikadır hiçbir iş başlamadı");
  });

  it("is stuck when a sync asked for again has not started in 20 minutes, whatever else runs", () => {
    const watchdog = createWatchdog(T0);
    watchdog.requested("sync-uk-fat", at(0));
    // Asked for again ten minutes later: the first time counts.
    watchdog.requested("sync-uk-fat", at(10));
    for (let m = 1; m <= 25; m++) watchdog.started("process-documents", at(m));
    expect(tickThrough(watchdog, 1, 19)).toBeNull();
    expect(watchdog.tick(at(20))).toBe("sync-uk-fat yeniden istendi, 20 dakikadır başlamadı");
  });

  it("forgets a sync once it starts", () => {
    const watchdog = createWatchdog(T0);
    watchdog.requested("sync-eu-ted", at(0));
    watchdog.started("sync-eu-ted", at(12));
    for (let m = 1; m <= 30; m++) watchdog.started("deep-analysis", at(m));
    expect(tickThrough(watchdog, 1, 30)).toBeNull();
  });
});

describe("watchWorker", () => {
  afterEach(() => vi.useRealTimers());

  it("calls onStuck once, on the minute the worker is found stuck", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const onStuck = vi.fn();
    const stop = watchWorker(createWatchdog(T0), onStuck);
    vi.advanceTimersByTime(19 * 60_000);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(onStuck).toHaveBeenCalledWith("20 dakikadır hiçbir iş başlamadı");
    vi.advanceTimersByTime(10 * 60_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    stop();
  });
});
