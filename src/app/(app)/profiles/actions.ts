"use server";

import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { triageInputsChanged } from "@/analysis/profile-inputs";
import { getDb } from "@/db";
import { categories, criteriaProfiles } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";
import { previewRules, rematch, type PreviewResult } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";

const payloadSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2, "Profil adı en az 2 karakter olmalı").max(100, "Profil adı en fazla 100 karakter olabilir"),
  active: z.boolean(),
  rules: profileRulesSchema,
});

export type SaveProfileState =
  | { status: "idle" }
  | { status: "saved"; message: string }
  | { status: "error"; message: string; fieldErrors: Record<string, string> };

function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    // rules.cpvInclude.2 -> cpvInclude
    const key = issue.path.filter((p) => typeof p === "string" && p !== "rules").join(".") || "form";
    errors[key] ??= issue.message;
  }
  return errors;
}

/** Creates or updates a profile, then re-matches it against open tenders. */
export async function saveProfile(_prev: SaveProfileState, formData: FormData): Promise<SaveProfileState> {
  await requireUser();
  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return { status: "error", message: "Form okunamadı.", fieldErrors: {} };
  }
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return { status: "error", message: "Formda düzeltilmesi gereken alanlar var.", fieldErrors: fieldErrors(parsed.error) };
  }
  const { id, name, active, rules } = parsed.data;
  const db = getDb();

  // An unknown category would silently drop its CPV prefixes, and with no
  // other topic rule the profile would match everything.
  if (rules.categoryIds.length) {
    const known = new Set((await db.select({ id: categories.id }).from(categories)).map((c) => c.id));
    if (rules.categoryIds.some((categoryId) => !known.has(categoryId))) {
      return { status: "error", message: "Seçilen kategorilerden biri artık yok.", fieldErrors: { categoryIds: "Kategoriyi yeniden seçin." } };
    }
  }

  let profileId = id;
  if (profileId) {
    const [existing] = await db
      .select({ name: criteriaProfiles.name, rules: criteriaProfiles.rules })
      .from(criteriaProfiles)
      .where(eq(criteriaProfiles.id, profileId));
    if (!existing) return { status: "error", message: "Profil bulunamadı.", fieldErrors: {} };
    const before = profileRulesSchema.safeParse(existing.rules);
    // Only edits that change what triage reads ask for a new AI pre-assessment of the open matches.
    const retriage = !before.success || triageInputsChanged({ name: existing.name, rules: before.data }, { name, rules });
    const updated = await db
      .update(criteriaProfiles)
      .set({ name, active, rules, ...(retriage ? { triageInputsChangedAt: sql`now()` } : {}) })
      .where(eq(criteriaProfiles.id, profileId))
      .returning({ id: criteriaProfiles.id });
    if (!updated.length) return { status: "error", message: "Profil bulunamadı.", fieldErrors: {} };
  } else {
    const [created] = await db.insert(criteriaProfiles).values({ name, active, rules }).returning({ id: criteriaProfiles.id });
    profileId = created?.id;
  }
  if (!profileId) return { status: "error", message: "Profil kaydedilemedi.", fieldErrors: {} };

  const stats = await rematch(db, { profileIds: [profileId] });
  if (!id) redirect(`/profiles/${profileId}?saved=1`);
  return {
    status: "saved",
    message: active
      ? `Kaydedildi. Teklif verilebilir ${stats.matched} ihale eşleşiyor (${stats.created} yeni).`
      : "Kaydedildi. Profil pasif olduğu için yeni eşleşme aranmıyor.",
  };
}

export type PreviewState = { status: "ok"; result: PreviewResult } | { status: "invalid"; message: string };

/** Live preview for the profile form: how the rules would have done over the last 30 days. */
export async function previewProfile(rules: unknown): Promise<PreviewState> {
  await requireUser();
  const parsed = profileRulesSchema.safeParse(rules);
  if (!parsed.success) {
    return { status: "invalid", message: parsed.error.issues[0]?.message ?? "Kurallar geçersiz." };
  }
  return { status: "ok", result: await previewRules(getDb(), parsed.data) };
}
