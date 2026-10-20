import type { QuoteSources } from "./types";

// Checks that a quote the model gave really appears in the notice text
// (CLAUDE.md rule 5). Matching ignores case, spacing, invisible format
// characters and typographic variants of quotation marks and dashes, so a
// faithful copy passes and a paraphrase or a quote stitched together from two
// places does not.

/** Shorter quotes prove nothing: "3 units" or "supply" appear almost anywhere. */
const MIN_QUOTE_LENGTH = 8;

/** Text in the form quotes and sources are compared in. */
export function normalizeQuoteText(value: string): string {
  return (
    value
      // Zero-width spaces, soft hyphens and direction marks: notice texts carry
      // them (TED 702149), a copied quote does not. Before NFKC, so letters
      // they separate from their accents still compose.
      .replace(/\p{Cf}/gu, "")
      // Also turns the ellipsis character into "...", full-width forms into ASCII and ligatures into letters.
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC`\u00B4]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
      .replace(/[\u2010-\u2015\u2212\u2E3A\u2E3B]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Drops what the model may wrap a quote in: quotation marks and leading or trailing "...". */
const unwrap = (quote: string) => quote.replace(/^(?:\.{3}|["'\s])+|(?:\.{3}|["'\s])+$/g, "");

/**
 * The key of the first source (in insertion order) that contains the quote,
 * or null when it is empty, too short or found nowhere.
 */
export function findQuote(quote: string, sources: QuoteSources): string | null {
  const needle = unwrap(normalizeQuoteText(quote));
  if (needle.length < MIN_QUOTE_LENGTH) return null;
  for (const [key, text] of Object.entries(sources)) {
    if (normalizeQuoteText(text).includes(needle)) return key;
  }
  return null;
}

/** A word broken at a line end ("manu- facturer"): a PDF's text keeps the break, a quote read from the page does not. */
const joinBrokenWords = (text: string) => text.replace(/(\p{L})- (\p{Ll})/gu, "$1$2");

/**
 * findQuote for many quotes over long texts (a tender's files): the sources
 * are normalized once. The keys in `prefer` (the page the model cited, say)
 * are looked in first, then all in insertion order; a word broken at a line
 * end in the source still matches.
 */
export function quoteFinder(sources: QuoteSources): (quote: string, prefer?: readonly string[]) => string | null {
  const texts = new Map(Object.entries(sources).map(([key, text]) => [key, normalizeQuoteText(text)] as const));
  const joined = new Map([...texts].map(([key, text]) => [key, joinBrokenWords(text)] as const));
  return (quote, prefer = []) => {
    const needle = unwrap(normalizeQuoteText(quote));
    if (needle.length < MIN_QUOTE_LENGTH) return null;
    const joinedNeedle = joinBrokenWords(needle);
    const order = [...prefer.filter((key) => texts.has(key)), ...texts.keys()];
    for (const key of order) {
      if (texts.get(key)!.includes(needle) || joined.get(key)!.includes(joinedNeedle)) return key;
    }
    return null;
  };
}
