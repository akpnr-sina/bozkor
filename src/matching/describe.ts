import { z } from "zod";
import { regime } from "@/db/schema";
import { formatMoney, NOTICE_TYPE_LABELS, REGIME_LABELS, SOURCE_LABELS } from "@/lib/format";
import { sourceIds } from "./rules";
import type { MatchReason, RuleKey } from "./types";

const quoted = (values: string[]) => values.map((v) => `"${v}"`).join(", ");

/** Turkish sentence for one stored match reason. */
export function describeReason(reason: MatchReason): string {
  switch (reason.rule) {
    case "source":
      return `Kaynak: ${SOURCE_LABELS[reason.value] ?? reason.value}`;
    case "noticeType":
      return `İlan türü: ${NOTICE_TYPE_LABELS[reason.value] ?? reason.value}`;
    case "regime":
      return `Rejim: ${REGIME_LABELS[reason.value] ?? reason.value}`;
    case "country":
      return `Ülke: ${reason.value}`;
    case "language":
      return `İlan dili: ${reason.value}`;
    case "deadline":
      // daysLeft is a snapshot taken when the rules were evaluated, not today's count.
      if (reason.daysLeft === null) return "Son tarih belirtilmemiş";
      return reason.daysLeft === 0
        ? "Değerlendirildiğinde son tarihe 1 günden az kalmıştı"
        : `Değerlendirildiğinde son tarihe ${reason.daysLeft} gün kalmıştı`;
    case "value":
      return reason.valueEur === null
        ? "Tutar belirtilmemiş (profil bilinmeyen tutara izin veriyor)"
        : `Tutar: ${formatMoney(reason.valueEur, "EUR")}`;
    case "cpv":
      return `CPV ${reason.codes.join(", ")} (önek ${reason.prefixes.join(", ")})`;
    case "keywordsAny":
      return `Anahtar kelime: ${quoted(reason.hits)}`;
    case "keywordsAll":
      return `Zorunlu kelimelerin hepsi geçiyor: ${quoted(reason.hits)}`;
  }
}

/** Turkish explanation of why a tender did not match, for the profile preview. */
export const REJECTION_LABELS: Record<RuleKey, string> = {
  status: "İhale açık değil",
  source: "Kaynak uymuyor",
  noticeType: "İlan türü uymuyor",
  regime: "Rejim uymuyor",
  country: "Ülke uymuyor",
  language: "İlan dili uymuyor",
  deadline: "Son tarih geçmiş ya da çok yakın",
  value: "Tutar aralık dışında",
  keywordsNone: "İstenmeyen kelime geçiyor",
  topic: "CPV ve anahtar kelimeler tutmuyor",
  keywordsAll: "Zorunlu kelimelerden biri eksik",
};

const strings = z.array(z.string());
const reasonSchema: z.ZodType<MatchReason> = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("source"), value: z.enum(sourceIds) }),
  z.object({ rule: z.literal("noticeType"), value: z.string() }),
  z.object({ rule: z.literal("regime"), value: z.enum(regime.enumValues) }),
  z.object({ rule: z.literal("country"), value: z.string() }),
  z.object({ rule: z.literal("language"), value: z.string() }),
  z.object({ rule: z.literal("deadline"), daysLeft: z.number().int().nullable() }),
  z.object({ rule: z.literal("value"), valueEur: z.number().nullable() }),
  z.object({ rule: z.literal("cpv"), codes: strings, prefixes: strings }),
  z.object({ rule: z.literal("keywordsAny"), hits: strings }),
  z.object({ rule: z.literal("keywordsAll"), hits: strings }),
]);

/** Reads filter_reasons from the database; entries that are not a well-formed reason are dropped. */
export function parseReasons(raw: unknown): MatchReason[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = reasonSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
