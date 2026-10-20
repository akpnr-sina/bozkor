import { z } from "zod";

// The deep analysis of a tender's documents (SPEC 7.2): what the bid team
// needs to decide on it and prepare a bid, read from the notice and the files
// themselves (PDFs as PDFs). Every claim carries the excerpt it rests on and
// where it is (CLAUDE.md rule 5); what the documents do not say stays empty
// and is listed in missingInfo, never guessed. It suggests a decision; the
// team decides (rule 4).

const quote = z
  .string()
  .describe("İddiayı destekleyen birebir kısa alıntı, orijinal dilde ve dokümanda yazdığı gibi (en çok 300 karakter). Kaynak yoksa boş.");
const file = z.number().int().min(0).describe("Alıntının geçtiği dosyanın sıra numarası (girdideki sira); ilan metninden ise 0.");
const page = z.number().int().min(0).describe("Alıntının geçtiği PDF sayfası (dosyanın kendi sayfa sırası, 1'den başlar); PDF değilse ya da ilandan ise 0.");

/** A statement with the excerpt it rests on; empty when the documents do not say. */
const claim = (what: string) =>
  z.object({
    value: z.string().describe(`${what} Kısa Türkçe. Dokümanlar söylemiyorsa boş bırak ve missingInfo'ya yaz.`),
    quote,
    file,
    page,
  });
export type DeepClaim = z.infer<ReturnType<typeof claim>>;

const item = z.object({
  lot: z.string().describe("Lot numarası, girdideki gibi; lot yoksa boş."),
  description: z.string().describe("Kalemin kısa Türkçe tanımı."),
  quantity: z.string().describe("Miktar, dokümanda yazdığı gibi (ör. '1.200', 'en az 50, en çok 80'); yoksa boş."),
  unit: z.string().describe("Birim (adet, takım, metre...); yoksa boş."),
  specs: z.array(z.string()).max(15).describe("Önemli teknik özellikler, kısa Türkçe; değerler ve birimler korunur."),
  standards: z.array(z.string()).max(15).describe("İstenen standartlar, yazıldığı gibi (ör. 'EN ISO 20471', 'IEC 60034')."),
  certifications: z.array(z.string()).max(10).describe("Ürün için istenen sertifika ya da belgeler (CE, test raporu...), kısa."),
  quote,
  file,
  page,
});

const listed = (what: string) => z.array(claim(what)).max(15);

export const deepOutputSchema = z.object({
  summaryTr: z
    .string()
    .describe("İhalenin 3-6 cümlelik Türkçe özeti: ne alınıyor, ne kadar, nereye ve ne zaman teslim, kimler teklif verebilir, öne çıkan şartlar."),
  items: z.array(item).max(50).describe("Alınan kalemler, lot lot; çok kalemli fiyat cetvelinde en önemlileri."),
  delivery: z.object({
    location: claim("Teslim yeri ya da yerleri."),
    country: claim("Teslim ülkesi."),
    incoterm: claim("Teslim şekli (Incoterm ya da 'alıcının deposuna teslim' gibi)."),
    leadTime: claim("Teslim süresi (siparişten teslime)."),
    schedule: claim("Teslim takvimi ya da düzeni (tek sefer, parti parti, çağrıyla)."),
  }),
  eligibility: z.object({
    supplierLocation: claim("Tedarikçinin yerleşik olduğu ülkeye kısıt (AB, EEA, GPA ülkeleri gibi) ya da kısıt olmadığı."),
    productOrigin: claim("Ürün menşei kısıtı (AB menşeli, Rus menşeli olmayan gibi) ya da kısıt olmadığı."),
    minTurnover: claim("Asgari ciro şartı: tutar, para birimi ve kaç yıl."),
    references: claim("Referans ya da iş deneyimi şartı: sayı, tutar, süre."),
    qualityCerts: listed("İstekliden istenen kalite ya da yönetim sistemi belgesi (ISO 9001 gibi)."),
    insurance: listed("İstenen sigorta ve tutarı."),
    securityRequirements: claim("Güvenlik şartları (gizlilik, tesis güvenliği, personel güvenlik soruşturması)."),
    localPresence: claim("Yerel varlık şartı (o ülkede şube, temsilci, servis noktası)."),
  }),
  commercial: z.object({
    contractType: claim("Sözleşme türü (tek seferlik alım, çerçeve anlaşma, dinamik alım...)."),
    duration: claim("Sözleşme süresi ve uzatma seçenekleri."),
    pricingBasis: claim("Fiyatlandırma esası (sabit, birim fiyat, endeksli)."),
    paymentTerms: claim("Ödeme koşulları ve süresi."),
    bonds: claim("Teklif ya da kesin teminat (tutar ya da oran)."),
    penalties: claim("Gecikme cezası ve diğer cezalar."),
    warranty: claim("Garanti süresi ve kapsamı."),
  }),
  servicesScope: z.object({
    installation: claim("Sahada kurulum ya da montaj yükümlülüğü."),
    maintenance: claim("Bakım, onarım ya da yerinde servis yükümlülüğü."),
    training: claim("Eğitim ya da devreye alma yükümlülüğü."),
  }),
  evaluation: z
    .array(z.object({ criterion: z.string().describe("Değerlendirme kriteri, kısa Türkçe."), weight: z.string().describe("Ağırlığı ya da puanı; yoksa boş."), quote, file, page }))
    .max(20),
  timeline: z.object({
    clarificationDeadline: claim("Soru sorma son tarihi ve saati, dokümanda yazdığı gibi."),
    submissionDeadline: claim("Teklif son tarihi ve saati, dokümanda yazdığı gibi."),
    siteVisit: claim("Saha ziyareti (zorunlu mu, ne zaman)."),
  }),
  redFlags: z
    .array(
      z.object({
        issue: z.string().describe("Teklifi zorlaştıran ya da riskli şart, kısa Türkçe."),
        severity: z.enum(["high", "medium", "low"]),
        quote,
        file,
        page,
      }),
    )
    .max(15),
  profileAnswers: z
    .array(z.object({ question: z.string().describe("Soru, girdideki gibi."), answer: z.string().describe("Kısa Türkçe cevap; dokümanlar söylemiyorsa 'Dokümanlarda yok.'"), quote, file, page }))
    .max(20),
  missingInfo: z.array(z.string()).max(25).describe("Dokümanlarda bulunamayan ama teklif kararı için gereken bilgiler, kısa Türkçe."),
  suggestedDecision: z.object({
    decision: z
      .enum(["GO", "REVIEW", "NO_GO", "WATCH"])
      .describe("Öneri (karar ekibindir): GO teklif hazırlanmalı, REVIEW incelenmeli, NO_GO teklif verilmemeli, WATCH izlenmeli."),
    reasons: z.array(z.string()).min(1).max(5).describe("Önerinin kısa Türkçe gerekçeleri."),
  }),
});

