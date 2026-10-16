import type { NoticeDetails, SourceId } from "@/sources/types";

/** Token counts of one LLM call, as billed (CLAUDE.md rule 7). */
export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache writes; the 1-hour part is priced higher. */
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
};

/** The notice as triage reads it: the tenders row and its lots, no documents (SPEC 7.1). */
export type TriageNotice = {
  source: SourceId;
  title: string;
  description: string | null;
  buyerName: string | null;
  buyerCountry: string | null;
  cpvMain: string | null;
  cpvAdditional: string[];
  valueAmount: number | null;
  valueCurrency: string | null;
  valueEur: number | null;
  submissionDeadline: Date | null;
  procedureType: string | null;
  noticeLanguage: string | null;
  lots: {
    lotNumber: string;
    title: string | null;
    description: string | null;
    cpv: string[];
    valueAmount: number | null;
    valueCurrency: string | null;
    quantityText: string | null;
  }[];
  /** Structured contract details (tenders.details), when the notice has them. */
  details?: NoticeDetails | null;
};

/** What the profile tells triage about the team's interest. */
export type TriageProfile = {
  name: string;
  /** Free text from the profile form ("Ne arıyoruz?"); may be empty. */
  description: string;
  /** Profile questions (SPEC 6, analysisQuestions); context for red flags. */
  questions: string[];
  /** Selected categories as "name: description", e.g. "Giyim ve teçhizat: Giyim, üniforma, kişisel koruyucu donanım". */
  categories?: string[];
  /** keywordsAny and keywordsNone of the profile, as written. */
  keywords?: string[];
  excludedKeywords?: string[];
};

/**
 * Texts a quote may come from, keyed by where they appear in the notice:
 * "title", "description", "lot:<lotNumber>:title", "lot:<lotNumber>:description",
 * "lot:<lotNumber>:quantity". Built from the same data as the prompt input.
 */
export type QuoteSources = Record<string, string>;
