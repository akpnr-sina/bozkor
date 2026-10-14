import type { ContractNature, Regime, SourceId, TenderStatus } from "@/sources/types";

/** Tender fields the matcher reads: a subset of the tenders row plus its lots. */
export type MatchableTender = {
  source: SourceId;
  noticeType: string | null;
  regime: Regime;
  contractNature: ContractNature | null;
  status: TenderStatus;
  title: string;
  description: string | null;
  buyerCountry: string | null;
  cpvMain: string | null;
  cpvAdditional: string[];
  valueEur: number | null;
  submissionDeadline: Date | null;
  noticeLanguage: string | null;
  lots: { title: string | null; description: string | null; cpv: string[] }[];
};

export type MatchCategory = { id: string; cpvPrefixes: string[] };

export type MatchContext = {
  categories: readonly MatchCategory[];
  /** Injected so the matcher stays pure and testable. */
  now: Date;
};

export type RuleKey =
  | "scope"
  | "status"
  | "source"
  | "noticeType"
  | "regime"
  | "country"
  | "language"
  | "deadline"
  | "value"
  | "keywordsNone"
  | "topic"
  | "keywordsAll";

/**
 * Why a configured rule passed. Stored in profile_matches.filter_reasons and
 * rendered in Turkish by the UI. Rules a profile does not configure add no reason.
 */
export type MatchReason =
  | { rule: "source"; value: SourceId }
  | { rule: "noticeType"; value: string }
  | { rule: "regime"; value: Regime }
  | { rule: "country"; value: string }
  | { rule: "language"; value: string }
  /** daysLeft is null when the notice has no deadline (planning notices). */
  | { rule: "deadline"; daysLeft: number | null }
  /** valueEur is null when the value is unknown and includeUnknownValue allowed it. */
  | { rule: "value"; valueEur: number | null }
  /** Tender CPV codes that hit, and the include prefixes they hit. */
  | { rule: "cpv"; codes: string[]; prefixes: string[] }
  /** Keywords as written in the profile that were found. */
  | { rule: "keywordsAny"; hits: string[] }
  | { rule: "keywordsAll"; hits: string[] };

export type MatchResult = { matched: true; reasons: MatchReason[] } | { matched: false; rejectedBy: RuleKey };
