import { describe, expect, it } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { loadFixture } from "../../tests/helpers/fixtures";
import type { Lot, Tender } from "@/db/schema";
import { buildRateTable } from "@/fx/rates";
import { policyInputOf } from "@/policy/assess";
import { assessTender, FINAL_STATUSES } from "@/policy/engine";
import { normalizeTedNotice } from "@/sources/eu-ted/normalize";
import { foldNotices } from "@/sources/fold";
import { normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { valueInEur } from "@/sources/value-eur";
import { sourcesHash } from "./evidence";
import { parseFacts } from "./facts";
import { checkFactsQuotes, evidencedFacts, readStoredFacts, type StoredFacts } from "./facts-evidence";
import { buildFactsInput, type FactsNotice } from "./facts-input";
import type { FactsOutput } from "./facts-schema";
import { toTriageNotice } from "./notice";

// The qualification pipeline end to end on recorded notices (docs/qualification-policy-v1.md
// part I), with only the model call replaced: the notice stored as the sync job
// stores it, the facts input built from it, a hand-written answer whose quotes
// are copied from the real texts, the quote checks stored with it, the facts
// the policy may act on and the verdict.

/** The day the team reviewed the examples. */
const NOW = new Date("2026-10-15T09:00:00+03:00");
/** A fixed test rate; the pipeline uses the ECB rate of the publication day. */
const RATES = buildRateTable([{ date: "2026-10-13", currency: "GBP", ratePerEur: 0.87 }]);

const NORMALIZERS = { "uk-fat": normalizeFatRelease, "eu-ted": normalizeTedNotice } as const;

/** A recorded notice as the pipeline stores it: the tender row, its lot rows and what the facts stage reads. */
function stored(source: keyof typeof NORMALIZERS, name: string): { tender: Tender; lotRows: Lot[]; notice: FactsNotice } {
  const normalized = NORMALIZERS[source](loadFixture(source, name));
  if (!normalized) throw new Error(`${name} normalized to null`);
  const f = foldNotices([normalized]);
  // The columns upsertTender writes (src/sources/store.ts), with the EUR value fillValueEur adds.
  const tender: Tender = {
    id: name,
    source: f.source,
    externalId: f.externalId,
    procedureKey: f.procedureKey,
    noticeType: f.noticeType,
    regime: f.regime,
    contractNature: f.contractNature,
    status: f.status,
    title: f.title,
    description: f.description,
    buyerName: f.buyerName,
    buyerCountry: f.buyerCountry,
    nutsCode: f.nutsCode,
    cpvMain: f.cpvMain,
    cpvAdditional: f.cpvAdditional,
    valueAmount: f.valueAmount,
    valueCurrency: f.valueCurrency,
    valueEur: valueInEur(f.valueAmount, f.valueCurrency, f.publishedAt, RATES),
    publishedAt: f.publishedAt,
    submissionDeadline: f.submissionDeadline,
    clarificationDeadline: f.clarificationDeadline,
    procedureType: f.procedureType,
    noticeLanguage: f.noticeLanguage,
    noticeUrl: f.noticeUrl,
    documentsPortalUrl: f.documentsPortalUrl,
    details: f.details,
    changedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const lotRows: Lot[] = f.lots.map((l, i) => ({ id: `${name}-lot-${i}`, tenderId: name, ...l }));
  // As loadFactsNotice reads it.
  const notice: FactsNotice = {
    ...toTriageNotice(tender, lotRows),
    documents: f.documents.map(({ title, documentType }) => ({ title, documentType })),
  };
  return { tender, lotRows, notice };
}

/**
 * The answer as extractFacts checks and stores it, read back as the assess job
 * reads it, and the policy's verdict on the facts it may act on.
 */
function pipeline(s: ReturnType<typeof stored>, answer: FactsOutput) {
  const { text, sources, lotNumbers } = buildFactsInput(s.notice);
  const parsed = parseFacts(answer, lotNumbers);
  if (!parsed.ok) throw new Error(parsed.error);
  const output: StoredFacts = {
    ...parsed.output,
    quoteChecks: checkFactsQuotes(parsed.output, sources),
    sourcesHash: sourcesHash(sources),
    inputUpdatedAt: s.tender.updatedAt.toISOString(),
  };
  const read = readStoredFacts(JSON.parse(JSON.stringify(output)));
  if (!read?.quoteChecks) throw new Error("The stored facts did not read back with their checks");
  const acted = evidencedFacts(read.facts, read.quoteChecks);
  return {
    text,
    checks: read.quoteChecks,
    acted,
    assessment: assessTender(policyInputOf(s.tender, s.lotRows, acted, RATES, NOW)),
    /** What the verdict would be if the answer were trusted without the checks. */
    unchecked: () => assessTender(policyInputOf(s.tender, s.lotRows, parsed.output, RATES, NOW)),
  };
}

const gate = (lotAssessment: { gates: { id: string; state: string }[] }, id: string) => lotAssessment.gates.find((g) => g.id === id)?.state;

describe("example 3: Find a Tender 096535-2026 breathing air compressor", () => {
  const answer = facts({
    summaryTr: "Cornwall Havalimanı için yedek solunum havası kompresörü; devreye alma, eğitim ve Birleşik Krallık'ta servis isteniyor.",
    lots: [
      lot({
        lotNumber: "1",
        productTr: "yüksek basınçlı solunum havası kompresörü",
        category: "SAFETY_CRITICAL_MACHINERY",
        categoryQuote: "Procurement of Replacement BA Compressor",
        productNature: "SPECIALISED",
        natureQuote: "Breathing air quality compliant with BS EN 12021 (latest version).",
      }),
    ],
    commissioningTraining: { value: "YES", detail: "Devreye alma, test ve operatör eğitimi tedarikçide", quote: "Supplier to provide commissioning, testing and operator training." },
    localService: { value: "REQUIRED", detail: "Birleşik Krallık merkezli servis ve teknik destek", quote: "UK-based servicing and technical support available." },
    warranty: { years: 1, detail: "Devreye almadan itibaren en az 12 ay", quote: "Minimum 12-month warranty from commissioning." },
    certifications: [
      { name: "BS EN 12021", level: "PRODUCT", quote: "Breathing air quality compliant with BS EN 12021 (latest version)." },
      { name: "UKCA", level: "PRODUCT", quote: "UKCA marked." },
    ],
    documentsToCheck: ["teknik şartname"],
  });
  const result = pipeline(stored("uk-fat", "uk4-policy-ba-compressor"), answer);

  it("finds the specification quotes in the document description the buyer wrote it in", () => {
    expect(result.text).toContain('<dokuman sira="1" tur="technicalSpecifications">');
    expect(result.checks.facts).toMatchObject({ commissioningTraining: "document:1", localService: "document:1", warranty: "document:1" });
    expect(result.checks.certifications).toEqual(["document:1", "document:1"]);
    expect(result.checks.lots).toEqual([{ category: "title", nature: "document:1", quantity: null }]);
    expect(result.acted.localService.value).toBe("REQUIRED");
  });

  it("is rejected for its on-site service and commissioning (delivery only), with the time gate still failing", () => {
    // Delivery only (policy.v2): the on-site work decides; H05 still records the time it would take.
    expect(result.assessment.status).toBe("COMMERCIAL_NO_BID");
    expect(gate(result.assessment.best, "H05")).toBe("FAIL");
    expect(result.assessment.best.explanation).toContain("ürün teslimine ek olarak yerinde servis");
  });
});

describe("example 1: TED 702149-2026 tyres with fitting services", () => {
  const tyreLot = (lotNumber: string, productTr: string, categoryQuote: string) =>
    lot({ lotNumber, productTr, category: "OTHER_GOODS", categoryQuote, productNature: "STANDARD", natureQuote: "нови, неупотребявани гуми" });
  const answer = facts({
    summaryTr: "24 ay boyunca araç lastiği ve jant tedariki; montaj, balans ve vulkanizasyon hizmetleriyle, üç lot.",
    lots: [
      tyreLot("LOT-0001", "binek ve hafif ticari araç lastikleri ve jantları", "гуми и джанти за леки и лекотоварни автомобили"),
      tyreLot("LOT-0002", "kamyon lastikleri ve jantları", "гуми и джанти за товарни автомобили"),
      tyreLot("LOT-0003", "tarım ve orman makinesi lastikleri ve jantları", "гуми и джанти за селскостопански машини"),
    ],
    installation: { value: "REQUIRED", detail: "Lastiklerin montajı ve balansı tedarikçide", quote: "Доставка, монтаж и баланс на гуми и джанти" },
    localService: {
      value: "REQUIRED",
      detail: "Montaj ve demontaj makinesi, balans makinesi ve kaldırıcı ile yerinde hizmet",
      quote: "не по-малко от 1 брой на „баланс-машина“ или еквивалентно оборудване",
    },
    contractDuration: { months: 24, quote: "за срок от 24 месеца" },
    deliveryPattern: { value: "REPEATED", detail: "24 ay boyunca ihtiyaca göre", quote: "за срок от 24 месеца" },
    // Only in <bilgiler>, so no quote (the facts prompt); the engine reads tenders.details.
    awardCriteria: { value: "LOWEST_PRICE", detail: "En düşük fiyat", quote: "" },
  });
  const result = pipeline(stored("eu-ted", "ted-policy-tyres-with-services"), answer);

  it("verifies the service obligation against the selection criterion", () => {
    expect(result.checks.facts).toMatchObject({ installation: "title", localService: "selection:1", contractDuration: "title", awardCriteria: null });
    expect(result.checks.lots.map((l) => l.category)).toEqual(["title", "title", "title"]);
    expect(result.acted.localService.value).toBe("REQUIRED");
  });

  it("is a commercial no-bid for every lot: fitting and repair services on site", () => {
    expect(result.assessment.status).toBe("COMMERCIAL_NO_BID");
    for (const lotAssessment of result.assessment.lots) {
      expect(lotAssessment.status).toBe("COMMERCIAL_NO_BID");
      expect(lotAssessment.explanation).toContain("ürün teslimine ek olarak sahada kurulum ve yerinde servis istiyor");
    }
  });
});

describe("a fact whose quote is not in the notice", () => {
  const answer = facts({
    summaryTr: "Açık hava kafe alanı için yıl boyu dışarıda kalacak sandalye ve masalar.",
    lots: [
      lot({
        lotNumber: "1",
        productTr: "dış mekân kafe sandalyeleri ve masaları",
        category: "FURNITURE_STORAGE",
        categoryQuote: "external cafe furniture comprising chairs and matching tables",
      }),
    ],
    // FaT 096735 says nothing like this.
    installation: { value: "REQUIRED", detail: "Mobilyaların sahada kurulumu", quote: "The supplier shall install the furniture on site." },
    restrictedProduct: { value: "NO", detail: "Sıradan ticari mobilya", quote: "High quality contemporary external cafe furniture" },
  });
  const result = pipeline(stored("uk-fat", "uk4-policy-cafe-furniture"), answer);

  it("is not found, so the policy treats it as unknown", () => {
    expect(result.checks.facts.installation).toBeNull();
    expect(result.checks.facts.restrictedProduct).toBe("description");
    expect(result.acted.installation.value).toBe("UNKNOWN");
    expect(result.acted.restrictedProduct.value).toBe("NO");
  });

  it("does not reject the tender, which trusting the answer would have done", () => {
    expect(result.unchecked().status).toBe("COMMERCIAL_NO_BID");
    expect(FINAL_STATUSES).not.toContain(result.assessment.status);
    expect(result.assessment.status).toBe("NEEDS_DOCUMENTS");
    expect(gate(result.assessment.best, "C01")).toBe("FAIL");
  });
});
