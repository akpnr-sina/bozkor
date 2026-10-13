"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { profileMatches, reviewDecision, tenderReviews, tenders } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";

export type DecisionState =
  | { status: "idle" }
  | { status: "saved"; message: string }
  | { status: "error"; message: string };

const input = z.object({
  tenderId: z.uuid(),
  intent: z.enum(["save", "clear"]),
  decision: z.enum(reviewDecision.enumValues).optional(),
  note: z.string().trim().max(2_000, "Not en fazla 2.000 karakter olabilir"),
});

/**
 * Appends a decision to the tender's history. Withdrawing a decision appends
 * a row with no decision, so the history stays complete (SPEC section 5).
 */
export async function saveDecision(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const user = await requireUser();
  const parsed = input.safeParse({
    tenderId: formData.get("tenderId"),
    intent: formData.get("intent"),
    decision: formData.get("decision") || undefined,
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) {
    // Only the note can be wrong through the form; anything else is a stale or tampered request.
    const issue = parsed.error.issues[0];
    return { status: "error", message: issue?.path[0] === "note" ? issue.message : "Geçersiz istek. Sayfayı yenileyip tekrar deneyin." };
  }
  const { tenderId, intent, decision, note } = parsed.data;
  if (intent === "save" && !decision) {
    return { status: "error", message: "Bir karar seçin." };
  }

  const db = getDb();
  const [tender] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.id, tenderId));
  if (!tender) return { status: "error", message: "İhale bulunamadı." };

  await db.insert(tenderReviews).values({
    tenderId,
    decision: intent === "clear" ? null : decision,
    note: note || null,
    decidedBy: user.email,
  });
  // A decision means the matches have been looked at.
  await db
    .update(profileMatches)
    .set({ state: "seen" })
    .where(and(eq(profileMatches.tenderId, tenderId), eq(profileMatches.state, "new")));

  refresh();
  return { status: "saved", message: intent === "clear" ? "Karar geri alındı." : "Karar kaydedildi." };
}
