import "@/lib/load-env";
import { configureDb } from "@/db";
import { createBoss } from "./boss";
import { registerJobs } from "./jobs";
import { createWatchdog, STUCK_EXIT_CODE, watchWorker } from "./watchdog";

/** A stop the watchdog asks for gets this long before the process goes, whatever its connections do. */
const STUCK_STOP_MS = 20_000;

async function main() {
  // Jobs run every minute: their connections stay open in between (src/db/index.ts).
  configureDb({ idleTimeoutSeconds: 5 * 60 });
  const boss = createBoss();
  boss.on("error", (error) => console.error("[pg-boss]", error));

  await boss.start();
  console.log("[worker] connected to pg-boss");
  const watchdog = createWatchdog(new Date());
  await registerJobs(boss, watchdog);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, stopping`);
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // A worker that starts no job is restarted by whatever runs it (src/worker/watchdog.ts).
  watchWorker(watchdog, (reason) => {
    if (stopping) return;
    stopping = true;
    console.error(`[watchdog] ${reason}; worker yeniden başlatılmak üzere kapanıyor`);
    setTimeout(() => process.exit(STUCK_EXIT_CODE), STUCK_STOP_MS).unref();
    void boss
      .stop({ graceful: false })
      .catch(() => {})
      .finally(() => process.exit(STUCK_EXIT_CODE));
  });
}

main().catch((error: unknown) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
