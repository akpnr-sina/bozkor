import { and, count, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AppDb } from "@/db";
import { deepRequests, documents } from "@/db/schema";

/**
 * What the tender page waits on while it is open: how many stored files the
 * worker has yet to read (the documents card's "okunuyor"), and the state of
 * the latest deep analysis request. Two small reads, where a refresh of the
 * page reads its facts, analyses and texts again.
 */
export type TenderProgress = {
  reading: number;
  deep: (typeof deepRequests.$inferSelect)["status"] | null;
};

export async function tenderProgress(db: AppDb, tenderId: string): Promise<TenderProgress> {
  const [[files], [request]] = await Promise.all([
    db
      .select({ n: count() })
      .from(documents)
      .where(and(eq(documents.tenderId, tenderId), isNotNull(documents.storagePath), isNull(documents.processedAt))),
    db.select({ status: deepRequests.status }).from(deepRequests).where(eq(deepRequests.tenderId, tenderId)).orderBy(desc(deepRequests.requestedAt)).limit(1),
  ]);
  return { reading: files?.n ?? 0, deep: request?.status ?? null };
}
