import type { ChildProcess } from "node:child_process";
import { STUCK_EXIT_CODE } from "./watchdog";

// Keeps the worker running on the Mac (`pnpm worker:supervised`): starts it, and starts it again when it exits
// on its own, the watchdog's exit or a crash, after a pause that grows while it keeps failing. A stop it is
// asked for (SIGINT or SIGTERM to this process) stops the worker too and ends here; a worker that does not stop
// in 40 seconds is killed, as broken connections can hold a graceful stop. On a host that restarts crashed
// processes itself the worker runs alone.

export const FIRST_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 10 * 60_000;
/** A worker that ran this long was healthy: the pause starts small again. */
export const HEALTHY_RUN_MS = 10 * 60_000;
export const KILL_AFTER_MS = 40_000;

export type WorkerExit = { code: number | null; signal: string | null; ranMs: number; stopping: boolean };

/** After the worker exits: whether to start it again, and after how long. Exit code 0 is a stop it was asked for. */
export function afterExit(exit: WorkerExit, previousDelayMs: number): { restart: false } | { restart: true; delayMs: number } {
  if (exit.stopping || exit.code === 0) return { restart: false };
  const delayMs = exit.ranMs >= HEALTHY_RUN_MS || previousDelayMs <= 0 ? FIRST_DELAY_MS : Math.min(previousDelayMs * 2, MAX_DELAY_MS);
  return { restart: true, delayMs };
}

/** How the supervisor says why it starts the worker again. */
export function exitText(exit: Pick<WorkerExit, "code" | "signal">): string {
  if (exit.code === STUCK_EXIT_CODE) return "bekçi takıldığını gördü";
  return exit.signal ? `${exit.signal} sinyaliyle bitti` : `kod ${exit.code} ile çıktı`;
}

export type SuperviseDeps = {
  spawn: () => Pick<ChildProcess, "kill" | "exitCode" | "once">;
  log: (message: string) => void;
  exit: (code: number) => void;
  setTimer: (fn: () => void, ms: number) => void;
  now?: () => number;
};

/** Starts the worker and keeps it running; returns the stop to call on SIGINT or SIGTERM. */
export function supervise(deps: SuperviseDeps): (signal: NodeJS.Signals) => void {
  const now = deps.now ?? (() => Date.now());
  let child: ReturnType<SuperviseDeps["spawn"]> | null = null;
  let stopping = false;
  let delay = 0;

  const start = () => {
    const startedAt = now();
    const current = deps.spawn();
    child = current;
    current.once("exit", (code: number | null, signal: string | null) => {
      const next = afterExit({ code, signal, ranMs: now() - startedAt, stopping }, delay);
      if (!next.restart) {
        deps.exit(0);
        return;
      }
      delay = next.delayMs;
      deps.log(`[supervisor] worker ${exitText({ code, signal })}; ${Math.round(delay / 1000)} sn sonra yeniden başlıyor`);
      deps.setTimer(start, delay);
    });
  };

  start();
  return (signal) => {
    stopping = true;
    if (!child || child.exitCode !== null) {
      deps.exit(0);
      return;
    }
    const current = child;
    current.kill(signal);
    deps.setTimer(() => {
      if (current.exitCode === null) current.kill("SIGKILL");
    }, KILL_AFTER_MS);
  };
}
