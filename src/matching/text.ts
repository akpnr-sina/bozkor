import type { MatchableTender } from "./types";

// Keyword search for the matcher (SPEC section 6): case, accent and
// punctuation insensitive, on word boundaries.

/**
 * Lowercases (İ, I and ı all become i), strips accents and turns every run of
 * characters other than letters and digits into one space.
 */
export function normalizeText(value: string): string {
  return value
    .replace(/[İIı]/g, "i")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Normalized title, description and lot texts. Fields stay separate so a
 * phrase cannot match across the end of one field and the start of the next.
 */
export function tenderText(tender: Pick<MatchableTender, "title" | "description" | "lots">): string[] {
  return [tender.title, tender.description, ...tender.lots.flatMap((lot) => [lot.title, lot.description])]
    .filter((field): field is string => Boolean(field))
    .map(normalizeText)
    .filter(Boolean);
}

const escapeRegExp = (value: string) => value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// Profiles reuse a handful of keywords across thousands of tenders.
const patterns = new Map<string, RegExp | null>();
const MAX_PATTERNS = 1_000;

/** Null for keywords without letters or digits, which never match. */
function keywordPattern(keyword: string): RegExp | null {
  let pattern = patterns.get(keyword);
  if (pattern === undefined) {
    const normalized = normalizeText(keyword);
    // Normalized text is words separated by single spaces, so a word boundary
    // is a space or the end of the field. The last word may be plural.
    pattern = normalized ? new RegExp(`(?<=^| )${escapeRegExp(normalized)}(?:e?s)?(?= |$)`) : null;
    if (patterns.size >= MAX_PATTERNS) patterns.clear();
    patterns.set(keyword, pattern);
  }
  return pattern;
}

/** Whether the keyword occurs in one of the normalized fields. */
export function containsKeyword(fields: readonly string[], keyword: string): boolean {
  const pattern = keywordPattern(keyword);
  return pattern !== null && fields.some((field) => pattern.test(field));
}

/** Keywords found in the fields, as written in the profile and in profile order. */
export function findKeywords(fields: readonly string[], keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => containsKeyword(fields, keyword));
}
