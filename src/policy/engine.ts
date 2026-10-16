import type { FactsOutput, LotFacts } from "@/analysis/facts-schema";
import { bidWindow } from "@/analysis/rubric";
import { lotLabel } from "@/lib/format";
import type { NoticeDetails } from "@/sources/types";
import { PRODUCT_CATEGORIES } from "./categories";
import { POLICY, segmentMaxEur, valueSegment, type Dimension, type Policy, type ValueSegment } from "./policy";

// The scoring and decision engine of the qualification policy
// (docs/qualification-policy-v1.md). Pure: facts from the notice, values the
// code knows (EUR value, deadline, country) and the configurable policy go in;
// lot-level scores, gates, a status, the reasons and the next actions come out.
// The model never scores (part XII.2); unknown facts widen a score into a range
// instead of passing or failing (part VI), and an inference never rejects.

export type Range = { low: number; high: number };

export type GateState = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export const GATE_IDS = ["H01", "H02", "H03", "H04", "H05", "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09"] as const;
export type GateId = (typeof GATE_IDS)[number];
/** FAIL on a conditional gate means its condition holds: bid readiness waits on it. */
export type Gate = { id: GateId; state: GateState; note: string };

/** Most promising first; a tender shows its most promising lot. */
export const STATUSES = [
  "BID_REVIEW",
  "SHORTLIST",
  "NEEDS_SUPPLIER",
  "NEEDS_DOCUMENTS",
  "NEEDS_FINANCE",
  "NEEDS_QUALIFICATION_REVIEW",
  "NEEDS_PARTNER",
  "WATCH",
  "COMMERCIAL_NO_BID",
  /** A verified requirement cannot be met in the time left (gates H03, H05). */
  "NO_BID",
  "HARD_REJECT",
  "EXPIRED",
] as const;
export type Status = (typeof STATUSES)[number];

/** Final statuses get no next actions (part XII.5). */
export const FINAL_STATUSES: readonly Status[] = ["COMMERCIAL_NO_BID", "NO_BID", "HARD_REJECT", "EXPIRED"];

export type DimensionScore = { weight: number; low: number; high: number; notes: string[] };

export type LotAssessment = {
  lotNumber: string;
  productTr: string;
  category: LotFacts["category"];
  /** The lot's own value, or the tender's when it has a single lot. */
  valueEur: number | null;
  segment: ValueSegment | null;
  status: Status;
  /** Why this status, in plain Turkish with the facts behind it (part XII.4). */
  explanation: string;
  gates: Gate[];
  dimensions: Record<Dimension, DimensionScore>;
  scores: {
    /** Opportunity fit: product, operations, logistics (A, C, F). */
    fit: Range;
    /** Bid readiness: qualification, timing (B, G). */
    readiness: Range;
    /** Commercial viability: cash and economics (D, E). */
    viability: Range;
    /** The preliminary 100-point score (part V.2). */
    preliminary: Range;
  };
  /** Share of the weighted criteria that are known, 0-100 (part X confidence model). */
  confidence: number;
  actions: string[];
};

export type TenderAssessment = {
  policyVersion: string;
  /** The most promising lot's status. */
  status: Status;
  best: LotAssessment;
  lots: LotAssessment[];
};

export type PolicyInput = {
  tender: {
    valueEur: number | null;
    submissionDeadline: Date | null;
    buyerCountry: string | null;
    noticeLanguage: string | null;
    details: NoticeDetails | null;
  };
  /** Lots with their value in EUR, from the lots table. */
  lots: { lotNumber: string; valueEur: number | null }[];
  facts: FactsOutput;
  now: Date;
};

// ---------------------------------------------------------------------------
// Small helpers

const point = (value: number): Range => ({ low: value, high: value });
/** The one score shown: the middle of the range the unknown criteria leave open. */
export const expectedScore = (range: Range): number => Math.round((range.low + range.high) / 2);
const between = (low: number, high: number): Range => ({ low, high });
const round1 = (n: number) => Math.round(n * 10) / 10;

const eurFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const eur = (value: number) => `${eurFormat.format(value)} EUR`;

