import { spawn } from "node:child_process";
import { supervise } from "./supervision";

// `pnpm worker:supervised`: the worker under supervision.ts, started again after the watchdog stops it.
// Stop it with SIGINT or SIGTERM to this process; the worker stops with it.
const stop = supervise({
  // The worker as its own Node process with tsx's loader, so a stop or a kill reaches it directly.
  spawn: () => spawn(process.execPath, ["--import", "tsx", "src/worker/index.ts"], { stdio: "inherit" }),
  log: (message) => console.log(message),
  exit: (code) => process.exit(code),
  setTimer: (fn, ms) => void setTimeout(fn, ms),
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
