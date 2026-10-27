import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { criteriaProfiles } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";

export type ProfileActiveResult = { status: "saved"; active: boolean; message: string } | { status: "error"; message: string };

/**
 * Turns a profile on or off as saving its form with only that changed does
 * (saveProfile): the flag, with updated_at, then a re-match of the profile.
 * Turned on, the open tenders it wants are matched; turned off, nothing new
 * is matched and what it matched stays as it was. Name and rules stay, so
 * triage is not asked again.
 */
export async function setProfileActive(db: AppDb, profileId: string, active: boolean): Promise<ProfileActiveResult> {
  const [profile] = await db
    .update(criteriaProfiles)
    .set({ active })
    .where(eq(criteriaProfiles.id, profileId))
    .returning({ rules: criteriaProfiles.rules });
  if (!profile) return { status: "error", message: "Profil bulunamadı." };

  const stats = await rematch(db, { profileIds: [profileId] });
  if (!active) return { status: "saved", active, message: "Pasif yapıldı; yeni eşleşme aranmıyor." };
  // Matching skips a profile whose stored rules no longer pass the schema (readStoredRules shows why).
  if (!profileRulesSchema.safeParse(profile.rules).success) {
    return { status: "saved", active, message: "Aktif yapıldı, ama kuralları geçersiz olduğu için eşleştirmede kullanılmıyor. Profili düzeltin." };
  }
  return { status: "saved", active, message: `Aktif yapıldı. Teklif verilebilir ${stats.matched} ihale eşleşiyor (${stats.created} yeni).` };
}