const regionNames = new Intl.DisplayNames(["tr"], { type: "region" });
function countryName(code: string | null): string {
  if (!code) return "alıcının ülkesi";
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "a", "a ve b", "a, b ve c". */
function listTr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ve ${items[items.length - 1]}`;
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");
const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("tr") + text.slice(1);
/** "Motorlu araç parçası" reads "motorlu araç parçası" inside a sentence; "BA kompresörü" and "6 kW jeneratör" stay as they are. */
const lowerFirst = (text: string) =>
  /^\p{Lu}\p{Ll}/u.test(text) ? text.charAt(0).toLocaleLowerCase("tr") + text.slice(1) : text;

/** A dimension built from criteria, each a share of the dimension's points. */
class DimensionBuilder {
  private low = 0;
  private high = 0;
  readonly notes: string[] = [];
  constructor(private readonly weight: number) {}
  /** `share` of the weight; `range` within 0-1 of that share. */
  add(share: number, range: Range, note: string): this {
    this.low += share * range.low;
    this.high += share * range.high;
    if (note) this.notes.push(note);
    return this;
  }
  build(): DimensionScore {
    return { weight: this.weight, low: round1(this.low * this.weight), high: round1(this.high * this.weight), notes: this.notes };
  }
}

// ---------------------------------------------------------------------------
// Facts the rules read, merged from the model's facts and the notice's
// structured details. Structured details are exact (CLAUDE.md rule 3), so
// they win where both speak.

/**
 * The facts as they hold for one lot: an obligation stated for other lots is
 * unknown for this one (part XII.1), never assumed. Lot numbers compare as
 * labels, so "LOT-0001" and "1" are the same lot.
 */
function factsForLot(facts: FactsOutput, lotNumber: string): FactsOutput {
  // With one lot every stated obligation is that lot's, whatever lot number came with it.
  if (facts.lots.length <= 1) return facts;
  const label = lotLabel(lotNumber);
  const forLot = <T extends { value: string; detail: string; quote: string; lots: string[] }>(fact: T): T =>
    fact.lots.length === 0 || fact.lots.some((n) => lotLabel(n) === label) ? fact : ({ ...fact, value: "UNKNOWN", detail: "", quote: "" } as T);
  return {
    ...facts,
    installation: forLot(facts.installation),
    commissioningTraining: forLot(facts.commissioningTraining),
    localService: forLot(facts.localService),
  };
}

type QualificationGap = {
  label: string;
  detail: string;
  /** BOZKOR is known not to meet it on its own; a turnover threshold is not compared yet. */
  verified: boolean;
};

type Derived = {
  months: number | null;
  /** Longer than the policy's long-contract limit (part IV.3). */
  longTerm: boolean;
  /** A framework or no guaranteed volume, from the details or a quoted fact. */
  framework: boolean;
  /** The notice states repeated orders. */
  repeatedOrders: boolean;
  /** Not stated, but electronic ordering over a long contract points to call-offs: scores only, never a rejection. */
  likelyRepeated: boolean;
  installationRequired: boolean;
  serviceRequired: boolean;
  commissioning: boolean;
  /** Mandatory work in the buyer's country, as Turkish phrases (part IV.1, IV.2). */
  localObligations: string[];
  partnerAvailable: boolean;
  safetyCritical: boolean;
  /** Safety-critical or otherwise technically specialised product. */
  specialised: boolean;
  /** Qualification requirements BOZKOR does not meet on its own (part IV.5, IV.6). */
  qualificationGaps: QualificationGap[];
  award: FactsOutput["awardCriteria"]["value"];
  /** The award criteria as written in the structured details, e.g. "Price %60, Quality %40". */
  awardText: string;
  languages: string[];
};

const normalizeCert = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

const AWARD_TYPES: Record<"price" | "quality" | "cost", string> = { price: "fiyat", quality: "kalite", cost: "maliyet" };

/**
 * The award method from the structured criteria, or null when they do not
 * settle it. Entries with only a description (a quality pass mark, say) are
 * no criterion of their own and are left out.
 */
export function awardFromDetails(details: NoticeDetails | null): { value: "LOWEST_PRICE" | "PRICE_QUALITY"; text: string } | null {
  const criteria = details?.awardCriteria ?? [];
  const typed = criteria.filter((c) => c.type !== null);
  const descriptionOnly = criteria.filter((c) => c.type === null && c.name === null && c.weight === null);
  if (!typed.length || typed.length + descriptionOnly.length !== criteria.length) return null;
  return {
    value: typed.every((c) => c.type === "price" || c.type === "cost") ? "LOWEST_PRICE" : "PRICE_QUALITY",
    text: typed.map((c) => [c.name ?? AWARD_TYPES[c.type!], c.weight !== null ? `%${c.weight}` : ""].filter(Boolean).join(" ")).join(", "),
  };
}

function derive(input: PolicyInput, lot: LotFacts, facts: FactsOutput, policy: Policy): Derived {
  const { tender } = input;
  const details = tender.details;
  const months = details?.durationMonths ?? facts.contractDuration.months ?? null;
  const longTerm = months !== null && months > policy.longContractMonths;
  const installationRequired = facts.installation.value === "REQUIRED";
  const serviceRequired = facts.localService.value === "REQUIRED";
  const commissioning = facts.commissioningTraining.value === "YES";
  const safetyCritical = lot.category === "SAFETY_CRITICAL_MACHINERY";
  const specialised = safetyCritical || lot.productNature === "SPECIALISED";
  const held = new Set(policy.bidderCertifications.map(normalizeCert));
  const bidderCerts = facts.certifications.filter((c) => c.level === "BIDDER" && !held.has(normalizeCert(c.name)));
  const gaps: QualificationGap[] = [];
  if (!policy.hasOwnTrackRecord && facts.pastPerformance.value === "REQUIRED") {
    gaps.push({ label: "geçmiş teslimat referansı", detail: sentence(facts.pastPerformance.detail), verified: true });
  }
  if (!policy.hasOwnTrackRecord && facts.turnover.value === "REQUIRED") {
    gaps.push({ label: "asgari ciro", detail: sentence(facts.turnover.detail), verified: false });
  }
  if (bidderCerts.length) gaps.push({ label: "istekli belgesi", detail: bidderCerts.map((c) => c.name).join(", "), verified: true });
  const structuredAward = awardFromDetails(details);
  return {
    months,
    longTerm,
    framework: details?.framework === true || facts.framework.value === "YES",
    repeatedOrders: facts.deliveryPattern.value === "REPEATED",
    likelyRepeated: facts.deliveryPattern.value === "UNKNOWN" && details?.electronicOrdering === true && longTerm,
    installationRequired,
    serviceRequired,
    commissioning,
    localObligations: [
      installationRequired ? "sahada kurulum" : "",
      serviceRequired ? "yerinde servis" : "",
      // Training alone can often be given remotely or at the factory; on site it binds with installation, service or specialised kit.
      commissioning && (installationRequired || serviceRequired || specialised) ? "devreye alma ile operatör eğitimi" : "",
    ].filter(Boolean),
    partnerAvailable: tender.buyerCountry !== null && policy.servicePartnerCountries.includes(tender.buyerCountry),
    safetyCritical,
    specialised,
    qualificationGaps: gaps,
    award: structuredAward?.value ?? facts.awardCriteria.value,
    awardText: structuredAward?.text ?? sentence(facts.awardCriteria.detail),
    languages: details?.submissionLanguages?.length ? details.submissionLanguages : tender.noticeLanguage ? [tender.noticeLanguage] : [],
  };
}

/** Long details stay on the detail page; the reasons keep their start. */
const clip = (text: string, max = 180) => (text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`);
const gapText = (gaps: QualificationGap[]) => listTr(gaps.map((g) => (g.detail ? `${g.label} (${clip(g.detail)})` : g.label)));

// ---------------------------------------------------------------------------
// Dimensions (part V.2). Each criterion is a share of its dimension; an
// unknown fact gives the range of what it could be.

function scoreA(lot: LotFacts, policy: Policy): DimensionScore {
  const category = PRODUCT_CATEGORIES[lot.category];
  const d = new DimensionBuilder(policy.weights.A);
  const categoryShare = { 1: 1, 2: 0.67, 3: 0.25, 4: 0.1 }[category.priority];
  d.add(0.4, point(categoryShare), `Kategori: ${category.label} (${category.priority === 4 ? "tercih listesinde yok" : `öncelik ${category.priority}`}).`);
  const nature = { STANDARD: point(1), CUSTOM: point(0.75), SPECIALISED: point(0.25), UNKNOWN: between(0.25, 1) }[lot.productNature];
  const natureNote = {
    STANDARD: "Standart ürün.",
    CUSTOM: "Ölçüye ya da çizime göre üretim; Türk üreticiler için uygun olabilir.",
    SPECIALISED: "Uzmanlık isteyen ya da güvenlik açısından kritik ürün.",
    UNKNOWN: "Ürünün standart mı özel mi olduğu doğrulanmadı.",
  }[lot.productNature];
  d.add(0.27, nature, natureNote);
  const quantity = { FIXED: point(1), MIN_MAX: point(0.75), ESTIMATE: point(0.75), UNKNOWN: between(0.25, 1) }[lot.quantity.kind];
  const text = sentence(lot.quantity.text);
  d.add(0.13, quantity, !text ? "Miktar belirtilmemiş." : lot.quantity.kind === "UNKNOWN" ? `Miktar (doğrulanmadı): ${text}.` : `Miktar: ${text}.`);
  // The manufacturer database comes later (Faz 8): unknown for now.
  d.add(0.2, between(0, 1), "Üretici veritabanında doğrulanmış üretici henüz yok.");
  return d.build();
}

