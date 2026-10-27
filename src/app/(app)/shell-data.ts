import { count, eq } from "drizzle-orm";
import { io } from "next/cache";
import { cache } from "react";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { criteriaProfiles, sources } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { loadInbox, readFilters } from "./inbox/data";
import { syncState } from "./sync-state";

export { SYNC_DOT, syncState, syncText, type SyncState } from "./sync-state";

/** What the menu and the top bar show, read once per request: the menu's counts, the sources' health, the user. */
export const loadShell = cache(async () => {
  const user = await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const now = new Date();
  const { inboxTotal, activeProfiles, sourceRows } = await retryRead(async () => {
    const db = getDb();
    const [inbox, [active], rows] = await Promise.all([
      // The inbox's default view: what the team should look at.
      loadInbox(db, readFilters({}), 1),
      db.select({ n: count() }).from(criteriaProfiles).where(eq(criteriaProfiles.active, true)),
      db.select({ id: sources.id, lastSyncedAt: sources.lastSyncedAt, lastError: sources.lastError }).from(sources),
    ]);
    return { inboxTotal: inbox.total, activeProfiles: active?.n ?? 0, sourceRows: rows };
  });
  const counts: Record<string, number> = { "/inbox": inboxTotal, "/profiles": activeProfiles, "/sources": sourceRows.length };
  return { user, now, counts, sync: syncState(sourceRows, now) };
});
