// BOZKOR's qualification policy as configurable values (docs/qualification-policy-v1.md
// part XII.3). The engine reads only these, so the policy can change without
// rewriting it; every assessment records the version it was made with. Change
// a value, bump the version.

export type Policy = {
  version: string;
  /** Planning figures, not legal limits (part 1). */
  capitalEur: { total: number; contracts: number; reserve: number; setup: number };
  /** Contract value segments A-E (part II.2): upper bounds in EUR, E open-ended. */
  segments: { code: ValueSegment; maxEur: number | null }[];
  /** "Low total value" in the commercial no-bid rules (part I): the top of the core target. */
  lowValueMaxEur: number;
  /** A contract longer than this counts as long-term in the commercial no-bid rules (part IV.3). */
  longContractMonths: number;
  /** Below this a repeated-order contract earns too little per month (part IV.3). */
  minMonthlyRevenueEur: number;
  margin: { minPct: number; targetPct: number };
  /** Absolute contribution that justifies a tender (rubric E3, part V.E). */
  minAbsoluteContributionEur: number;
  /** Working days that comfortably cover sourcing, validation and documents (part V.G). */
  bidPrepWorkingDays: number;
  /**
   * Working days needed to sign up a local installation or service partner, or
   * a manufacturer whose references the bid relies on (part I, examples 3 and 4).
   */
  partnerLeadWorkingDays: number;
  /** Countries (ISO alpha-2) where a verified installation or service partner exists. */
  servicePartnerCountries: string[];
  /**
   * BOZKOR has public-contract references and a turnover history of its own
   * (part IV.6). Until then a reference or turnover requirement needs another
   * entity's capacity.
   */
  hasOwnTrackRecord: boolean;
  /** Certificates BOZKOR itself holds, e.g. "ISO 9001"; a bidder-level requirement outside this list needs another entity. */
  bidderCertifications: string[];
  /** Tender languages the team handles without translation. */
  workingLanguages: string[];
  /**
   * Bid only where the supplier delivers (team decision, 16 October 2026):
   * mandatory on-site installation, local service or on-site commissioning
   * or training rejects a lot whatever the partners and time. Off, the
   * partner rules of part I decide instead.
   */
  supplyOnly: boolean;
  /**
   * With supplyOnly, whether basic assembly on site (setting furniture up,
   * say) still passes; the team rejects it for now (16 October 2026).
   */
  allowMinorAssembly: boolean;
  /** Preliminary 100-point model (part V.2). */
  weights: Record<Dimension, number>;
  /** Preliminary score bands (part X). */
  bands: { priority: number; strong: number; conditional: number; low: number };
};

export type ValueSegment = "A" | "B" | "C" | "D" | "E";
export type Dimension = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/**
 * The team confirmed the partner lead time (10 working days), that BOZKOR has
 * no bidder certificates, no references of its own and no installation or
 * service partner in any country, and that it bids for delivery only for now
 * (16 October 2026). v2: supplyOnly. v3: basic assembly rejected too.
 */
export const POLICY: Policy = {
  version: "policy.v3",
  capitalEur: { total: 25_000, contracts: 17_000, reserve: 5_000, setup: 3_000 },
  segments: [
    { code: "A", maxEur: 5_000 },
    { code: "B", maxEur: 15_000 },
    { code: "C", maxEur: 35_000 },
    { code: "D", maxEur: 60_000 },
    { code: "E", maxEur: null },
  ],
  lowValueMaxEur: 35_000,
  longContractMonths: 12,
  minMonthlyRevenueEur: 2_000,
  margin: { minPct: 15, targetPct: 20 },
  minAbsoluteContributionEur: 2_500,
  bidPrepWorkingDays: 15,
  partnerLeadWorkingDays: 10,
  servicePartnerCountries: [],
  hasOwnTrackRecord: false,
  bidderCertifications: [],
  workingLanguages: ["EN", "TR"],
  supplyOnly: true,
  allowMinorAssembly: false,
  weights: { A: 15, B: 15, C: 15, D: 20, E: 15, F: 10, G: 5, H: 5 },
  bands: { priority: 85, strong: 70, conditional: 55, low: 35 },
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  A: "Ürün ve üretici uygunluğu",
  B: "Teknik ve yeterlilik uyumu",
  C: "Operasyonel karmaşıklık",
  D: "Nakit akışı ve finansman",
  E: "Kârlılık ve sözleşme ekonomisi",
  F: "Lojistik ve gümrük",
  G: "Süre ve son tarih",
  H: "Rekabet ve teklif eforu",
};

export function segmentMaxEur(code: ValueSegment, policy: Policy = POLICY): number | null {
  return policy.segments.find((s) => s.code === code)?.maxEur ?? null;
}

export function valueSegment(valueEur: number | null, policy: Policy = POLICY): ValueSegment | null {
  if (valueEur === null) return null;
  return policy.segments.find((s) => s.maxEur === null || valueEur < s.maxEur)?.code ?? "E";
}
