import { z } from "zod";

// Turkish version of a notice (team decision, 14 October 2026): a descriptive
// title and full translations of the description and lots. Validated with Zod
// (rule 6); the originals stay in the tenders and lots rows.

export const translationOutputSchema = z.object({
  title: z
    .string()
    .describe("Açıklayıcı Türkçe başlık: ne satın alınıyor ve ilanda yazıyorsa en önemli ayrıntı. Ref numarası ve kurum adı olmadan, en fazla ~120 karakter."),
  description: z
    .string()
    .describe("İlan açıklamasının eksiksiz Türkçe çevirisi; konu konu paragraflara (aralarında boş satır) ve '- ' ile başlayan maddelere ayrılmış. Açıklama yoksa boş."),
  lots: z
    .array(
      z.object({
        lotNumber: z.string().describe("Girdideki lot numarası, aynen."),
        title: z.string().describe("Lot başlığının Türkçesi; yoksa boş."),
        description: z.string().describe("Lot açıklamasının eksiksiz Türkçe çevirisi, aynı biçimde; yoksa boş."),
      }),
    )
    .describe("Girdideki her lot, aynı sırayla."),
});

export type TranslationOutput = z.infer<typeof translationOutputSchema>;