const CERT_LEVELS: Record<FactsOutput["certifications"][number]["level"], string> = {
  BIDDER: "istekli",
  MANUFACTURER: "üretici",
  PRODUCT: "ürün",
  PROJECT: "projeye özel",
  UNKNOWN: "seviyesi belirsiz",
};

function scoreB(facts: FactsOutput, derived: Derived, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.B);
  const past = facts.pastPerformance.value;
  d.add(
    0.33,
    { NOT_REQUIRED: point(1), REQUIRED: point(policy.hasOwnTrackRecord ? 0.6 : 0.2), UNKNOWN: between(0, 1) }[past],
    past === "REQUIRED"
      ? `Geçmiş teslimat ya da referans şartı var${facts.pastPerformance.detail ? `: ${sentence(facts.pastPerformance.detail)}` : ""}.`
      : past === "NOT_REQUIRED"
        ? "Referans şartı yok."
        : "Referans şartı ilandan anlaşılmıyor.",
  );
  const turnover = facts.turnover.value;
  d.add(
    0.13,
    { NOT_REQUIRED: point(1), REQUIRED: point(policy.hasOwnTrackRecord ? 0.6 : 0.25), UNKNOWN: between(0, 1) }[turnover],
    turnover === "REQUIRED" ? `Asgari ciro şartı${facts.turnover.detail ? `: ${sentence(facts.turnover.detail)}` : " var"}.` : "",
  );
  const levels = new Set(facts.certifications.map((c) => c.level));
  const bidderGap = derived.qualificationGaps.some((g) => g.label === "istekli belgesi");
  const cert = bidderGap ? point(0.2) : levels.has("PROJECT") ? point(0.35) : levels.size ? point(0.65) : between(0.35, 1);
  d.add(
    0.2,
    cert,
    facts.certifications.length
      ? `Belgeler: ${facts.certifications.map((c) => `${c.name} (${CERT_LEVELS[c.level]})`).join(", ")}.`
      : "Belge şartı ilanda yazmıyor; dokümanlarda olabilir.",
  );
  const brand = { NONE: point(1), BRAND_OR_EQUIVALENT: point(1), BRAND_ONLY: point(0.25), UNKNOWN: between(0.25, 1) }[facts.brand.value];
  d.add(0.13, brand, facts.brand.value === "BRAND_ONLY" ? `Marka şartı, muadil kabul edilmiyor${facts.brand.detail ? `: ${sentence(facts.brand.detail)}` : ""}.` : "");
  const samples = { NO: point(1), YES: point(0.5), UNKNOWN: between(0.3, 1) }[facts.samples.value];
  d.add(0.07, samples, facts.samples.value === "YES" ? "Numune isteniyor." : "");
  // Specifications are judged from the documents (Faz 5-6).
  d.add(0.14, between(0, 1), "Teknik şartname henüz incelenmedi.");
  return d.build();
}

function scoreC(facts: FactsOutput, derived: Derived, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.C);
  const partner = derived.partnerAvailable;
  const installation = facts.installation.value;
  d.add(
    0.33,
    { NONE: point(1), MINOR: point(0.7), REQUIRED: point(partner ? 0.5 : 0.1), UNKNOWN: between(0.2, 1) }[installation],
    {
      NONE: "Kurulum yok; yalnızca teslim.",
      MINOR: `Basit montaj${facts.installation.detail ? `: ${sentence(facts.installation.detail)}` : ""}.`,
      REQUIRED: `Sahada kurulum zorunlu${facts.installation.detail ? `: ${sentence(facts.installation.detail)}` : ""}.`,
      UNKNOWN: "Kurulum yükümlülüğü ilandan anlaşılmıyor.",
    }[installation],
  );
  const service = facts.localService.value;
  d.add(
    0.27,
    { NOT_REQUIRED: point(1), REQUIRED: point(partner ? 0.5 : 0), UNKNOWN: between(0.25, 1) }[service],
    service === "REQUIRED"
      ? `Yerinde servis ya da destek zorunlu${facts.localService.detail ? `: ${sentence(facts.localService.detail)}` : ""}.`
      : service === "NOT_REQUIRED"
        ? "Yerel servis şartı yok."
        : "Servis yükümlülüğü ilandan anlaşılmıyor.",
  );
  const commissioning = facts.commissioningTraining.value;
  d.add(
    0.13,
    { NO: point(1), YES: point(partner ? 0.5 : 0.25), UNKNOWN: between(0.25, 1) }[commissioning],
    commissioning === "YES" ? `Devreye alma ya da eğitim${facts.commissioningTraining.detail ? `: ${sentence(facts.commissioningTraining.detail)}` : " isteniyor"}.` : "",
  );
  const years = facts.warranty.years;
  const warranty = years === null ? between(0.25, 1) : years <= 2 ? point(1) : years <= 5 ? point(0.75) : years <= 10 ? point(0.5) : point(0.25);
  d.add(0.13, warranty, years === null ? "Garanti süresi ilanda yazmıyor." : years === 0 ? "Garanti istenmiyor." : `İstenen garanti: ${years} yıl.`);
  const pattern = facts.deliveryPattern.value;
  d.add(
    0.14,
    { SINGLE: point(1), FEW: point(0.75), REPEATED: point(0.15), UNKNOWN: derived.likelyRepeated ? between(0.15, 0.6) : between(0.25, 1) }[pattern],
    {
      SINGLE: "Tek teslimat.",
      FEW: "Birkaç planlı teslimat.",
      REPEATED: "Süre boyunca tekrarlanan siparişler.",
      UNKNOWN: derived.likelyRepeated
        ? `Teslimat düzeni yazmıyor; elektronik sipariş ve ${derived.months} ay süre tekrarlanan siparişlere işaret ediyor.`
        : "Teslimat düzeni belirtilmemiş.",
    }[pattern],
  );
  return d.build();
}

