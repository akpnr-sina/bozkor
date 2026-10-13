import { profileRulesSchema, type ProfileRules } from "@/matching/rules";

const FIELD_LABELS: Record<string, string> = {
  description: "Açıklama",
  sources: "Kaynaklar",
  noticeTypes: "İlan türleri",
  categoryIds: "Kategoriler",
  cpvInclude: "CPV önekleri",
  cpvExclude: "Hariç CPV önekleri",
  keywordsAny: "Anahtar kelimeler",
  keywordsAll: "Zorunlu kelimeler",
  keywordsNone: "İstenmeyen kelimeler",
  countries: "Ülkeler",
  valueMinEur: "En düşük tutar",
  valueMaxEur: "En yüksek tutar",
  includeUnknownValue: "Tutarı bilinmeyenler",
  minDaysToDeadline: "Son tarihe kalan gün",
  regimes: "Rejimler",
  noticeLanguages: "İlan dilleri",
  triageThreshold: "Triage eşiği",
  autoAnalyze: "Otomatik analiz",
  notify: "Bildirim",
  analysisQuestions: "Analiz soruları",
};

export type StoredRules = { rules: ProfileRules; problems: string[] };

/**
 * Reads rules saved by an earlier version, when validation may have been
 * looser. Invalid list items and fields are dropped (fields fall back to
 * their defaults) and reported, instead of replacing all rules with defaults.
 */
export function readStoredRules(raw: unknown): StoredRules {
  const candidate: Record<string, unknown> = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  const problems: string[] = [];

  for (let attempt = 0; attempt < 5; attempt++) {
    const parsed = profileRulesSchema.safeParse(candidate);
    if (parsed.success) return { rules: parsed.data, problems };

    const dropItems = new Map<string, Set<number>>();
    for (const issue of parsed.error.issues) {
      const [key, index] = issue.path;
      if (typeof key !== "string") continue;
      const value = Array.isArray(candidate[key]) && typeof index === "number" ? (candidate[key] as unknown[])[index] : undefined;
      problems.push(`${FIELD_LABELS[key] ?? key}${value !== undefined ? ` "${String(value)}"` : ""}: ${issue.message}`);
      if (typeof index === "number" && Array.isArray(candidate[key])) {
        const indexes = dropItems.get(key) ?? new Set<number>();
        indexes.add(index);
        dropItems.set(key, indexes);
      } else {
        delete candidate[key];
      }
    }
    for (const [key, indexes] of dropItems) {
      candidate[key] = (candidate[key] as unknown[]).filter((_, i) => !indexes.has(i));
    }
  }
  return { rules: profileRulesSchema.parse({}), problems: [...problems, "Kurallar okunamadı; varsayılanlar gösteriliyor."] };
}
