import "@/lib/load-env";
import { configureDb } from "@/db";
import { createBoss } from "./boss";
import { registerJobs } from "./jobs";

async function main() {
  // Jobs run every minute: their connections stay open in between (src/db/index.ts).
  configureDb({ idleTimeoutSeconds: 5 * 60 });
  const boss = createBoss();
  boss.on("error", (error) => console.error("[pg-boss]", error));

  await boss.start();
  console.log("[worker] connected to pg-boss");
  await registerJobs(boss);

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
}

main().catch((error: unknown) => {
  console.error("[worker] fatal", error);
  process.exit(1);
});