function scoreD(valueEur: number | null, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.D);
  // Without supplier and buyer payment terms the peak cash need is unknown
  // (part V.D); the value only bounds how much of it the capital could cover.
  const contracts = policy.capitalEur.contracts;
  const expansionMax = segmentMaxEur("D", policy) ?? policy.lowValueMaxEur;
  const range =
    valueEur === null
      ? between(0, 1)
      : valueEur <= contracts
        ? between(0.3, 1)
        : valueEur <= policy.lowValueMaxEur
          ? between(0.15, 0.9)
          : valueEur <= expansionMax
            ? between(0.05, 0.75)
            : between(0, 0.5);
  d.add(
    1,
    range,
    valueEur === null
      ? "Tutar bilinmiyor; nakit ihtiyacı hesaplanamıyor."
      : `Tepe nakit ihtiyacı üretici ve alıcı ödeme koşullarına bağlı; sözleşmelere ayrılan sermaye ${eur(contracts)}.`,
  );
  return d.build();
}

function scoreE(valueEur: number | null, derived: Derived, facts: FactsOutput, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.E);
  if (valueEur === null) {
    d.add(0.33, between(0, 1), "Tutar bilinmiyor.");
  } else {
    const contribution = (valueEur * policy.margin.targetPct) / 100;
    const range = contribution >= 2 * policy.minAbsoluteContributionEur ? point(1) : contribution >= policy.minAbsoluteContributionEur ? point(0.7) : point(0.2);
    d.add(0.33, range, `%${policy.margin.targetPct} marjla olası katkı yaklaşık ${eur(contribution)}.`);
  }
  const months = derived.months;
  const perMonth = valueEur !== null && months ? valueEur / months : null;
  if (derived.repeatedOrders || derived.framework) {
    if (perMonth !== null) {
      d.add(
        0.27,
        perMonth < policy.minMonthlyRevenueEur ? point(0.1) : point(0.6),
        `Tutar ${months} aya yayılan siparişlerle geliyor: aylık ortalama yaklaşık ${eur(perMonth)}.`,
      );
    } else {
      d.add(0.27, between(0.1, 0.7), "Tekrarlı siparişler; sipariş başına gelir bilinmiyor.");
    }
  } else if (derived.likelyRepeated) {
    d.add(
      0.27,
      perMonth !== null && perMonth < policy.minMonthlyRevenueEur ? between(0.1, 0.8) : between(0.4, 0.8),
      perMonth !== null ? `Siparişler ${months} aya yayılırsa aylık ortalama yaklaşık ${eur(perMonth)}.` : "",
    );
  } else {
    d.add(0.27, { SINGLE: point(1), FEW: point(0.8), REPEATED: point(0.3), UNKNOWN: between(0.4, 1) }[facts.deliveryPattern.value], "");
  }
  // The margin itself needs supplier quotes (part V.E).
  d.add(0.4, between(0, 1), "Marj, üretici teklifi olmadan hesaplanamıyor.");
  return d.build();
}

function scoreF(facts: FactsOutput, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.F);
  const points = facts.deliveryPoints.value;
  d.add(
    0.4,
    { ONE: point(1), FEW: point(0.6), MANY: point(0.15), UNKNOWN: between(0.25, 1) }[points],
    points === "MANY" ? `Çok sayıda teslim noktası${facts.deliveryPoints.detail ? `: ${sentence(facts.deliveryPoints.detail)}` : ""}.` : "",
  );
  d.add(0.6, between(0.25, 1), "Teslim şekli (Incoterms), gümrük ve ithalatçı sorumluluğu henüz bilinmiyor.");
  return d.build();
}

function scoreG(facts: FactsOutput, workingDays: number | null, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.G);
  const window =
    workingDays === null
      ? between(0, 1)
      : workingDays >= policy.bidPrepWorkingDays
        ? point(1)
        : workingDays >= policy.partnerLeadWorkingDays
          ? point(0.65)
          : workingDays >= 5
            ? point(0.35)
            : point(0.1);
  d.add(0.6, window, workingDays === null ? "Son tarih belirtilmemiş." : workingDays === 0 ? "Son tarihe iş günü kalmadı." : `Son tarihe ${workingDays} iş günü var.`);
  d.add(0.2, between(0, 1), "Dokümanlar henüz alınmadı.");
  const visit = { NONE: point(1), OPTIONAL: point(1), MANDATORY: point(0.3), UNKNOWN: between(0.3, 1) }[facts.siteVisit.value];
  d.add(0.2, visit, facts.siteVisit.value === "MANDATORY" ? "Saha ziyareti zorunlu." : "");
  return d.build();
}

function scoreH(derived: Derived, policy: Policy): DimensionScore {
  const d = new DimensionBuilder(policy.weights.H);
  const award = derived.award;
  d.add(
    0.4,
    { LOWEST_PRICE: point(1), PRICE_QUALITY: point(0.75), UNKNOWN: between(0.25, 1) }[award],
    award === "LOWEST_PRICE"
      ? "En düşük fiyatla değerlendirme."
      : award === "PRICE_QUALITY"
        ? `Fiyat ve kalite birlikte değerlendiriliyor${derived.awardText ? `: ${derived.awardText}` : ""}.`
        : "",
  );
  const handled = derived.languages.some((l) => policy.workingLanguages.includes(l));
  d.add(
    0.3,
    derived.languages.length ? point(handled ? 1 : 0.5) : between(0.5, 1),
    derived.languages.length && !handled ? `Teklif dili ${derived.languages.join(", ")}: çeviri gerekir.` : "",
  );
  // Competition intensity is not invented (part V.H).
  d.add(0.3, between(0, 1), "");
  return d.build();
}

function combine(dimensions: Record<Dimension, DimensionScore>, keys: Dimension[]): Range {
  const weight = keys.reduce((sum, k) => sum + dimensions[k].weight, 0);
  const low = keys.reduce((sum, k) => sum + dimensions[k].low, 0);
  const high = keys.reduce((sum, k) => sum + dimensions[k].high, 0);
  return { low: Math.round((low / weight) * 100), high: Math.round((high / weight) * 100) };
}

// ---------------------------------------------------------------------------
// Lot assessment

/** Facts the five reviewed tenders turned on (part I); unknown, they need the documents. */
const UNKNOWN_CRITICAL: { test: (f: FactsOutput) => boolean; label: string }[] = [
  { test: (f) => f.installation.value === "UNKNOWN", label: "kurulum yükümlülüğü" },
  { test: (f) => f.localService.value === "UNKNOWN", label: "servis yükümlülüğü" },
  { test: (f) => f.pastPerformance.value === "UNKNOWN", label: "referans şartları" },
  { test: (f) => f.warranty.years === null, label: "garanti süresi" },
  { test: (f) => f.deliveryPattern.value === "UNKNOWN", label: "teslimat düzeni" },
];

/** Below this many working days, missing documents or suppliers mean the bid cannot be ready (part V.G). */
const URGENT_WORKING_DAYS = 5;

