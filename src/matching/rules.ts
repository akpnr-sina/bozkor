import { z } from "zod";
import { regime } from "@/db/schema";
import { isCountryCode } from "@/lib/countries";

// Criteria profile rules (SPEC section 6), stored in criteria_profiles.rules.
// An empty list means "no filter" for sources, notice types, regimes,
// countries and languages. Messages are Turkish: the profile form shows them.

// One kind of separator between groups of three digits: "20.000", "1.250.000", "20,000".
const GROUPED = /^[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/;
// A one or two digit fraction after the last separator: "1,5", "20000.50", "1.250.000,5", "1,250,000.50".
const FRACTION = /^(?:\d+[.,]|[1-9]\d{0,2}(?:\.\d{3})+,|[1-9]\d{0,2}(?:,\d{3})+\.)\d{1,2}$/;

/**
 * Reads a number typed in the profile form, ignoring spaces, € and EUR.
 * Empty text becomes null; text it cannot read is returned unchanged so the
 * schema rejects it instead of dropping it.
 */
export function parseNumberInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.replace(/\s|€|eur/gi, "");
  if (!text) return null;
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  let parsed: number;
  if (/^\d+$/.test(digits)) {
    parsed = Number(digits);
  } else if (GROUPED.test(digits)) {
    parsed = Number(digits.replace(/[.,]/g, ""));
  } else if (FRACTION.test(digits)) {
    const point = digits.search(/[.,]\d{1,2}$/);
    parsed = Number(`${digits.slice(0, point).replace(/[.,]/g, "")}.${digits.slice(point + 1)}`);
  } else {
    return value;
  }
  return negative ? -parsed : parsed;
}

const inputFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

/** A number as the profile form shows it, read back unchanged by parseNumberInput: 1250000.5 -> "1.250.000,5". */
export function formatNumberInput(value: number | null): string {
  return value === null ? "" : inputFormat.format(value);
}

const dedupe = <T>(values: T[]): T[] => [...new Set(values)];
const list = <T extends z.ZodType>(item: T, max = 200, message = `En fazla ${max} değer girilebilir`) =>
  z
    .array(item)
    .max(max, message)
    .default([])
    .transform((values) => dedupe(values as z.output<T>[]));

const cpvPrefix = z
  .string()
  .trim()
  // Codes are often copied with their check digit, e.g. 31121000-7.
  .transform((value) => value.replace(/^(\d{8})-\d$/, "$1"))
  .pipe(z.string().regex(/^\d{2,8}$/, "CPV öneki 2 ile 8 rakam arasında olmalı"));
const keyword = z
  .string()
  .trim()
  .min(2, "Anahtar kelime en az 2 karakter olmalı")
  .max(100, "Anahtar kelime en fazla 100 karakter olabilir")
  // Text without letters or digits normalizes to nothing and would never match.
  .regex(/[\p{L}\p{N}]/u, "Anahtar kelime en az bir harf ya da rakam içermeli");
// Codes people write for these countries; tenders carry the ISO code.
const COUNTRY_ALIASES: Record<string, string> = { UK: "GB", EL: "GR" };
const alpha2 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Ülke kodu iki harf olmalı (ISO 3166 alpha-2)")
  .transform((code) => COUNTRY_ALIASES[code] ?? code)
  .refine(isCountryCode, {
    error: (issue) => `${String(issue.input)} bir ülke kodu değil; iki harfli ISO kodu girin, örn. GB, IE, NL`,
  });
const language = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Dil kodu iki harf olmalı");
const amountEur = z
  .preprocess(
    parseNumberInput,
    z.number({ error: "Tutar sayı olmalı, örn. 20.000 ya da 1,5" }).nonnegative("Tutar negatif olamaz").nullable(),
  )
  .default(null);
const DAYS_MESSAGE = "Gün sayısı 0 ile 365 arasında tam sayı olmalı, örn. 10";
const THRESHOLD_MESSAGE = "Triage eşiği 0 ile 100 arasında tam sayı olmalı";

export const sourceIds = ["uk_fat", "eu_ted"] as const;
export const noticeTypes = ["planning", "tender"] as const;

export const profileRulesSchema = z
  .object({
    /** Plain-language description of what the team wants; used by AI triage (Faz 4). */
    description: z.string().trim().max(2_000, "Açıklama en fazla 2.000 karakter olabilir").default(""),
    sources: list(z.enum(sourceIds)),
    noticeTypes: z
      .array(z.enum(noticeTypes))
      .max(noticeTypes.length)
      .default(["tender"])
      .transform((values) => dedupe(values)),
    /** Category ids whose CPV prefixes are added to cpvInclude. */
    categoryIds: list(z.string().trim().min(1)),
    cpvInclude: list(cpvPrefix),
    cpvExclude: list(cpvPrefix),
    keywordsAny: list(keyword),
    keywordsAll: list(keyword),
    keywordsNone: list(keyword),
    countries: list(alpha2),
    valueMinEur: amountEur,
    valueMaxEur: amountEur,
    includeUnknownValue: z.boolean().default(true),
    minDaysToDeadline: z
      .preprocess(
        parseNumberInput,
        z
          .number({ error: DAYS_MESSAGE })
          .int(DAYS_MESSAGE)
          .min(0, DAYS_MESSAGE)
          .max(365, DAYS_MESSAGE)
          .nullable(),
      )
      .default(null),
    regimes: list(z.enum(regime.enumValues)),
    noticeLanguages: list(language),
    // Empty means the default threshold.
    triageThreshold: z.preprocess(
      (value) => parseNumberInput(value) ?? undefined,
      z
        .number({ error: THRESHOLD_MESSAGE })
        .int(THRESHOLD_MESSAGE)
        .min(0, THRESHOLD_MESSAGE)
        .max(100, THRESHOLD_MESSAGE)
        .default(60),
    ),
    autoAnalyze: z.boolean().default(false),
    notify: z.boolean().default(true),
    analysisQuestions: list(
      z.string().trim().min(1).max(500, "Soru en fazla 500 karakter olabilir"),
      20,
      "En fazla 20 soru eklenebilir",
    ),
  })
  .refine((r) => r.valueMinEur === null || r.valueMaxEur === null || r.valueMinEur <= r.valueMaxEur, {
    message: "En düşük tutar en yüksek tutardan büyük olamaz",
    path: ["valueMaxEur"],
  });

export type ProfileRules = z.output<typeof profileRulesSchema>;
export type ProfileRulesInput = z.input<typeof profileRulesSchema>;
