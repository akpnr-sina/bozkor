import { evidencedFacts, type FactsQuoteChecks, type QuotedFact, type ReadFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import { lotLabel } from "@/lib/format";
import type { LatestFacts } from "@/policy/assess";
import { PRODUCT_CATEGORIES } from "@/policy/categories";
import { assessTender, awardFromDetails, type Gate, type LotAssessment, type PolicyInput, type TenderAssessment } from "@/policy/engine";
import { GATE_LABELS, STATUS_GROUPS } from "@/policy/labels";
import { POLICY, type Policy } from "@/policy/policy";
import type { NoticeDetails } from "@/sources/types";
import type { FactTone, MarkState } from "./fact-grid";

// What the assessment shows of the facts it rests on (docs/qualification-policy-v1.md,
// CLAUDE.md rule 5): the facts in groups, each with its quote and where it was
// found, the ones the status rests on, and the few checks the summary lists.
// Pure, so the cards only lay it out.

export type AssessmentResult = { assessment: TenderAssessment; latest: LatestFacts };

/** A fact of the answer: one of the quoted tender facts, a certificate, or a lot's product, nature or quantity. */
export type FactKey = QuotedFact | `cert:${number}` | `lot:${number}:${"product" | "nature" | "quantity"}`;

const UNKNOWN = "Bilinmiyor";
const VALUE_LABELS: Record<string, string> = {
  REQUIRED: "Zorunlu",
  MINOR: "Basit montaj",
  NONE: "Yok",
  NOT_REQUIRED: "Yok",
  YES: "Evet",
  NO: "Hayır",
  UNKNOWN,
  SINGLE: "Tek teslimat",
  FEW: "Birkaç teslimat",
  REPEATED: "Süre boyunca tekrarlanan siparişler",
  BRAND_ONLY: "Belirli marka, muadil kabul edilmiyor",
  BRAND_OR_EQUIVALENT: "Marka ya da muadili",
  MANDATORY: "Zorunlu",
  OPTIONAL: "İsteğe bağlı",
  LOWEST_PRICE: "En düşük fiyat",
  PRICE_QUALITY: "Fiyat ve kalite",
};
const POINTS_LABELS: Record<string, string> = { ONE: "Tek nokta", FEW: "Birkaç nokta", MANY: "Çok sayıda nokta", UNKNOWN };
const NATURE_LABELS: Record<string, string> = {
  STANDARD: "Standart ürün",
  CUSTOM: "Ölçüye ya da çizime göre üretim",
  SPECIALISED: "Uzmanlık isteyen ya da güvenlik açısından kritik",
  UNKNOWN: "Standart mı özel mi belli değil",
};
const OBJECT_LABELS: Record<FactsOutput["lots"][number]["objectType"], string> = {
  GOODS: "mal alımı",
  SERVICES: "hizmet alımı",
  WORKS: "yapım işi",
  MIXED: "mal ve bağlı hizmet",
  UNKNOWN: "",
};
const CERT_LEVEL_LABELS: Record<FactsOutput["certifications"][number]["level"], string> = {
  BIDDER: "istekli",
  MANUFACTURER: "üretici",
  PRODUCT: "ürün",
  PROJECT: "projeye özel",
  UNKNOWN: "seviyesi belirsiz",
};

export const STRUCTURED_SOURCE = "ilanın yapılandırılmış alanı";
export const UNVERIFIED_FACT = "doğrulanmadı, kararda kullanılmadı";
export const UNVERIFIED_WHY = "Alıntı modelin okuduğu ilan metninde ve dosyalarda bulunamadı; bu olgu karar için kullanılmadı.";

/** Where a quote was found, in Turkish: a part of the notice, or a file and its page. */
export function factSourceLabel(key: string, fileNames: readonly string[]): string {
  const file = /^file:(\d+)(?::p(\d+))?$/.exec(key);
  if (file) {
    const name = fileNames[Number(file[1]) - 1];
    return `${name ? `"${name}"` : `dosya ${file[1]}`}${file[2] ? `, sayfa ${file[2]}` : ""}`;
  }
  if (key === "title") return "başlık";
  if (key === "description") return "açıklama";
  if (key === "performance") return "ifa koşulları";
  const lot = /^lot:(.+):(title|description|quantity)$/.exec(key);
  if (lot) return `${lotLabel(lot[1]!)} ${{ title: "başlığı", description: "açıklaması", quantity: "miktarı" }[lot[2] as "title" | "description" | "quantity"]}`;
  const item = /^(selection|document):(\d+)$/.exec(key);
  if (item) return item[1] === "selection" ? `seçim kriteri ${item[2]}` : `doküman ${item[2]} açıklaması`;
  return key;
}

// ---------------------------------------------------------------------------
// The facts the status rests on

/** Statuses that reject or hold the tender on what the notice states: only their facts can decide against it. */
const DECIDED_BY_FACTS = new Set<string>([...STATUS_GROUPS.rejected, ...STATUS_GROUPS.conditional]);

/** The answer's facts that the engine reads, each as a key. */
function factKeys(facts: FactsOutput): FactKey[] {
  return [
    ...facts.lots.flatMap((_, i) => [`lot:${i}:product`, `lot:${i}:nature`, `lot:${i}:quantity`] as const),
    "installation",
    "commissioningTraining",
    "localService",
    "warranty",
    "deliveryPattern",
    "deliveryPoints",
    "contractDuration",
    "framework",
    "brand",
    "pastPerformance",
    "turnover",
    "samples",
    "siteVisit",
    "restrictedProduct",
    "awardCriteria",
    ...facts.certifications.map((_, i) => `cert:${i}` as const),
  ];
}

/** The answer with one fact unknown; a duration, framework or award the notice gives as structured details goes too. */
function withoutFact(stored: ReadFacts, details: NoticeDetails | null, key: FactKey): { facts: FactsOutput; checks: FactsQuoteChecks | null; details: NoticeDetails | null } {
  const facts = stored.facts;
  const checks = stored.quoteChecks;
  const lot = /^lot:(\d+):(product|nature|quantity)$/.exec(key);
  if (lot) {
    const i = Number(lot[1]);
    const lots = facts.lots.map((l, j) =>
      j !== i
        ? l
        : lot[2] === "product"
          ? { ...l, objectType: "UNKNOWN" as const }
          : lot[2] === "nature"
            ? { ...l, productNature: "UNKNOWN" as const }
            : { ...l, quantity: { text: "", kind: "UNKNOWN" as const, quote: "" } },
    );
    return { facts: { ...facts, lots }, checks, details };
  }
  const cert = /^cert:(\d+)$/.exec(key);
  if (cert) {
    const i = Number(cert[1]);
    return {
      facts: { ...facts, certifications: facts.certifications.filter((_, j) => j !== i) },
      checks: checks && { ...checks, certifications: checks.certifications.filter((_, j) => j !== i) },
      details,
    };
  }
  switch (key) {
    case "warranty":
      return { facts: { ...facts, warranty: { ...facts.warranty, years: null } }, checks, details };
    case "contractDuration":
      return { facts: { ...facts, contractDuration: { ...facts.contractDuration, months: null } }, checks, details: details && { ...details, durationMonths: null } };
    case "framework":
      return { facts: { ...facts, framework: { ...facts.framework, value: "UNKNOWN" } }, checks, details: details && { ...details, framework: null } };
    case "awardCriteria":
      return { facts: { ...facts, awardCriteria: { ...facts.awardCriteria, value: "UNKNOWN" } }, checks, details: details && { ...details, awardCriteria: [] } };
    default:
      return { facts: { ...facts, [key]: { ...facts[key as Exclude<QuotedFact, "warranty" | "contractDuration">], value: "UNKNOWN" } }, checks, details };
  }
}

/** Whether the engine sees the fact as known: an unknown one cannot change anything when it goes. */
function isKnown(evidenced: FactsOutput, details: NoticeDetails | null, key: FactKey): boolean {
  const lot = /^lot:(\d+):(product|nature|quantity)$/.exec(key);
  if (lot) {
    const l = evidenced.lots[Number(lot[1])];
    if (!l) return false;
    return lot[2] === "product" ? l.objectType !== "UNKNOWN" : lot[2] === "nature" ? l.productNature !== "UNKNOWN" : l.quantity.kind !== "UNKNOWN" || !!l.quantity.text;
  }
  // A certificate whose quote was not found is not in the engine's facts; removing it changes nothing, but it is cheap to try.
  if (key.startsWith("cert:")) return true;
  switch (key) {
    case "warranty":
      return evidenced.warranty.years !== null;
    case "contractDuration":
      return evidenced.contractDuration.months !== null || (details?.durationMonths ?? null) !== null;
    case "framework":
      return evidenced.framework.value !== "UNKNOWN" || (details?.framework ?? null) !== null;
    case "awardCriteria":
      return evidenced.awardCriteria.value !== "UNKNOWN" || (details?.awardCriteria.length ?? 0) > 0;
    default:
      return evidenced[key as Exclude<QuotedFact, "warranty" | "contractDuration">].value !== "UNKNOWN";
  }
}

/**
 * The known facts the tender's status rests on: a fact decides when, were it
 * unknown, the status of the tender or of its most promising lot, or that
 * lot's explanation, would change. The engine works it out on the same input,
 * so the page adds no rule of its own. Only rejections and conditional
 * statuses rest on stated facts this way; for the others the set is empty.
 * `input` is the engine's input for `stored` (its facts are `evidencedFacts`
 * of the answer).
 */
export function decidingFacts(input: PolicyInput, stored: ReadFacts, policy: Policy = POLICY): Set<FactKey> {
  const deciding = new Set<FactKey>();
  const base = assessTender(input, policy);
  if (!DECIDED_BY_FACTS.has(base.status)) return deciding;
  const bestIndex = base.lots.indexOf(base.best);
  for (const key of factKeys(stored.facts)) {
    if (!isKnown(input.facts, input.tender.details, key)) continue;
    const variant = withoutFact(stored, input.tender.details, key);
    const other = assessTender({ ...input, tender: { ...input.tender, details: variant.details }, facts: evidencedFacts(variant.facts, variant.checks) }, policy);
    const lot = other.lots[bestIndex];
    if (other.status !== base.status || lot?.status !== base.best.status || lot?.explanation !== base.best.explanation) deciding.add(key);
  }
  return deciding;
}

// ---------------------------------------------------------------------------
// The facts in groups

export type Fact = {
  key: FactKey;
  /** The lot a lot's nature or quantity belongs to, when the tender has several. */
  scope: string | null;
  label: string;
  value: string;
  detail: string;
  quote: string;
  /** Where the quote was found; null when it was not, or the answer has no checks. */
  source: string | null;
  /** The quote and its check are shown: a known value from the model. */
  quoted: boolean;
  /** Without a found quote the fact says it was left out of the decision; a lot's product is used all the same. */
  unverifiedBadge: boolean;
  tone: FactTone;
};

/** One box: a fact, and for a lot its product with the nature and quantity under it. */
export type FactBox = Fact & { parts: Fact[] };

export type FactGroup = { title: string; boxes: FactBox[] };

type FactInput = Omit<Fact, "tone" | "quoted" | "unverifiedBadge" | "scope"> & { scope?: string | null; unknown: boolean; structured?: boolean; productLine?: boolean };

function fact(input: FactInput, deciding: ReadonlySet<FactKey>): Fact {
  const { unknown, structured = false, productLine = false, scope = null, ...rest } = input;
  const quoted = !unknown && !structured;
  const tone: FactTone = deciding.has(input.key) ? "err" : unknown ? "warn" : quoted && !input.source && !productLine ? "muted" : null;
  return { ...rest, scope, source: structured ? STRUCTURED_SOURCE : input.source, quoted, unverifiedBadge: quoted && !productLine, tone };
}

/** The answer's facts in the groups the deep analysis uses too; values that decide against the tender in red, unknown ones in amber. */
export function factGroups(stored: ReadFacts, details: NoticeDetails | null, fileNames: readonly string[], deciding: ReadonlySet<FactKey>): FactGroup[] {
  const { facts, quoteChecks } = stored;
  const label = (key: string | null | undefined) => (key ? factSourceLabel(key, fileNames) : null);
  const found = (key: QuotedFact) => label(quoteChecks?.facts[key]);
  const make = (input: FactInput): FactBox => ({ ...fact(input, deciding), parts: [] });
  const multiLot = facts.lots.length > 1;
  const lotPrefix = (lots: string[]) => (multiLot && lots.length ? `${lots.map(lotLabel).join(", ")}: ` : "");
  const months = details?.durationMonths ?? null;
  const award = awardFromDetails(details);

  const lotBoxes = facts.lots.map((lot, i): FactBox => {
    const checks = quoteChecks?.lots[i];
    const kind = OBJECT_LABELS[lot.objectType];
    const scope = multiLot ? lotLabel(lot.lotNumber) : null;
    return {
      ...fact(
        {
          key: `lot:${i}:product`,
          label: multiLot ? lotLabel(lot.lotNumber) : "Ürün",
          value: lot.productTr,
          detail: [PRODUCT_CATEGORIES[lot.category].label, lot.objectType !== "GOODS" ? kind : ""].filter(Boolean).join(" · "),
          quote: lot.categoryQuote,
          source: label(checks?.category),
          unknown: false,
          productLine: true,
        },
        deciding,
      ),
      parts: [
        fact(
          {
            key: `lot:${i}:nature`,
            scope,
            label: "Nitelik",
            value: NATURE_LABELS[lot.productNature]!,
            detail: "",
            quote: lot.natureQuote,
            source: label(checks?.nature),
            unknown: lot.productNature === "UNKNOWN",
          },
          deciding,
        ),
        fact(
          {
            key: `lot:${i}:quantity`,
            scope,
            label: "Miktar",
            value: lot.quantity.text || "Belirtilmemiş",
            detail: "",
            quote: lot.quantity.quote,
            source: label(checks?.quantity),
            unknown: lot.quantity.kind === "UNKNOWN" && !lot.quantity.text,
          },
          deciding,
        ),
      ],
    };
  });

  const groups: FactGroup[] = [
    {
      title: "Ürün ve miktar",
      boxes: [
        ...lotBoxes,
        make({
          key: "brand",
          label: "Marka",
          value: facts.brand.value === "NONE" ? "Marka şartı yok" : VALUE_LABELS[facts.brand.value]!,
          detail: facts.brand.detail,
          quote: facts.brand.quote,
          source: found("brand"),
          unknown: facts.brand.value === "UNKNOWN",
        }),
        make({
          key: "restrictedProduct",
          label: "Kontrole tabi ürün",
          value: VALUE_LABELS[facts.restrictedProduct.value]!,
          detail: facts.restrictedProduct.detail,
          quote: facts.restrictedProduct.quote,
          source: found("restrictedProduct"),
          unknown: facts.restrictedProduct.value === "UNKNOWN",
        }),
        make({
          key: "samples",
          label: "Numune",
          value: VALUE_LABELS[facts.samples.value]!,
          detail: "",
          quote: facts.samples.quote,
          source: found("samples"),
          unknown: facts.samples.value === "UNKNOWN",
        }),
      ],
    },
    {
      title: "Hizmet kapsamı",
      boxes: [
        make({
          key: "installation",
          label: "Kurulum",
          value: lotPrefix(facts.installation.lots) + VALUE_LABELS[facts.installation.value]!,
          detail: facts.installation.detail,
          quote: facts.installation.quote,
          source: found("installation"),
          unknown: facts.installation.value === "UNKNOWN",
        }),
        make({
          key: "commissioningTraining",
          label: "Eğitim ve devreye alma",
          value: lotPrefix(facts.commissioningTraining.lots) + VALUE_LABELS[facts.commissioningTraining.value]!,
          detail: facts.commissioningTraining.detail,
          quote: facts.commissioningTraining.quote,
          source: found("commissioningTraining"),
          unknown: facts.commissioningTraining.value === "UNKNOWN",
        }),
        make({
          key: "localService",
          label: "Yerinde servis",
          value: lotPrefix(facts.localService.lots) + VALUE_LABELS[facts.localService.value]!,
          detail: facts.localService.detail,
          quote: facts.localService.quote,
          source: found("localService"),
          unknown: facts.localService.value === "UNKNOWN",
        }),
        make({
          key: "siteVisit",
          label: "Saha ziyareti",
          value: VALUE_LABELS[facts.siteVisit.value]!,
          detail: "",
          quote: facts.siteVisit.quote,
          source: found("siteVisit"),
          unknown: facts.siteVisit.value === "UNKNOWN",
        }),
      ],
    },
    {
      title: "Teslimat",
      boxes: [
        make({
          key: "deliveryPattern",
          label: "Teslimat düzeni",
          value: VALUE_LABELS[facts.deliveryPattern.value]!,
          detail: facts.deliveryPattern.detail,
          quote: facts.deliveryPattern.quote,
          source: found("deliveryPattern"),
          unknown: facts.deliveryPattern.value === "UNKNOWN",
        }),
        make({
          key: "deliveryPoints",
          label: "Teslim noktaları",
          value: POINTS_LABELS[facts.deliveryPoints.value]!,
          detail: facts.deliveryPoints.detail,
          quote: facts.deliveryPoints.quote,
          source: found("deliveryPoints"),
          unknown: facts.deliveryPoints.value === "UNKNOWN",
        }),
      ],
    },
    {
      title: "Ticari şartlar",
      boxes: [
        months !== null
          ? make({ key: "contractDuration", label: "Sözleşme süresi", value: `${months} ay`, detail: "", quote: "", source: null, unknown: false, structured: true })
          : make({
              key: "contractDuration",
              label: "Sözleşme süresi",
              value: facts.contractDuration.months !== null ? `${facts.contractDuration.months} ay` : UNKNOWN,
              detail: "",
              quote: facts.contractDuration.quote,
              source: found("contractDuration"),
              unknown: facts.contractDuration.months === null,
            }),
        details?.framework !== null && details?.framework !== undefined
          ? make({ key: "framework", label: "Çerçeve anlaşma", value: details.framework ? "Evet" : "Hayır", detail: "", quote: "", source: null, unknown: false, structured: true })
          : make({
              key: "framework",
              label: "Çerçeve anlaşma",
              value: VALUE_LABELS[facts.framework.value]!,
              detail: "",
              quote: facts.framework.quote,
              source: found("framework"),
              unknown: facts.framework.value === "UNKNOWN",
            }),
        make({
          key: "warranty",
          label: "Garanti",
          value: facts.warranty.years === null ? UNKNOWN : facts.warranty.years === 0 ? "İstenmiyor" : `${facts.warranty.years} yıl`,
          detail: facts.warranty.detail,
          quote: facts.warranty.quote,
          source: found("warranty"),
          unknown: facts.warranty.years === null,
        }),
        award
          ? make({ key: "awardCriteria", label: "Değerlendirme ölçütü", value: VALUE_LABELS[award.value]!, detail: award.text, quote: "", source: null, unknown: false, structured: true })
          : make({
              key: "awardCriteria",
              label: "Değerlendirme ölçütü",
              value: VALUE_LABELS[facts.awardCriteria.value]!,
              detail: facts.awardCriteria.detail,
              quote: facts.awardCriteria.quote,
              source: found("awardCriteria"),
              unknown: facts.awardCriteria.value === "UNKNOWN",
            }),
      ],
    },
    {
      title: "Yeterlilik",
      boxes: [
        make({
          key: "pastPerformance",
          label: "Referans",
          value: VALUE_LABELS[facts.pastPerformance.value]!,
          detail: facts.pastPerformance.detail,
          quote: facts.pastPerformance.quote,
          source: found("pastPerformance"),
          unknown: facts.pastPerformance.value === "UNKNOWN",
        }),
        make({
          key: "turnover",
          label: "Asgari ciro",
          value: VALUE_LABELS[facts.turnover.value]!,
          detail: facts.turnover.detail,
          quote: facts.turnover.quote,
          source: found("turnover"),
          unknown: facts.turnover.value === "UNKNOWN",
        }),
        ...facts.certifications.map((cert, i) =>
          make({
            key: `cert:${i}`,
            label: "Belge",
            value: `${cert.name} (${CERT_LEVEL_LABELS[cert.level]})`,
            detail: "",
            quote: cert.quote,
            source: label(quoteChecks?.certifications[i]),
            unknown: false,
          }),
        ),
      ],
    },
  ];
  return groups;
}

/** Every fact of the groups, a lot's nature and quantity included. */
export const allFacts = (groups: readonly FactGroup[]): Fact[] => groups.flatMap((g) => g.boxes.flatMap((box) => [box, ...box.parts]));

// ---------------------------------------------------------------------------
// The summary's checks

export type CheckRow = { id: string; label: string; state: MarkState; note: string };

export const GATE_MARK: Record<Gate["state"], MarkState> = { PASS: "held", FAIL: "failed", UNKNOWN: "unknown", NOT_APPLICABLE: "off" };

/** At most this many checks in the summary. */
export const SUMMARY_CHECKS = 5;

/**
 * The few checks the summary lists: the facts the status rests on, then the
 * gates that fail, then the hard gates (can a bid be made at all) in their
 * state; the rest is in the full gate list.
 */
export function summaryChecks(lot: Pick<LotAssessment, "gates">, facts: readonly Fact[]): CheckRow[] {
  const deciding = facts
    .filter((f) => f.tone === "err")
    .map((f): CheckRow => ({ id: f.key, label: `${f.scope ? `${f.scope} · ` : ""}${f.label}: ${f.value}`, state: "failed", note: f.detail }));
  const gateRow = (gate: Gate): CheckRow => ({ id: gate.id, label: GATE_LABELS[gate.id], state: GATE_MARK[gate.state], note: gate.note });
  const failed = lot.gates.filter((g) => g.state === "FAIL").map(gateRow);
  const hard = lot.gates.filter((g) => g.id.startsWith("H") && g.state !== "FAIL" && g.state !== "NOT_APPLICABLE").map(gateRow);
  return [...deciding, ...failed, ...hard].slice(0, SUMMARY_CHECKS);
}

export type AssessmentView = { groups: FactGroup[]; factCount: number; checks: CheckRow[] };

/** Everything the assessment cards show beyond the engine's own result. */
export function assessmentView(result: AssessmentResult, details: NoticeDetails | null, fileNames: readonly string[], deciding: ReadonlySet<FactKey>): AssessmentView {
  const groups = factGroups(result.latest.stored, details, fileNames, deciding);
  const facts = allFacts(groups);
  return { groups, factCount: facts.length, checks: summaryChecks(result.assessment.best, facts) };
}
