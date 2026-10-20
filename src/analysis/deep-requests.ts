import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { deepRequests } from "@/db/schema";
import { DEEP_STALE_MINUTES } from "./deep-limits";

// The queue of deep analyses (SPEC 7.2): the tender page asks for one, a
// profile with autoAnalyze asks for its matches; the worker takes them one by
// one. A tender has at most one open request (deep_requests_open_idx).

export type DeepRequest = typeof deepRequests.$inferSelect;

/**
 * Asks for a tender's deep analysis; a request already open stands (true
 * when this call queued one). `by`: the team member's email, or null for a
 * profile's automatic analysis.
 */
export async function requestDeepAnalysis(db: AppDb, tenderId: string, by: string | null): Promise<boolean> {
  const rows = await db.insert(deepRequests).values({ tenderId, requestedBy: by }).onConflictDoNothing().returning({ id: deepRequests.id });
  return rows.length > 0;
}



/**
 * Takes the oldest queued request (manual ones before automatic ones), or one
 * a dead run left running, and marks it running; null when there is none.
 * `manualOnly`: only requests a team member made (past the month's budget).
 */
export async function claimDeepRequest(db: AppDb, options: { manualOnly?: boolean } = {}): Promise<DeepRequest | null> {
  // Another run may take the one picked first: then the next one.
  for (let tries = 0; tries < 3; tries++) {
    const claimed = await claimOnce(db, options);
    if (claimed !== "lost") return claimed;
  }
  return null;
}

async function claimOnce(db: AppDb, options: { manualOnly?: boolean }): Promise<DeepRequest | null | "lost"> {
  const [next] = await db
    .select({ id: deepRequests.id })
    .from(deepRequests)
    .where(
      and(
        sql`(${deepRequests.status} = 'queued'
          or (${deepRequests.status} = 'running' and ${deepRequests.startedAt} < now() - make_interval(mins => ${DEEP_STALE_MINUTES})))`,
        options.manualOnly ? sql`${deepRequests.requestedBy} is not null` : undefined,
      ),
    )
    .orderBy(sql`${deepRequests.requestedBy} is null`, asc(deepRequests.requestedAt))
    .limit(1);
  if (!next) return null;
  const [claimed] = await db
    .update(deepRequests)
    .set({ status: "running", startedAt: sql`now()`, error: null })
    .where(
      and(
        eq(deepRequests.id, next.id),
        sql`(${deepRequests.status} = 'queued'
          or (${deepRequests.status} = 'running' and ${deepRequests.startedAt} < now() - make_interval(mins => ${DEEP_STALE_MINUTES})))`,
      ),
    )
    .returning();
  return claimed ?? "lost";
}

/** Ends a request: done with the analysis it gave, or failed with why. */
export async function finishDeepRequest(db: AppDb, id: string, result: { analysisId: string } | { error: string }): Promise<void> {
  await db
    .update(deepRequests)
    .set(
      "analysisId" in result
        ? { status: "done", finishedAt: sql`now()`, analysisId: result.analysisId, error: null }
        : { status: "failed", finishedAt: sql`now()`, error: result.error },
    )
    .where(eq(deepRequests.id, id));
}

/** The latest request of each of the tenders. */
export async function latestDeepRequests(db: AppDb, tenderIds: readonly string[]): Promise<Map<string, DeepRequest>> {
  if (!tenderIds.length) return new Map();
  const rows = await db
    .selectDistinctOn([deepRequests.tenderId])
    .from(deepRequests)
    .where(inArray(deepRequests.tenderId, [...tenderIds]))
    .orderBy(deepRequests.tenderId, sql`${deepRequests.requestedAt} desc`);
  return new Map(rows.map((r) => [r.tenderId, r]));
}

export { DEEP_STALE_MINUTES };
