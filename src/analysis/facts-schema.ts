import { z } from "zod";
import { PRODUCT_CATEGORY_CODES } from "@/policy/categories";

// Facts the model extracts from a notice (qualification policy part XII.2:
// fact extraction is separate from scoring). Each fact carries the notice text
// it comes from (CLAUDE.md rule 5) and UNKNOWN when the notice does not say:
// unknown is neither a pass nor a fail (policy part VI). The scores, gates and
// decisions are worked out from these by code (src/policy).

const quote = z
  .string()
  .describe("Olguyu destekleyen, ilandan birebir kısa alıntı (orijinal dilde). İlan bu konuda bir şey söylemiyorsa boş.");

const detail = z.string().describe("Kısa Türkçe açıklama: ilanda ne yazıyor. Bilinmiyorsa boş.");

const lotFacts = z.object({
  lotNumber: z.string().describe("Girdideki lot numarası, aynen. Lot yoksa boş."),
  productTr: z.string().describe("Bu lotta satın alınan ürünün kısa Türkçe adı (2-6 kelime, küçük harfle), teknik değerler ve miktar olmadan."),
  category: z.enum(PRODUCT_CATEGORY_CODES).describe("Ürünün Bozkor kategori kodu."),
  objectType: z
    .enum(["GOODS", "SERVICES", "WORKS", "MIXED", "UNKNOWN"])
    .describe("Bu lotta satın alınan şey: GOODS mal; SERVICES asıl konu hizmet (bakım, onarım, temizlik, kiralama, danışmanlık, yazılım); WORKS yapım işi; MIXED mal ve ona bağlı belirgin hizmet; UNKNOWN anlaşılmıyor. Dayanağı categoryQuote."),
  categoryQuote: quote,
  productNature: z
    .enum(["STANDARD", "CUSTOM", "SPECIALISED", "UNKNOWN"])
    .describe("STANDARD: katalogdan standart ürün. CUSTOM: ölçüye ya da çizime göre üretim. SPECIALISED: teknik olarak uzmanlık isteyen ya da güvenlik açısından kritik. UNKNOWN: ilandan anlaşılmıyor."),
  natureQuote: quote,
  quantity: z.object({
    text: z.string().describe("İlandaki miktar, kısa Türkçe (ör. '70-91 adet'). Yoksa boş."),
    kind: z.enum(["FIXED", "MIN_MAX", "ESTIMATE", "UNKNOWN"]),
    quote,
  }),
});

const tri = z.enum(["YES", "NO", "UNKNOWN"]);

/** Lots an obligation is stated for; a tender's lots can differ (policy part XII.1). */
const obligationLots = z
  .array(z.string())
  .max(30)
  .describe("Bu değerin geçtiği lotların numaraları, girdideki gibi. İhalenin tamamı için ya da ilanda lot yoksa boş liste.");

