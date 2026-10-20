"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { requestDeepAnalysis } from "@/analysis/deep-requests";
import { getDb } from "@/db";
import { tenders } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";

// Server action of the deep analysis card (SPEC 7.2): the team asks for a
// tender's analysis; the worker takes the queue in order. A manual request
// runs past the monthly budget too (CLAUDE.md rule 7); the card warns.

export type DeepRequestResult = { ok: true; queued: boolean } | { ok: false; error: string };

/** Queues the tender's deep analysis, asked by the signed-in user; `queued` is false when a request is open already. */
export async function requestDeep(tenderId: string): Promise<DeepRequestResult> {
  const user = await requireUser();
  const parsed = z.uuid().safeParse(tenderId);
  if (!parsed.success) return { ok: false, error: "Geçersiz istek. Sayfayı yenileyip tekrar deneyin." };
  const db = getDb();
  const [tender] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.id, parsed.data));
  if (!tender) return { ok: false, error: "İhale bulunamadı." };
  const queued = await requestDeepAnalysis(db, tender.id, user.email);
  refresh();
  return { ok: true, queued };
}
