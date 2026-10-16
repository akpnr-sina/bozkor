import { z } from "zod";

// Output of the triage prompt (SPEC 7.1), validated with Zod (CLAUDE.md rule 6).
// The same schema is sent to the API as the JSON output format; constraints the
// API does not support (max length, integer range) are checked here only.

/** A claim with the notice text that supports it (CLAUDE.md rule 5). */
const claim = z.object({
  text: z.string().describe("Kısa Türkçe açıklama."),
  quote: z
    .string()
    .describe("İddiayı destekleyen, ilan metninden birebir kopyalanmış kısa alıntı (orijinal dilde). Destekleyen metin yoksa boş."),
});

/**
 * Rubric V2 metrics that the notice alone can speak to (docs/scoring-rubric-v2.md
 * section 4): A1 product fit, C1 local service, C2 installation, C3 warranty and
 * spares, C4 call-off pattern, H2 award criteria fit. G1 (bid window) is
 * computed in code from the deadline (rule 3); the rest need documents,
 * supplier quotes or the cash model.
 */
export const NOTICE_METRICS = ["A1", "C1", "C2", "C3", "C4", "H2"] as const;
export type NoticeMetric = (typeof NOTICE_METRICS)[number];

/**
 * Rubric section 5 evidence states possible from the notice: PROVISIONAL with
 * a rating, MISSING without one, CONFLICT when the notice contradicts itself.
 * Nothing is VERIFIED at this stage.
 */
export const NOTICE_QUALITIES = ["PROVISIONAL", "MISSING", "CONFLICT"] as const;

const metric = z.object({
  rating: z
    .number()
    .int()
    .min(0)
    .max(5)
    .nullable()
    .describe("Rubrik ölçeği 0-5, 5 her zaman iyidir. İlan bu konuda bir şey söylemiyorsa null."),
  quality: z.enum(NOTICE_QUALITIES).describe("İlanda dayanak varsa PROVISIONAL, yoksa MISSING, ilan kendi içinde çelişiyorsa CONFLICT."),
  reason: z.string().describe("Kısa Türkçe gerekçe."),
  quote: z.string().describe("Dayanak alıntı, ilandan birebir ve orijinal dilde; yoksa boş."),
});

/** Rubric section 7 contract conditions the notice may state. */
export const CONDITION_FLAGS = [
  "INSTALLATION_COMMISSIONING",
  "LOCAL_SERVICE_SLA",
  "LONG_WARRANTY",
  "FRAMEWORK_NO_GUARANTEE",
  "SMALL_FREQUENT_ORDERS",
  "MANUFACTURER_AUTHORISATION",
  "BIDDER_CERTIFICATION",
  "PRODUCT_CERTIFICATION",
  "LOCAL_PREMISES",
  "SELECTION_CRITERIA",
  "HIDDEN_SERVICES",
  "BRAND_NO_EQUIVALENT",
  "SAMPLES_REQUIRED",
  "SHORT_DELIVERY",
  "SITE_HANDLING",
  "AWARD_WEIGHTING",
  "VALUE_CONFLICT",
  "GPA_NOT_COVERED",
] as const;
export type ConditionFlag = (typeof CONDITION_FLAGS)[number];

export const triageOutputSchema = z.object({
  relevance: z.number().int().min(0).max(100).describe("Profile uygunluk puanı, 0-100 arası tam sayı."),
  productSummary: z.string().describe("Satın alınan ürünün 1-2 cümlelik Türkçe özeti."),
  reasons: z.array(claim).min(1).max(4).describe("Uygunluk puanının en önemli gerekçeleri."),
  metrics: z
    .object({ A1: metric, C1: metric, C2: metric, C3: metric, C4: metric, H2: metric })
    .describe("Rubrik V2'nin ilandan değerlendirilebilen metrikleri."),
  conditionFlags: z
    .array(z.object({ code: z.enum(CONDITION_FLAGS), text: z.string(), quote: z.string() }))
    .max(10)
    .describe("İlanda yazan sözleşme şartları (rubrik bölüm 7). Yoksa boş liste."),
  quantityHint: claim.describe("İlandaki miktar bilgisi. İlanda yoksa text ve quote boş."),
  missingInfo: z.array(z.string()).max(8).describe("İlanda bulunmayan önemli bilgiler, Türkçe. Tahmin yapılmaz."),
});

export type TriageOutput = z.infer<typeof triageOutputSchema>;
export type TriageClaim = z.infer<typeof claim>;
export type TriageMetric = z.infer<typeof metric>;

/** triage.v1 output, kept so analyses made before rubric V2 still render. */
export const triageV1OutputSchema = z.object({
  relevance: z.number().int().min(0).max(100),
  productSummary: z.string(),
  reasons: z.array(claim).min(1).max(4),
  quantityHint: claim,
  noticeRedFlags: z.array(claim).max(5),
  missingInfo: z.array(z.string()).max(8),
});
export type TriageV1Output = z.infer<typeof triageV1OutputSchema>;

/** A stored triage output of either version, or null when it fits neither. */
export function readTriageOutput(
  output: unknown,
): { version: 2; triage: TriageOutput } | { version: 1; triage: TriageV1Output } | null {
  const v2 = triageOutputSchema.safeParse(output);
  if (v2.success) return { version: 2, triage: v2.data };
  const v1 = triageV1OutputSchema.safeParse(output);
  return v1.success ? { version: 1, triage: v1.data } : null;
}