export const factsOutputSchema = z.object({
  summaryTr: z.string().describe("İhalenin 1-2 cümlelik Türkçe özeti: ne, ne kadar, nasıl teslim."),
  lots: z.array(lotFacts).min(1).max(30).describe("Girdideki her lot için bir kayıt, aynı sırayla; lot yoksa tek kayıt."),
  installation: z.object({
    value: z.enum(["REQUIRED", "MINOR", "NONE", "UNKNOWN"]).describe("REQUIRED: tedarikçi sahada kurulum ya da montaj yapacak. MINOR: basit montaj. NONE: ilan açıkça yalnızca teslim diyor. UNKNOWN: söz yok."),
    detail,
    quote,
    lots: obligationLots,
  }),
  commissioningTraining: z.object({
    value: tri.describe("Sahada devreye alma, yerinde test ya da yerinde operatör eğitimi isteniyor mu."),
    detail,
    quote,
    lots: obligationLots,
  }),
  localService: z.object({
    value: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]).describe("Yerinde bakım, onarım, servis ya da yerel teknik destek zorunlu mu."),
    detail,
    quote,
    lots: obligationLots,
  }),
  warranty: z.object({
    years: z.number().nullable().describe("İstenen garanti süresi, yıl. İlan açıkça garanti istemiyorsa 0. Söz yoksa null."),
    detail,
    quote,
  }),
  deliveryPattern: z.object({
    value: z.enum(["SINGLE", "FEW", "REPEATED", "UNKNOWN"]).describe("SINGLE: tek teslimat. FEW: birkaç planlı teslimat. REPEATED: süre boyunca tekrarlanan, ihtiyaca göre siparişler."),
    detail,
    quote,
  }),
  deliveryPoints: z.object({ value: z.enum(["ONE", "FEW", "MANY", "UNKNOWN"]), detail, quote }),
  contractDuration: z.object({ months: z.number().nullable().describe("Sözleşme süresi, ay. Yoksa null."), quote }),
  framework: z.object({ value: tri.describe("Çerçeve anlaşma mı, ya da alım miktarı garanti edilmiyor mu."), quote }),
  brand: z.object({
    value: z.enum(["BRAND_ONLY", "BRAND_OR_EQUIVALENT", "NONE", "UNKNOWN"]).describe("BRAND_ONLY: belirli marka ve muadil kabul edilmiyor. BRAND_OR_EQUIVALENT: marka ya da muadili."),
    detail,
    quote,
  }),
  certifications: z
    .array(
      z.object({
        name: z.string().describe("Belge ya da standart, ör. 'ISO 9001', 'CE', 'EN 12021'."),
        level: z
          .enum(["BIDDER", "MANUFACTURER", "PRODUCT", "PROJECT", "UNKNOWN"])
          .describe("Kim sağlamalı: istekli firma, üretici, ürünün kendisi ya da projeye özel onay."),
        quote,
      }),
    )
    .max(10),
  pastPerformance: z.object({
    value: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]).describe("Benzer iş referansı ya da geçmiş teslimat şartı."),
    detail: z.string().describe("Tutarlar, süreler ve kapsam, ilanda yazdığı gibi, Türkçe."),
    quote,
  }),
  turnover: z.object({
    value: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]).describe("Asgari ciro şartı."),
    detail,
    quote,
  }),
  samples: z.object({ value: tri.describe("Numune ya da demo isteniyor mu."), quote }),
  siteVisit: z.object({ value: z.enum(["MANDATORY", "OPTIONAL", "NONE", "UNKNOWN"]), quote }),
  restrictedProduct: z.object({
    value: tri.describe("Askeri amaçlı, kontrole tabi ya da özel izin gerektiren ürün mü (alıcının savunma kurumu olması tek başına yeterli değil)."),
    detail,
    quote,
  }),
  awardCriteria: z.object({ value: z.enum(["LOWEST_PRICE", "PRICE_QUALITY", "UNKNOWN"]), detail, quote }),
  documentsToCheck: z
    .array(z.string())
    .max(8)
    .describe("Bilinmeyen kritik olguları çözecek dokümanlar, Türkçe (ör. 'teknik şartname', 'yeterlilik şartları', 'sözleşme taslağı')."),
});

export type FactsOutput = z.infer<typeof factsOutputSchema>;
export type LotFacts = z.infer<typeof lotFacts>;

const OBLIGATIONS = ["installation", "commissioningTraining", "localService"] as const;

/**
 * A stored answer, or null when it does not fit the schema. Answers from
 * before obligations had lot lists read as applying to the whole tender, and
 * lots from before objectType as unknown.
 */
export function readFactsOutput(output: unknown): FactsOutput | null {
  let value = output;
  if (value && typeof value === "object") {
    const record = { ...(value as Record<string, unknown>) };
    for (const key of OBLIGATIONS) {
      const fact = record[key];
      if (fact && typeof fact === "object" && !Array.isArray((fact as { lots?: unknown }).lots)) record[key] = { ...fact, lots: [] };
    }
    if (Array.isArray(record.lots)) {
      record.lots = record.lots.map((lot: unknown) => (lot && typeof lot === "object" && !("objectType" in lot) ? { ...lot, objectType: "UNKNOWN" } : lot));
    }
    value = record;
  }
  const parsed = factsOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
