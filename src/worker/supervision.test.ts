import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { afterExit, exitText, FIRST_DELAY_MS, HEALTHY_RUN_MS, KILL_AFTER_MS, MAX_DELAY_MS, supervise } from "./supervision";
import { STUCK_EXIT_CODE } from "./watchdog";

// The supervisor with a fake worker and a fake clock: when it starts the worker again and after how long, and
// how a stop reaches the worker.

describe("afterExit", () => {
  const exit = (fields: Partial<Parameters<typeof afterExit>[0]>) => ({ code: STUCK_EXIT_CODE, signal: null, ranMs: 60_000, stopping: false, ...fields });

  it("starts the worker again after the watchdog's exit or a crash, with a pause that doubles while it keeps failing", () => {
    expect(afterExit(exit({}), 0)).toEqual({ restart: true, delayMs: FIRST_DELAY_MS });
    expect(afterExit(exit({ code: 1 }), FIRST_DELAY_MS)).toEqual({ restart: true, delayMs: 2 * FIRST_DELAY_MS });
    expect(afterExit(exit({ code: null, signal: "SIGKILL" }), MAX_DELAY_MS)).toEqual({ restart: true, delayMs: MAX_DELAY_MS });
    // A worker that ran a while was healthy: the pause starts small again.
    expect(afterExit(exit({ ranMs: HEALTHY_RUN_MS }), MAX_DELAY_MS)).toEqual({ restart: true, delayMs: FIRST_DELAY_MS });
  });

  it("does not start it again after a stop it was asked for", () => {
    expect(afterExit(exit({ code: 0 }), 0)).toEqual({ restart: false });
    expect(afterExit(exit({ stopping: true }), 0)).toEqual({ restart: false });
  });

  it("says why it starts the worker again", () => {
    expect(exitText({ code: STUCK_EXIT_CODE, signal: null })).toBe("bekçi takıldığını gördü");
    expect(exitText({ code: 1, signal: null })).toBe("kod 1 ile çıktı");
    expect(exitText({ code: null, signal: "SIGKILL" })).toBe("SIGKILL sinyaliyle bitti");
  });
});

/** A worker process that exits when told to, and records the signals it gets. */
class FakeWorker extends EventEmitter {
  exitCode: number | null = null;
  signals: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }
  end(code: number | null, signal: string | null = null) {
    this.exitCode = code ?? 1;
    this.emit("exit", code, signal);
  }
}

function setup() {
  let clock = 0;
  const workers: FakeWorker[] = [];
  const timers: { fn: () => void; at: number }[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  const stop = supervise({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as never;
    },
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    setTimer: (fn, ms) => timers.push({ fn, at: clock + ms }),
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock) timer.fn();
      else timers.push(timer);
    }
  };
  return { workers, logs, exits, stop, advance };
}

describe("supervise", () => {
  it("starts the worker again after the watchdog stops it, and says so", () => {
    const { workers, logs, exits, advance } = setup();
    expect(workers).toHaveLength(1);
    advance(60_000);
    workers[0]!.end(STUCK_EXIT_CODE);
    expect(logs).toEqual(["[supervisor] worker bekçi takıldığını gördü; 5 sn sonra yeniden başlıyor"]);
    advance(FIRST_DELAY_MS - 1);
    expect(workers).toHaveLength(1);
    advance(1);
    expect(workers).toHaveLength(2);
    expect(exits).toEqual([]);
  });

  it("passes a stop to the worker, ends when it stops, and kills one that does not", () => {
    const first = setup();
    first.stop("SIGINT");
    expect(first.workers[0]!.signals).toEqual(["SIGINT"]);
    first.workers[0]!.end(0);
    expect(first.exits).toEqual([0]);

    const stuck = setup();
    stuck.stop("SIGTERM");
    stuck.advance(KILL_AFTER_MS);
    expect(stuck.workers[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // Killed while stopping: not started again.
    stuck.workers[0]!.end(null, "SIGKILL");
    expect(stuck.exits).toEqual([0]);
    expect(stuck.workers).toHaveLength(1);
  });

  it("ends at once when stopped between a worker's exit and its next start", () => {
    const { workers, exits, stop } = setup();
    workers[0]!.end(1);
    stop("SIGINT");
    expect(exits).toEqual([0]);
  });
});
