import type { ProductCategory } from "@/policy/categories";
import type { FamilyCode } from "./families";

// The shared contract of Faz 8 (SPEC 10): what the import writes, what the pages and the matcher read,
// and what the tender page's "Uygun üreticileri bul" route returns. Owned by the lead; change it only
// after agreeing in the team.

export type Tri = "yes" | "no" | "unknown";
export type AqapLevel = "2110" | "2120" | "none" | "unknown";
export type FitLevel = "medium" | "low";
export type CertificationKind = "management" | "product" | "defense" | "other";
export type ContactState = "not_contacted" | "info_requested" | "awaiting_reply" | "confirmed" | "unsuitable";

/** What the matcher keeps in memory per manufacturer (no contacts, no long texts): ~1 KB each. */
export type ManufacturerForMatch = {
  id: string;
  legalName: string;
  province: string | null;
  categories: ProductCategory[];
  families: FamilyCode[];
  products: string[];
  materials: string[];
  standards: string[];
  /** As written in the pool, e.g. "Dizel setler: 18-1100 kVA"; the matcher parses numbers and units. */
  sizeRange: string | null;
  productionMethod: string | null;
  certifications: { name: string; kind: CertificationKind; validUntil: string | null }[];
  aqap: AqapLevel;
  as9100: Tri;
  exports: Tri;
  fitLevel: FitLevel | null;
  hasEvidenceQuote: boolean;
  hasContact: boolean;
  /** BOZKOR's contact with the firm; the list page filters on it. */
  contactState: ContactState;
};

/** A certificate or standard the tender asks for, from the facts output (src/analysis/facts-schema.ts). */
export type RequiredCertification = {
  name: string;
  level: "BIDDER" | "MANUFACTURER" | "PRODUCT" | "PROJECT" | "UNKNOWN";
  /** True when the quote was found in the notice or document text (checkFactsQuotes in src/analysis/facts-evidence.ts). */
  verified: boolean;
};

/** One lot as the matcher sees it. Fields from facts are null when the tender has no facts yet. */
export type LotForMatch = {
  lotNumber: string;
  /** The notice's contract nature; services and works are not matched. */
  nature: "goods" | "services" | "works" | null;
  objectType: "GOODS" | "SERVICES" | "WORKS" | "MIXED" | "UNKNOWN" | null;
  category: ProductCategory | null;
  /** Short Turkish product name from facts (2-6 words, no technical values). */
  productTr: string | null;
  productNature: "STANDARD" | "CUSTOM" | "SPECIALISED" | "UNKNOWN" | null;
  /** The lot's CPV codes, or the tender's when the lot has none. */
  cpv: string[];
  /** Turkish names of those codes (src/matching/cpv), filled by match-input so the matcher stays pure. */
  cpvNamesTr: string[];
  /** Turkish title and description from the translation, when there is one. */
  textTr: string | null;
  /** Original title and description, for numbers and units ("12,5 kVA") and when nothing is translated. */
  textOriginal: string | null;
  quantityText: string | null;
  /** All certificates the facts list (an AQAP requirement is one of them); the matcher reads only verified PRODUCT and MANUFACTURER ones. */
  certifications: RequiredCertification[];
};

export type MatchInput = {
  tenderId: string;
  hasFacts: boolean;
  lots: LotForMatch[];
};

export type ReasonRule = "product" | "family" | "category" | "size" | "certification" | "aqap" | "evidence";

export type MatchReason = {
  rule: ReasonRule;
  /** Turkish, shown as is, e.g. "Ürün: 'iş güvenliği ayakkabısı' (havuzda: Emniyet ayakkabıları)". */
  text: string;
};

export type MatchCandidate = {
  manufacturerId: string;
  legalName: string;
  /** 1 for the best; ties broken by legal name, so the order is stable. */
  rank: number;
  reasons: MatchReason[];
  /** Turkish, e.g. "EN ISO 20471 havuzda yok (bilinmiyor)". Never used to drop a candidate. */
  missing: string[];
  /** Turkish, e.g. "Araştırmacı notu: Düşük uygunluk". */
  warnings: string[];
};

export type LotMatchStatus = "matched" | "no_pool_match" | "not_goods";

export type LotMatch = {
  lotNumber: string;
  status: LotMatchStatus;
  families: FamilyCode[];
  /** The best three; empty unless status is "matched". */
  top: MatchCandidate[];
  /** Up to seven more candidates after the top three. */
  others: MatchCandidate[];
  /** Turkish notes on the lot, e.g. "Olgu yok: kategori ve belge kontrolü yapılmadı." */
  notes: string[];
};

export type MatchResult = {
  tenderId: string;
  poolVersion: string;
  hasFacts: boolean;
  lots: LotMatch[];
};
