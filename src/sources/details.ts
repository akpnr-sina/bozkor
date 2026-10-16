import { languageToAlpha2 } from "@/lib/languages";
import type { NoticeDetails } from "./types";

// Helpers both normalizers use to fill NoticeDetails (qualification policy,
// docs/qualification-policy-v1.md). Pure; sources only differ in where the
// values sit in their payloads.

export type AwardCriterion = NoticeDetails["awardCriteria"][number];
export type SelectionCriterion = NoticeDetails["selectionCriteria"][number];

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

const roundMonths = (months: number) => Math.round(months * 10) / 10;

/** A period such as 24 MONTH or 90 DAY in months, one decimal; null for unknown units. */
export function periodMonths(value: number, unit: string): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const perUnit: Record<string, number> = { DAY: 12 / 365.25, WEEK: (7 * 12) / 365.25, MONTH: 1, YEAR: 12 };
  const factor = perUnit[unit.trim().toUpperCase()];
  return factor === undefined ? null : roundMonths(value * factor);
}

/** Months from start to end, one decimal; an end date of 31 March after a start of 1 April counts as 12. */
export function monthsBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  const months = (end.getTime() - start.getTime()) / MS_PER_MONTH;
  return months > 0 ? roundMonths(months) : null;
}

/** Null when nothing was stated, otherwise whether any lot says yes. */
export function anyTrue(values: readonly boolean[]): boolean | null {
  return values.length ? values.some(Boolean) : null;
}

/** How a criterion's number weighs: eForms BT-5421 and OCDS codes both name these. */
export type WeightKind = "percent" | "decimal" | "points" | "order" | null;

export function weightKind(code: string | null | undefined): WeightKind {
  const c = code?.trim().toLowerCase() ?? "";
  if (c.startsWith("per")) return "percent";
  if (c.startsWith("dec")) return "decimal";
  if (c.startsWith("poi")) return "points";
  if (c.startsWith("ord")) return "order";
  return null;
}

/**
 * Weights of one lot's criteria as percentages: percentages as stated,
 * decimals (0.6) times 100, points over the lot's total points. An order of
 * importance is a rank, not a weight. Without the lot's whole list, points
 * cannot be turned into a share and stay null.
 */
export function percentWeights(
  criteria: readonly { number: number | null; kind: WeightKind }[],
  wholeLot: boolean,
): (number | null)[] {
  const totalPoints = criteria.reduce((sum, c) => (c.kind === "points" && c.number !== null ? sum + c.number : sum), 0);
  return criteria.map(({ number, kind }) => {
    if (number === null || !Number.isFinite(number)) return null;
    if (kind === "percent") return number;
    if (kind === "decimal") return Math.round((number <= 1 ? number * 100 : number) * 10) / 10;
    if (kind === "points") return wholeLot && totalPoints > 0 ? Math.round((number / totalPoints) * 1000) / 10 : null;
    return null;
  });
}

/** Drops exact repeats, keeping the first; lots often restate the same criteria. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string = (item) => JSON.stringify(item)): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Languages as ISO 639-1 upper case; two-letter codes the table does not know are kept as written. */
export function languageCodes(values: readonly string[]): string[] {
  return uniqueBy(
    values.flatMap((value) => {
      const code = languageToAlpha2(value) ?? (/^[a-z]{2}$/i.test(value.trim()) ? value.trim().toUpperCase() : null);
      return code ? [code] : [];
    }),
    (code) => code,
  );
}

/** Plain text from the little HTML some notice texts carry (<p>, <br>, entities). */
export function plainText(text: string): string {
  return text
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(?:p|div|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Joins distinct non-empty texts, or null when there are none. */
export function joinTexts(texts: readonly (string | null | undefined)[]): string | null {
  const distinct = uniqueBy(
    texts.map((t) => t?.trim() ?? "").filter((t) => t.length > 0),
    (t) => t,
  );
  return distinct.length ? distinct.join("\n\n") : null;
}

/** Null when the notice states none of the details, so folding keeps an earlier notice's. */
export function detailsOrNull(details: NoticeDetails): NoticeDetails | null {
  const stated =
    details.durationMonths !== null ||
    details.framework !== null ||
    details.electronicOrdering !== null ||
    details.gpaCovered !== null ||
    details.guaranteeRequired !== null ||
    details.performanceTerms !== null ||
    details.awardCriteria.length > 0 ||
    details.selectionCriteria.length > 0 ||
    details.submissionLanguages.length > 0;
  return stated ? details : null;
}