export type DeepOutput = z.infer<typeof deepOutputSchema>;

/** A quoted part of the output, by its path ("eligibility.minTurnover", "redFlags.2"), with its quote and the file and page the model gave. */
export type DeepQuoted = { path: string; quote: string; file: number; page: number };

/** Every quote of an output, with its path: what quote checking and the page work through. */
export function deepQuotes(output: DeepOutput): DeepQuoted[] {
  const found: DeepQuoted[] = [];
  const add = (path: string, part: { quote: string; file: number; page: number }) => {
    if (part.quote.trim()) found.push({ path, quote: part.quote, file: part.file, page: part.page });
  };
  output.items.forEach((part, i) => add(`items.${i}`, part));
  for (const section of ["delivery", "eligibility", "commercial", "servicesScope", "timeline"] as const) {
    for (const [key, value] of Object.entries(output[section])) {
      if (Array.isArray(value)) value.forEach((part: DeepClaim, i) => add(`${section}.${key}.${i}`, part));
      else add(`${section}.${key}`, value as DeepClaim);
    }
  }
  output.evaluation.forEach((part, i) => add(`evaluation.${i}`, part));
  output.redFlags.forEach((part, i) => add(`redFlags.${i}`, part));
  output.profileAnswers.forEach((part, i) => add(`profileAnswers.${i}`, part));
  return found;
}

/** A stored output, or null when it is not one (an older shape, say). */
export function readDeepOutput(value: unknown): DeepOutput | null {
  const parsed = deepOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * What a valid deep analysis stores (analyses.output, kind "deep"): the
 * output, where each quote was found in the texts the analysis read (by path:
 * "notice:<key>", "file:<n>:p<k>", "file:<n>", or null when it was not:
 * shown as unverified), in how many parts the files were read, the files left
 * out with why, and the moment its input was read (to tell a stale analysis).
 */
export type StoredDeep = {
  output: DeepOutput;
  quoteChecks: Record<string, string | null>;
  parts: number;
  skipped: { documentId: string; name: string; reason: string }[];
  inputUpdatedAt: string;
};

const storedDeepSchema = z.object({
  output: deepOutputSchema,
  quoteChecks: z.record(z.string(), z.string().nullable()),
  parts: z.number().int().min(1),
  skipped: z.array(z.object({ documentId: z.string(), name: z.string(), reason: z.string() })),
  inputUpdatedAt: z.string(),
});

/** A stored deep analysis, or null when the value is not one. */
export function readStoredDeep(value: unknown): StoredDeep | null {
  const parsed = storedDeepSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