function assessLot(input: PolicyInput, lot: LotFacts, policy: Policy): LotAssessment {
  const { tender, now } = input;
  const facts = factsForLot(input.facts, lot.lotNumber);
  const derived = derive(input, lot, facts, policy);
  const multiLot = input.facts.lots.length > 1;
  const lotValue = input.lots.find((l) => lotLabel(l.lotNumber) === lotLabel(lot.lotNumber))?.valueEur ?? null;
  const valueEur = lotValue ?? (multiLot ? null : tender.valueEur);
  // The tender's value bounds a lot without its own: a small tender has only small lots.
  const boundEur = valueEur ?? tender.valueEur;
  const lowValue = boundEur !== null && boundEur <= policy.lowValueMaxEur;
  const window = bidWindow(tender.submissionDeadline, now);
  const days = window.workingDays;
  const tooLateForPartner = days !== null && days < policy.partnerLeadWorkingDays;
  const country = countryName(tender.buyerCountry);
  const category = PRODUCT_CATEGORIES[lot.category];
  const product = lowerFirst(sentence(lot.productTr)) || "ürün";
  const subject = multiLot ? `${lotLabel(lot.lotNumber)} (${product})` : `Bu ${product} alımı`;

  const dimensions: Record<Dimension, DimensionScore> = {
    A: scoreA(lot, policy),
    B: scoreB(facts, derived, policy),
    C: scoreC(facts, derived, policy),
    D: scoreD(valueEur, policy),
    E: scoreE(valueEur, derived, facts, policy),
    F: scoreF(facts, policy),
    G: scoreG(facts, days, policy),
    H: scoreH(derived, policy),
  };
  const scores = {
    fit: combine(dimensions, ["A", "C", "F"]),
    readiness: combine(dimensions, ["B", "G"]),
    viability: combine(dimensions, ["D", "E"]),
    preliminary: combine(dimensions, ["A", "B", "C", "D", "E", "F", "G", "H"]),
  };
  const totalWeight = Object.values(dimensions).reduce((sum, d) => sum + d.weight, 0);
  const unknownWeight = Object.values(dimensions).reduce((sum, d) => sum + (d.high - d.low), 0);
  const confidence = Math.max(0, Math.round(100 - (unknownWeight / totalWeight) * 100));

  // Gates (part VI). A gate fails only on facts the notice states; a missing
  // fact leaves it UNKNOWN, never FAIL and never PASS.
  const expired = window.rating === 0;
  const unknownCritical = UNKNOWN_CRITICAL.filter((u) => u.test(facts)).map((u) => u.label);
  const toVerify = facts.certifications.filter((c) => c.level === "PRODUCT" || c.level === "MANUFACTURER");
  const projectApprovals = facts.certifications.filter((c) => c.level === "PROJECT");
  const unclearCerts = facts.certifications.filter((c) => c.level === "UNKNOWN");
  const complianceCerts = [...toVerify, ...projectApprovals, ...unclearCerts];
  const obligations = listTr(derived.localObligations);
  const partnerBlocked = derived.localObligations.length > 0 && !derived.partnerAvailable;
  const gaps = derived.qualificationGaps;
  const verifiedGaps = gaps.filter((g) => g.verified);
  const obligationsUnknown = [facts.installation.value, facts.localService.value, facts.commissioningTraining.value].includes("UNKNOWN");
  const qualificationTooLate = verifiedGaps.length > 0 && tooLateForPartner;
  const partnerTooLate = partnerBlocked && tooLateForPartner;
  const gpa = tender.details?.gpaCovered;
  const qualificationClear = facts.pastPerformance.value === "NOT_REQUIRED" && facts.turnover.value === "NOT_REQUIRED" && !gaps.length;
  const kind = derived.safetyCritical ? "güvenlik açısından kritik bir ürün için " : derived.specialised ? "uzmanlık isteyen bir ürün için " : "";
  const requirementWord = (list: QualificationGap[]) => (list.length > 1 ? "şartları" : "şartı");
  const requirementObject = (list: QualificationGap[]) => (list.length > 1 ? "şartlarını" : "şartını");
  const it = (list: QualificationGap[]) => (list.length > 1 ? "bunları" : "bunu");

  const gates: Gate[] = [
    {
      id: "H01",
      state: tender.submissionDeadline === null ? "UNKNOWN" : expired ? "FAIL" : "PASS",
      note:
        tender.submissionDeadline === null
          ? "Son tarih belirtilmemiş."
          : expired
            ? "Son teklif tarihi geçti."
            : days === 0
              ? "Son tarihe iş günü kalmadı."
              : `Son tarihe ${days} iş günü var.`,
    },
    {
      id: "H02",
      state: "UNKNOWN",
      note: `Katılım uygunluğu ihale kurallarından doğrulanmalı.${gpa === true ? " İhale GPA kapsamında." : gpa === false ? " İhale GPA kapsamı dışında; bu tek başına engel değildir." : ""}`,
    },
    {
      id: "H03",
      state: qualificationTooLate ? "FAIL" : qualificationClear ? "PASS" : "UNKNOWN",
      note: qualificationTooLate
        ? `${capitalize(gapText(verifiedGaps))} ${requirementWord(verifiedGaps)} Bozkor tarafından doğrudan karşılanmıyor; başka bir kuruluşun kapasitesine dayanan düzen ${days === 0 ? "kalan sürede" : `${days} iş gününde`} kurulamaz.`
        : gaps.length
          ? `${capitalize(gapText(gaps))} ${requirementWord(gaps)} var; başka bir kuruluşun kapasitesine dayanma imkânı doğrulanmadan başarısız sayılmaz.`
          : qualificationClear
            ? "İlan referans ve ciro şartı olmadığını açıkça söylüyor."
            : "Yeterlilik şartları ilandan tam anlaşılmıyor.",
    },
    {
      id: "H04",
      state: facts.restrictedProduct.value === "NO" ? "PASS" : "UNKNOWN",
      note:
        facts.restrictedProduct.value === "YES"
          ? `Kontrole tabi ürün olabilir${facts.restrictedProduct.detail ? `: ${sentence(facts.restrictedProduct.detail)}` : ""}.`
          : facts.restrictedProduct.value === "NO"
            ? "Sıradan ticari ürün."
            : "Ürünün izne tabi olup olmadığı ilandan anlaşılmıyor.",
    },
    {
      id: "H05",
      state: partnerTooLate ? "FAIL" : facts.siteVisit.value === "MANDATORY" || partnerBlocked || obligationsUnknown ? "UNKNOWN" : derived.localObligations.length ? "PASS" : "NOT_APPLICABLE",
      note: partnerTooLate
        ? `${capitalize(obligations)} zorunlu; ${country} için doğrulanmış ortak yok ve ${days === 0 ? "kalan sürede" : `${days} iş gününde`} kurulamaz.`
        : facts.siteVisit.value === "MANDATORY"
          ? "Zorunlu saha ziyaretinin tarihi kontrol edilmeli."
          : partnerBlocked
            ? `${capitalize(obligations)} zorunlu; ortak bulunursa yerine getirilebilir.`
            : obligationsUnknown
              ? "Zorunlu yerinde yükümlülükler ilandan tam anlaşılmıyor."
              : "",
    },
    {
      id: "C01",
      state: unknownCritical.length ? "FAIL" : "PASS",
      note: unknownCritical.length ? `İlandan anlaşılmayan: ${listTr(unknownCritical)}.` : "Kritik şartlar belli.",
    },
    { id: "C02", state: "FAIL", note: "Doğrulanmış üretici yok (üretici veritabanı sonraki aşamada)." },
    {
      id: "C03",
      state: derived.localObligations.length ? (derived.partnerAvailable ? "PASS" : "FAIL") : obligationsUnknown ? "UNKNOWN" : "NOT_APPLICABLE",
      note: derived.localObligations.length
        ? `${capitalize(obligations)} zorunlu; ${country} için ${derived.partnerAvailable ? "ortak var" : "doğrulanmış ortak yok"}.`
        : obligationsUnknown
          ? "Kurulum ve servis yükümlülükleri ilandan tam anlaşılmıyor."
          : "",
    },
    {
      id: "C04",
      state: "UNKNOWN",
      note: (boundEur ?? 0) > policy.capitalEur.contracts ? "Tutar sözleşme sermayesini aşıyor; finansman gerekebilir." : "Nakit planı henüz yapılmadı.",
    },
    {
      id: "C05",
      state: complianceCerts.length ? "FAIL" : "UNKNOWN",
      note: complianceCerts.length
        ? `Doğrulanacak: ${complianceCerts.map((c) => `${c.name} (${CERT_LEVELS[c.level]})`).join(", ")}.`
        : "İlanda ürün belgesi şartı yok; dokümanlarda olabilir.",
    },
    { id: "C06", state: "UNKNOWN", note: "" },
    {
      id: "C07",
      state: facts.samples.value === "YES" ? "FAIL" : facts.samples.value === "NO" ? "PASS" : "UNKNOWN",
      note: facts.samples.value === "YES" ? "Numune zorunlu." : "",
    },
    { id: "C08", state: "UNKNOWN", note: "Teslim şekli ve ithalat sorumluluğu bilinmiyor." },
    {
      id: "C09",
      state: gaps.length ? "FAIL" : qualificationClear ? "PASS" : "UNKNOWN",
      note: gaps.length ? `${capitalize(gapText(gaps))}.` : "",
    },
  ];

  // Status (parts I, IV, VI and X): hard gates first, then the commercial
  // no-bid rules of the reviewed tenders, then the conditional gates, then the
  // score. Each rule names the facts behind it.
  const lotValueMissing = valueEur === null && boundEur !== null;
  const urgent =
    days === null || days >= URGENT_WORKING_DAYS
      ? ""
      : `${days === 0 ? " Son tarihe iş günü kalmadı" : ` Son tarihe yalnızca ${days} iş günü var`}; üretici ve dokümanlar hazır değilse teklif yetişmez.`;
  const longWarranty = facts.warranty.years !== null && facts.warranty.years > 5 ? facts.warranty.years : null;
  const perMonth = boundEur !== null && derived.months ? boundEur / derived.months : null;
  // Every rejection rule that holds is reported: the first decides the
  // status, the others follow as short "Ayrıca" sentences (part XII.4).
  type Rejection = { status: "NO_BID" | "COMMERCIAL_NO_BID"; full: string; short: string };
  const rejections: Rejection[] = [];
  const inTime = days === 0 ? "son tarihe iş günü kalmadığından" : `son tarihe kalan ${days} iş gününde`;
  // Delivery only at this stage (team decision, 16 October 2026): on-site
  // work rejects the lot outright, so the partner rules below stay silent.
  const onSiteWork = [
    derived.installationRequired ? "sahada kurulum" : "",
    facts.installation.value === "MINOR" && !policy.allowMinorAssembly ? "sahada basit montaj" : "",
    derived.serviceRequired ? "yerinde servis" : "",
    derived.commissioning ? "sahada devreye alma ya da eğitim" : "",
  ].filter(Boolean);
  const deliveryOnly = policy.supplyOnly && onSiteWork.length > 0;
  if (deliveryOnly) {
    rejections.push({
      status: "COMMERCIAL_NO_BID",
      full: `${subject} ürün teslimine ek olarak ${listTr(onSiteWork)} istiyor. Şu aşamada yalnızca ürün teslimi içeren ihalelere teklif veriyoruz.`,
      short: `Ayrıca ürün teslimine ek olarak ${listTr(onSiteWork)} isteniyor.`,
    });
  }
  if (qualificationTooLate) {
    // H03: a verified requirement that cannot be arranged in the time left (example 4).
    rejections.push({
      status: "NO_BID",
      full: `${subject} için ${gapText(verifiedGaps)} ${requirementWord(verifiedGaps)} var. Bozkor ${it(verifiedGaps)} kendi başına karşılamıyor; başka bir kuruluşun kapasitesine dayanan uygun bir düzen ${inTime} kurulamaz.`,
      short: `Ayrıca ${gapText(verifiedGaps)} ${requirementWord(verifiedGaps)} var ve başka bir kuruluşa dayanan bir düzen bu sürede kurulamaz.`,
    });
  }
  if (partnerTooLate && !deliveryOnly) {
    // H05: mandatory local work without a partner and no time to find one (example 3).
    const who = derived.specialised ? "sertifikalı üretici ve servis ortağı" : "kurulum ya da servis ortağı";
    rejections.push({
      status: "NO_BID",
      full: `${subject} ${kind}${obligations} gerektiriyor. ${country} için doğrulanmış ortağımız yok; ${inTime} ${who} bulunamaz.`,
      short: `Ayrıca ${kind}${obligations} gerektiriyor; ${country} için doğrulanmış ortağımız yok ve bu sürede ${who} da bulunamaz.`,
    });
  }
  const serviceRule = !deliveryOnly && derived.serviceRequired && !derived.partnerAvailable && lowValue && derived.longTerm;
  if (serviceRule) {
    // Example 1: local service over a long, low-value contract.
    const services = listTr(derived.localObligations.filter((o) => o !== "devreye alma ile operatör eğitimi"));
    const opening = lotValueMissing
      ? `${subject} için lot değeri belirtilmemiş (ihalenin tamamı ${eur(boundEur!)}); sözleşme ${derived.months} ay sürüyor`
      : `${subject} ${eur(boundEur!)} değerinde ve ${derived.months} ay sürüyor`;
    const contribution = lotValueMissing ? "" : ` %${policy.margin.targetPct} marjla bile toplam katkı yaklaşık ${eur((boundEur! * policy.margin.targetPct) / 100)}.`;
    rejections.push({
      status: "COMMERCIAL_NO_BID",
      full: `${opening}; ${services} zorunlu. ${country} için doğrulanmış servis ortağımız yok; ${derived.months} ay boyunca yerel hizmet yükü sözleşme değerine göre orantısız.${contribution}`,
      short: `Ayrıca ${derived.months} ay boyunca ${services} zorunlu; ${country} için servis ortağımız yok ve bu yük sözleşme değerine göre orantısız.`,
    });
  }
  if (lowValue && derived.longTerm && (derived.repeatedOrders || derived.framework) && perMonth !== null && perMonth < policy.minMonthlyRevenueEur) {
    // Example 2: small orders spread over a long contract, as the notice states them.
    const how = derived.repeatedOrders ? "ihtiyaca göre tekrarlanan siparişlerle" : "alım miktarı garanti edilmeyen bir çerçeve anlaşmayla";
    const average = lotValueMissing ? `en fazla ${eur(perMonth)}` : `yaklaşık ${eur(perMonth)}`;
    const opening = lotValueMissing
      ? `${subject} için lot değeri belirtilmemiş; ihalenin tamamı (${eur(boundEur!)}) ${derived.months} aya yayılan, ${how} geliyor: aylık ortalama ${average}.`
      : `${subject} ${eur(boundEur!)} değerinde; bu tutar ${derived.months} aya yayılan, ${how} geliyor: aylık ortalama ${average}.`;
    rejections.push({
      status: "COMMERCIAL_NO_BID",
      full: `${opening} Çok sayıda küçük sevkiyat ve hızlı yerel tedarik gerekir; yerleşik yerel tedarikçiler avantajlı.`,
      short: `Ayrıca tutar ${derived.months} aya yayılan, ${how} geliyor (aylık ortalama ${average}).`,
    });
  }
  if (!deliveryOnly && derived.installationRequired && !derived.partnerAvailable && lowValue && !derived.specialised && !serviceRule) {
    // Example 5: site installation on a small contract (the service rule
    // already names it). Specialised equipment is installed through the
    // manufacturer's network instead (example 3).
    const opening = lotValueMissing
      ? `${subject} sahada kurulum içeriyor; lot değeri belirtilmemiş, ihalenin tamamı ${eur(boundEur!)}.`
      : `${subject} ${eur(boundEur!)} değerinde ve sahada kurulum içeriyor.`;
    rejections.push({
      status: "COMMERCIAL_NO_BID",
      full: `${opening} ${country} için kurulum ortağımız yok; yerel kurulum maliyeti bu tutarda marjın çoğunu tüketir. Yalnızca tedarik içeren benzer ihaleler uygun olabilir.`,
      short: `Ayrıca bu düşük tutarlı alımda sahada kurulum var; ${country} için kurulum ortağımız yok.`,
    });
  }

  let status: Status;
  let explanation: string;
  if (expired) {
    status = "EXPIRED";
    explanation = `Son teklif tarihi geçti. ${subject} kategori ve alıcı bilgisi için arşivde kalır.`;
  } else if (lot.objectType === "SERVICES" || lot.objectType === "WORKS") {
    // Goods only (team decision, 14 October 2026): a services or works lot the
    // notice's contract nature let through is out of scope.
    status = "HARD_REJECT";
    explanation = `Kapsam dışı: ${subject} mal değil, ${lot.objectType === "WORKS" ? "yapım işi" : "hizmet"} alımı. Bozkor yalnızca mal alımlarına teklif verir.`;
  } else if (rejections.length) {
    // The delivery-only rule first, then hard gates, then the commercial rules (in the order pushed).
    status = rejections[0]!.status;
    // After a hard gate, a commercial reason says it is a second kind of no.
    const others = rejections
      .slice(1)
      .map((r) => (status === "NO_BID" && r.status === "COMMERCIAL_NO_BID" ? r.short.replace(/^Ayrıca /, "Ayrıca ticari olarak da uygun değil: ") : r.short));
    explanation = [rejections[0]!.full, ...new Set(others)].join(" ");
  } else if (gaps.length || facts.restrictedProduct.value === "YES") {
    // Example 4 with time left: references must come from a permitted structure.
    status = "NEEDS_QUALIFICATION_REVIEW";
    const parts: string[] = [];
    if (gaps.length) {
      const unverifiedGaps = gaps.filter((g) => !g.verified);
      const meets = !unverifiedGaps.length
        ? `Bozkor ${it(gaps)} kendi başına karşılamıyor`
        : !verifiedGaps.length
          ? `Bozkor'un ${it(gaps)} kendi başına karşıladığı doğrulanmadı`
          : `Bozkor ${listTr(verifiedGaps.map((g) => g.label))} ${requirementObject(verifiedGaps)} kendi başına karşılamıyor; ${listTr(unverifiedGaps.map((g) => g.label))} ${requirementObject(unverifiedGaps)} karşıladığı da doğrulanmadı`;
      parts.push(
        `${subject} için ${gapText(gaps)} ${requirementWord(gaps)} var. ${meets}; başka bir kuruluşun (ör. üreticinin) kapasitesine dayanmanın kabul edilip edilmediği dokümanlardan doğrulanmalı. Üreticinin kataloğu ya da genel yetki belgesi yeterli değildir.`,
      );
    }
    if (facts.restrictedProduct.value === "YES") {
      parts.push(
        `Ürün kontrole tabi olabilir${facts.restrictedProduct.detail ? ` (${sentence(facts.restrictedProduct.detail)})` : ""}; gerekli izinler doğrulanmadan teklif hazırlanmaz.`,
      );
    }
    if (partnerBlocked) parts.push(`Ayrıca ${obligations} zorunlu; ${country} için yerel kurulum ya da servis ortağı gerekir.`);
    explanation = parts.join(" ");
  } else if (partnerBlocked) {
    status = "NEEDS_PARTNER";
    explanation = derived.specialised
      ? `${subject} ${kind}${obligations} gerektiriyor. ${country} için sertifikalı üretici ve yerel servis ortağı bulunmadan teklif verilemez.${days !== null && days > 0 ? ` Son tarihe ${days} iş günü var.` : ""}`
      : `${subject} ${obligations} gerektiriyor. ${country} için doğrulanmış kurulum ya da servis ortağı yok; ortak bulunup fiyatı alınmadan teklif verilemez.`;
  } else if (scores.fit.high < policy.bands.low || (category.priority >= 3 && scores.fit.high < policy.bands.conditional)) {
    status = "WATCH";
    const where = category.priority === 4 ? "tercih edilen kategorilerin dışında" : `öncelik ${category.priority} kategorisinde (${category.label})`;
    explanation = `${subject} ${where} ve fırsat uyumu düşük (yaklaşık ${expectedScore(scores.fit)}). Kategori ya da alıcı ileride ilginç olabilir.`;
  } else if (unknownCritical.length) {
    status = "NEEDS_DOCUMENTS";
    const hint = derived.likelyRepeated
      ? ` Elektronik sipariş ve ${derived.months} aylık süre tekrarlanan siparişlere işaret ediyor; teslim programı dokümanlardan doğrulanmalı.`
      : "";
    explanation = `${subject} için fırsat uyumu yaklaşık ${expectedScore(scores.fit)}, ama ${listTr(unknownCritical)} ilandan anlaşılmıyor. Dokümanlar okunmadan uygun sayılmaz.${hint}${urgent}`;
  } else if (scores.fit.low >= policy.bands.conditional) {
    status = "NEEDS_SUPPLIER";
    const warranty = longWarranty ? ` İstenen ${longWarranty} yıllık garantiyi üretici yazılı olarak üstlenmeli.` : "";
    explanation = `${subject} için kritik şartlar belli ve fırsat uyumu yaklaşık ${expectedScore(scores.fit)}.${warranty} Doğrulanmış bir Türk üretici ve teklifi olmadan kısa listeye alınmaz.${urgent}`;
  } else {
    status = "WATCH";
    explanation = `${subject} için fırsat uyumu yaklaşık ${expectedScore(scores.fit)}; öne çıkan bir avantaj görünmüyor.`;
  }

  // Next actions (part XII.5): what the status waits on first, then the rest.
  const actions: string[] = [];
  if (!FINAL_STATUSES.includes(status) && status !== "WATCH") {
    const docs = facts.documentsToCheck.length ? facts.documentsToCheck.join(", ") : "teknik şartname, yeterlilik şartları, sözleşme taslağı";
    const firstByStatus: Partial<Record<Status, string>> = {
      NEEDS_DOCUMENTS: `Dokümanları indirip incele: ${docs}.`,
      NEEDS_QUALIFICATION_REVIEW: gaps.length
        ? "Alıcıya başka bir kuruluşun (üreticinin) referanslarına ve kapasitesine dayanmanın kabul edilip edilmediğini sor."
        : "Ürünün ihracat ve izin durumunu doğrula.",
      NEEDS_PARTNER: derived.specialised
        ? `Sertifikalı üreticinin ${country} servis ağı olup olmadığını sor.`
        : `${country} için kurulum ya da servis ortağından fiyat al; şartın zorunlu olup olmadığını alıcıya sor.`,
      NEEDS_SUPPLIER: longWarranty ? `Üreticiden ${longWarranty} yıllık garanti ve yedek parça taahhüdünü yazılı al.` : `${product} için iki Türk üretici belirle ve teklif iste.`,
    };
    const first = firstByStatus[status];
    if (first) actions.push(first);
    if (unknownCritical.length) actions.push(`Dokümanları indirip incele: ${docs}.`);
    if (gaps.length) actions.push("Yeterlilik ekini indir; istenen tutar, adet ve belgeleri üreticinin geçmiş teslimatları ve belgeleriyle karşılaştır.");
    if (partnerBlocked) actions.push(`${country} için kurulum ya da servis ortağından fiyat al.`);
    if (derived.commissioning && !derived.localObligations.includes("devreye alma ile operatör eğitimi")) {
      actions.push("Eğitim ya da devreye almanın uzaktan ya da üretici tesisinde yapılıp yapılamayacağını alıcıya sor.");
    }
    if (longWarranty) actions.push(`Üreticiden ${longWarranty} yıllık garanti ve yedek parça taahhüdünü yazılı al.`);
    if (toVerify.length) actions.push(`${toVerify.map((c) => c.name).join(", ")} belgesinin üreticide ve ürün modelinde olduğunu doğrula.`);
    if (projectApprovals.length) actions.push(`${projectApprovals.map((c) => c.name).join(", ")} onayının süresini ve maliyetini öğren.`);
    if (unclearCerts.length) actions.push(`${unclearCerts.map((c) => c.name).join(", ")} belgesini kimin sağlaması gerektiğini dokümanlardan belirle.`);
    if (facts.samples.value === "YES") actions.push("Numune hazırlık süresini ve maliyetini üreticiye sor.");
    if (facts.brand.value === "BRAND_ONLY") actions.push("Markanın yetkili distribütörüne ulaşılabiliyor mu kontrol et; kaynağı belirsiz ürün kabul edilemez.");
    actions.push(`${product} için iki Türk üretici belirle ve teklif iste.`);
    if (boundEur !== null && boundEur > policy.capitalEur.contracts) actions.push("Tepe nakit ihtiyacını üretici ödeme koşulları ve alıcı ödeme süresiyle hesapla.");
    if (derived.languages.length && !derived.languages.some((l) => policy.workingLanguages.includes(l))) {
      actions.push(`Teklif dili ${derived.languages.join(", ")}: çeviri süresini ve maliyetini planla.`);
    }
    const segment = valueSegment(valueEur, policy);
    if (segment === "A") actions.push("Hızlı teklif kuyruğu: üretici hazırsa kısa yoldan fiyat ver.");
    if (segment === "E") actions.push("Büyük ihale: ortaklık ya da üretici liderliğinde teklif modelini değerlendir.");
  }

  return {
    lotNumber: lot.lotNumber,
    productTr: product,
    category: lot.category,
    valueEur,
    segment: valueSegment(valueEur, policy),
    status,
    explanation,
    gates,
    dimensions,
    scores,
    confidence,
    actions: [...new Set(actions.map(capitalize))],
  };
}

const STATUS_RANK = new Map<Status, number>(STATUSES.map((s, i) => [s, i]));
const midpoint = (r: Range) => (r.low + r.high) / 2;

/**
 * Assesses every lot; the tender takes its most promising lot's status (part
 * XII.1). Throws on facts without lots, which the facts schema rules out.
 */
export function assessTender(input: PolicyInput, policy: Policy = POLICY): TenderAssessment {
  const lots = input.facts.lots.map((lot) => assessLot(input, lot, policy));
  const best = [...lots].sort(
    (a, b) => STATUS_RANK.get(a.status)! - STATUS_RANK.get(b.status)! || midpoint(b.scores.fit) - midpoint(a.scores.fit),
  )[0];
  if (!best) throw new Error("Facts without lots cannot be assessed");
  return { policyVersion: policy.version, status: best.status, best, lots };
}
