import { describe, expect, it } from "vitest";
import type { FactsOutput } from "@/analysis/facts-schema";
import { normalizeTedNotice } from "@/sources/eu-ted/normalize";
import type { NoticeDetails } from "@/sources/types";
import { normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { details, facts, lot } from "../../tests/helpers/facts";
import { loadFixture } from "../../tests/helpers/fixtures";
import { assessTender as assessWith, expectedScore, FINAL_STATUSES, type LotAssessment, type PolicyInput, type TenderAssessment } from "./engine";
import { POLICY, type Policy } from "./policy";

// The regression set of the qualification policy (docs/qualification-policy-v1.md
// parts I and IX): five tenders the team rejected and one it liked. The
// notices are the recorded payloads; the facts are what the facts stage should
// extract, first from the notice alone, then with what the documents said.

/**
 * The policy document's rules with on-site work allowed through partners
 * (supplyOnly off): the examples below test them. The delivery-only stage the
 * team chose on 16 October 2026 has its own tests further down.
 */
const NUANCED: Policy = { ...POLICY, supplyOnly: false };
const assessTender = (input: PolicyInput, policy: Policy = NUANCED) => assessWith(input, policy);

/** The day the team reviewed the examples. */
const REVIEWED = new Date("2026-10-15T09:00:00+03:00");
/** A fixed test rate; the pipeline uses the ECB rate of the publication day. */
const GBP_EUR = 1.15;

const toEur = (amount: number | null, currency: string | null) => (amount === null ? null : currency === "GBP" ? amount * GBP_EUR : amount);

/**
 * The policy input the assess job builds, from a recorded notice ("<source>/<name>"
 * under tests/fixtures) run through its normalizer, structured details included.
 */
function inputFor(
  fixture: string,
  extracted: FactsOutput,
  options: { now?: Date; details?: NoticeDetails; deadline?: Date } = {},
): PolicyInput {
  const [source, name] = fixture.split("/") as [string, string];
  const raw = loadFixture(source, name);
  const notice = source === "uk-fat" ? normalizeFatRelease(raw) : normalizeTedNotice(raw);
  if (!notice) throw new Error(`${fixture} did not normalize`);
  return {
    tender: {
      valueEur: toEur(notice.valueAmount, notice.valueCurrency),
      submissionDeadline: options.deadline ?? notice.submissionDeadline,
      buyerCountry: notice.buyerCountry,
      noticeLanguage: notice.noticeLanguage,
      details: options.details ?? notice.details ?? null,
    },
    lots: (notice.lots ?? []).map((l) => ({ lotNumber: l.lotNumber, valueEur: toEur(l.valueAmount, l.valueCurrency) })),
    facts: extracted,
    now: options.now ?? REVIEWED,
  };
}

const gateState = (lotResult: LotAssessment, id: string) => lotResult.gates.find((g) => g.id === id)?.state;
const statuses = (result: TenderAssessment) => result.lots.map((l) => l.status);

// ---------------------------------------------------------------------------
// Example 1: TED 702149-2026, tyres and rims with fitting services, Bulgaria

const tyreLots = [
  lot({ lotNumber: "LOT-0001", productTr: "binek ve hafif ticari araç lastikleri ve jantları", category: "OTHER_GOODS", productNature: "STANDARD" }),
  lot({ lotNumber: "LOT-0002", productTr: "kamyon lastikleri ve jantları", category: "OTHER_GOODS", productNature: "STANDARD" }),
  lot({ lotNumber: "LOT-0003", productTr: "tarım ve orman makinesi lastikleri ve jantları", category: "OTHER_GOODS", productNature: "STANDARD" }),
];

const tyreFacts = facts({
  summaryTr: "24 ay boyunca araç lastiği ve jant tedariki; montaj, balans ve vulkanizasyon hizmetleriyle, üç lot.",
  lots: tyreLots,
  installation: { value: "REQUIRED", detail: "Lastiklerin montajı ve balansı tedarikçide", quote: "Доставка, монтаж и баланс на гуми и джанти" },
  localService: {
    value: "REQUIRED",
    detail: "Demontaj, yapıştırma, balans, jant düzeltme ve vulkanizasyon hizmetleri",
    quote: "услуги по демонтаж, лепене, баланс, изправяне на джанти, вулканизация",
  },
  contractDuration: { months: 24, quote: "за срок от 24 месеца" },
  deliveryPattern: { value: "REPEATED", detail: "24 ay boyunca ihtiyaca göre", quote: "за срок от 24 месеца" },
});

describe("example 1: TED 702149-2026 tyres with fitting services", () => {
  const result = assessTender(inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts));

  it("is a commercial no-bid for every lot, explained with the value, the duration and the missing partner", () => {
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(statuses(result)).toEqual(["COMMERCIAL_NO_BID", "COMMERCIAL_NO_BID", "COMMERCIAL_NO_BID"]);
    const first = result.lots[0]!;
    expect(first.valueEur).toBe(8000);
    expect(first.explanation).toContain("Lot 1 (binek ve hafif ticari araç lastikleri ve jantları) 8.000 EUR değerinde ve 24 ay sürüyor");
    expect(first.explanation).toContain("sahada kurulum ve yerinde servis zorunlu");
    expect(first.explanation).toContain("Bulgaristan için doğrulanmış servis ortağımız yok");
    expect(first.explanation).toContain("toplam katkı yaklaşık 1.600 EUR");
    // The small repeated orders are a second reason; the installation is already named.
    expect(first.explanation).toContain("Ayrıca tutar 24 aya yayılan, ihtiyaca göre tekrarlanan siparişlerle geliyor (aylık ortalama yaklaşık 333 EUR).");
    expect(first.explanation).not.toContain("Ayrıca bu düşük tutarlı alımda sahada kurulum var");
    expect(first.actions).toEqual([]);
  });

  it("keeps the service objection a commercial one: a partner would leave only the economics", () => {
    const withPartner = { ...NUANCED, servicePartnerCountries: ["BG"] };
    const repeated = assessTender(inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts), withPartner);
    // Lot 1 still earns about 333 EUR a month over 24 months.
    expect(repeated.lots[0]!.status).toBe("COMMERCIAL_NO_BID");
    expect(repeated.lots[0]!.explanation).toContain("aylık ortalama yaklaşık 333 EUR");

    const singleDelivery = facts({ ...tyreFacts, deliveryPattern: { value: "SINGLE", detail: "", quote: "" } });
    const reopened = assessTender(inputFor("eu-ted/ted-policy-tyres-with-services", singleDelivery), withPartner);
    expect(statuses(reopened)).not.toContain("COMMERCIAL_NO_BID");
    expect(gateState(reopened.lots[0]!, "C03")).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// Example 2: TED 634842-2026, vehicle spare parts over 24 months, Bulgaria

const sparePartsFacts = facts({
  summaryTr: "24 ay boyunca orman işletmesinin araçları için yedek parça ve aksesuar tedariki.",
  lots: [lot({ lotNumber: "LOT-0001", productTr: "araç yedek parçaları ve aksesuarları", category: "OTHER_GOODS" })],
  contractDuration: { months: 24, quote: "за срок от 24 месеца" },
  deliveryPattern: { value: "REPEATED", detail: "İhtiyaca göre 24 ay boyunca", quote: "за нуждите на ТП „ДГС Разлог“ за срок от 24 месеца" },
});

describe("example 2: TED 634842-2026 vehicle spare parts", () => {
  it("is a commercial no-bid: small repeated orders over 24 months", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-spare-parts-24-months", sparePartsFacts));
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toContain("25.000 EUR değerinde; bu tutar 24 aya yayılan, ihtiyaca göre tekrarlanan siparişlerle geliyor");
    expect(result.best.explanation).toContain("aylık ortalama yaklaşık 1.042 EUR");
  });

  it("does not reject on an inference: electronic ordering over 24 months only points to repeated orders", () => {
    const silent = facts({ ...sparePartsFacts, deliveryPattern: { value: "UNKNOWN", detail: "", quote: "" } });
    const result = assessTender(inputFor("eu-ted/ted-policy-spare-parts-24-months", silent));
    expect(result.status).toBe("NEEDS_DOCUMENTS");
    expect(result.best.explanation).toContain("Elektronik sipariş ve 24 aylık süre tekrarlanan siparişlere işaret ediyor");
    expect(result.best.explanation).toContain("teslimat düzeni");
    expect(result.best.dimensions.C.notes).toContain("Teslimat düzeni yazmıyor; elektronik sipariş ve 24 ay süre tekrarlanan siparişlere işaret ediyor.");
  });

  it("reports the commercial reason too when a hard gate decides, and words a deadline with no working day left", () => {
    const withReference = facts({
      ...sparePartsFacts,
      pastPerformance: { value: "REQUIRED", detail: "Yedek parça teslimi deneyimi", quote: "Доставка на резервни части." },
    });
    // Friday after review: the Sunday deadline leaves no working day.
    const result = assessTender(inputFor("eu-ted/ted-policy-spare-parts-24-months", withReference, { now: new Date("2026-10-16T09:00:00+03:00") }));
    expect(result.status).toBe("NO_BID");
    expect(result.best.explanation).toContain("başka bir kuruluşun kapasitesine dayanan uygun bir düzen son tarihe iş günü kalmadığından kurulamaz");
    expect(result.best.explanation).toContain("Ayrıca ticari olarak da uygun değil: tutar 24 aya yayılan, ihtiyaca göre tekrarlanan siparişlerle geliyor (aylık ortalama yaklaşık 1.042 EUR).");
    expect(result.best.explanation).not.toContain("0 iş gün");
  });

  it("does not reject the same value delivered at once (part I, system lesson)", () => {
    const single = facts({ ...sparePartsFacts, deliveryPattern: { value: "SINGLE", detail: "Tek teslimat", quote: "" } });
    const result = assessTender(inputFor("eu-ted/ted-policy-spare-parts-24-months", single));
    expect(result.status).not.toBe("COMMERCIAL_NO_BID");
  });
});

// ---------------------------------------------------------------------------
// Example 3: Find a Tender 096535-2026, breathing air compressor, Cornwall

const compressorLot = lot({
  lotNumber: "1",
  productTr: "solunum havası kompresörü",
  category: "SAFETY_CRITICAL_MACHINERY",
  categoryQuote: "Replacement BA Compressor",
  productNature: "SPECIALISED",
  quantity: { text: "1 adet", kind: "FIXED", quote: "Replacement BA Compressor" },
});

/** From the title and description alone: the specification sits in a notice document's description. */
const compressorNoticeFacts = facts({ summaryTr: "Cornwall Havalimanı için yedek solunum havası kompresörü.", lots: [compressorLot] });

/** With the specification the buyer put in the notice document's description. */
const compressorFacts = facts({
  ...compressorNoticeFacts,
  commissioningTraining: { value: "YES", detail: "Devreye alma, test ve operatör eğitimi tedarikçide", quote: "Supplier to provide commissioning, testing and operator training." },
  localService: { value: "REQUIRED", detail: "Birleşik Krallık merkezli servis ve teknik destek", quote: "UK-based servicing and technical support available." },
  warranty: { years: 1, detail: "Devreye almadan itibaren en az 12 ay", quote: "Minimum 12-month warranty from commissioning." },
  certifications: [
    { name: "BS EN 12021", level: "PRODUCT", quote: "Breathing air quality compliant with BS EN 12021 (latest version)." },
    { name: "UKCA", level: "PRODUCT", quote: "UKCA marked." },
  ],
});

describe("example 3: Find a Tender 096535-2026 breathing air compressor", () => {
  it("needs the documents when only the title and description are read", () => {
    const result = assessTender(inputFor("uk-fat/uk4-policy-ba-compressor", compressorNoticeFacts));
    expect(result.status).toBe("NEEDS_DOCUMENTS");
    expect(result.best.explanation).toContain("Son tarihe yalnızca 3 iş günü var");
  });

  it("is a no-bid when commissioning and UK support cannot be arranged before the deadline", () => {
    const result = assessTender(inputFor("uk-fat/uk4-policy-ba-compressor", compressorFacts));
    expect(result.status).toBe("NO_BID");
    expect(gateState(result.best, "H05")).toBe("FAIL");
    expect(result.best.explanation).toBe(
      "Bu solunum havası kompresörü alımı güvenlik açısından kritik bir ürün için yerinde servis ve devreye alma ile operatör eğitimi gerektiriyor. " +
        "Birleşik Krallık için doğrulanmış ortağımız yok; son tarihe kalan 3 iş gününde sertifikalı üretici ve servis ortağı bulunamaz.",
    );
    expect(result.best.actions).toEqual([]);
  });

  it("needs a certified manufacturer and a local service partner when there is time", () => {
    const withInstallation = facts({
      ...compressorFacts,
      installation: { value: "REQUIRED", detail: "Mevcut dolum düzenine bağlantı", quote: "" },
    });
    const result = assessTender(inputFor("uk-fat/uk4-policy-ba-compressor", withInstallation, { deadline: new Date("2026-12-01T12:00:00Z") }));
    // Not the small-installation rule of example 5: specialised equipment is installed through the manufacturer's network.
    expect(result.status).toBe("NEEDS_PARTNER");
    expect(result.best.explanation).toContain("sertifikalı üretici ve yerel servis ortağı bulunmadan teklif verilemez");
    expect(result.best.actions[0]).toBe("Sertifikalı üreticinin Birleşik Krallık servis ağı olup olmadığını sor.");
    expect(result.best.actions).toContain("BS EN 12021, UKCA belgesinin üreticide ve ürün modelinde olduğunu doğrula.");
  });
});

// ---------------------------------------------------------------------------
// Example 4: TED 711554-2026, generators for the Lithuanian defence agency

const generatorLots = [
  lot({ lotNumber: "LOT-0001", productTr: "taşınabilir 6 kW jeneratör", category: "BASIC_EQUIPMENT", productNature: "STANDARD" }),
  lot({ lotNumber: "LOT-0002", productTr: "taşınabilir 10 kW jeneratör", category: "BASIC_EQUIPMENT", productNature: "STANDARD" }),
  lot({ lotNumber: "LOT-0003", productTr: "römorklu 20 kW jeneratör", category: "COMPLEX_GENERATORS" }),
  lot({ lotNumber: "LOT-0004", productTr: "römorklu 50 kW jeneratör", category: "COMPLEX_GENERATORS" }),
  lot({ lotNumber: "LOT-0005", productTr: "römorklu 100 kW jeneratör", category: "COMPLEX_GENERATORS" }),
  lot({ lotNumber: "LOT-0006", productTr: "römorklu 200 kW jeneratör", category: "COMPLEX_GENERATORS" }),
];

const generatorNoticeFacts = facts({
  summaryTr: "Litvanya savunma kaynakları ajansı için altı lotta elektrik jeneratörü.",
  lots: generatorLots,
  restrictedProduct: { value: "NO", detail: "Sıradan ticari jeneratörler", quote: "Elektros generatoriai" },
});

/** What the qualification documents said (part I, example 4). */
const generatorFacts = facts({
  ...generatorNoticeFacts,
  lots: generatorLots.map((l, i) => ({ ...l, quantity: { text: ["70-91", "369-479", "49-63", "38-49", "97-126", "57-74"][i]! + " adet", kind: "MIN_MAX" as const, quote: "" } })),
  pastPerformance: {
    value: "REQUIRED",
    detail: "Referans döneminde lot başına jeneratör teslimatı, ör. Lot 1 için 98.467 EUR, Lot 2 için 649.609 EUR",
    quote: "",
  },
  localService: { value: "REQUIRED", detail: "Servis ve yedek parça yükümlülükleri", quote: "" },
  contractDuration: { months: 36, quote: "" },
  deliveryPattern: { value: "FEW", detail: "Partiler halinde; Lot 2 ilk teslimat 153 adet", quote: "" },
});

describe("example 4: TED 711554-2026 defence agency generators", () => {
  it("needs the documents from the notice alone, with the deadline close", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-generators-defence", generatorNoticeFacts));
    expect(statuses(result)).toEqual(Array(6).fill("NEEDS_DOCUMENTS"));
    expect(result.best.lotNumber).toBe("LOT-0001");
    expect(result.best.explanation).toContain("referans şartları");
    expect(result.best.explanation).toContain("Son tarihe yalnızca 3 iş günü var");
    expect(result.best.actions[0]).toMatch(/^Dokümanları indirip incele/);
    // A defence buyer alone is not a restriction (part IV.7, part XI).
    expect(gateState(result.best, "H04")).toBe("PASS");
  });

  it("is a no-bid once the documents show past deliveries BOZKOR cannot borrow in three working days", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-generators-defence", generatorFacts));
    expect(statuses(result)).toEqual(Array(6).fill("NO_BID"));
    expect(gateState(result.best, "H03")).toBe("FAIL");
    expect(result.best.explanation).toContain("geçmiş teslimat referansı (Referans döneminde lot başına jeneratör teslimatı, ör. Lot 1 için 98.467 EUR");
    expect(result.best.explanation).toContain("son tarihe kalan 3 iş gününde kurulamaz");
    expect(result.best.explanation).toContain("Litvanya için doğrulanmış ortağımız yok");
  });

  it("needs a qualification review, not a partner, when there is time to arrange reliance on a manufacturer", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-generators-defence", generatorFacts, { deadline: new Date("2026-12-15T10:00:00+02:00") }));
    expect(statuses(result)).toEqual(Array(6).fill("NEEDS_QUALIFICATION_REVIEW"));
    expect(result.best.explanation).toContain("Üreticinin kataloğu ya da genel yetki belgesi yeterli değildir");
    expect(result.best.actions[0]).toBe("Alıcıya başka bir kuruluşun (üreticinin) referanslarına ve kapasitesine dayanmanın kabul edilip edilmediğini sor.");
    expect(gateState(result.best, "C09")).toBe("FAIL");
    expect(gateState(result.best, "H03")).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Example 5: TED 599159-2026, street lighting with installation, Malta

const lightingFacts = facts({
  summaryTr: "Gharghur sokaklarına braket üzerine enerji verimli armatürlerin kurulumu.",
  lots: [
    lot({
      lotNumber: "LOT-0001",
      productTr: "enerji verimli sokak armatürleri",
      category: "ELECTRICAL_LIGHTING",
      productNature: "STANDARD",
      categoryQuote: "LOW POLLUTION AND ENERGY EFFICIENT LUMINAIRES (ON BRACKET)",
    }),
  ],
  installation: {
    value: "REQUIRED",
    detail: "Armatürlerin sokaklarda braket üzerine kurulumu",
    quote: "TENDER FOR THE INSTALLATION OF LOW POLLUTION AND ENERGY EFFICIENT LUMINAIRES (ON BRACKET) IN VARIOUS STREETS",
  },
});

describe("example 5: TED 599159-2026 street lighting with installation", () => {
  it("is expired on the day it was reviewed", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-street-lighting-install", lightingFacts));
    expect(result.status).toBe("EXPIRED");
    expect(gateState(result.best, "H01")).toBe("FAIL");
    expect(result.best.explanation).toContain("Son teklif tarihi geçti.");
    expect(result.best.actions).toEqual([]);
  });

  it("was a commercial no-bid before the deadline: site installation on 14,000 EUR", () => {
    const result = assessTender(inputFor("eu-ted/ted-policy-street-lighting-install", lightingFacts, { now: new Date("2026-09-01T09:00:00+03:00") }));
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toBe(
      "Bu enerji verimli sokak armatürleri alımı 14.000 EUR değerinde ve sahada kurulum içeriyor. " +
        "Malta için kurulum ortağımız yok; yerel kurulum maliyeti bu tutarda marjın çoğunu tüketir. Yalnızca tedarik içeren benzer ihaleler uygun olabilir.",
    );
  });

  it("keeps the category open for supply-only tenders", () => {
    const supplyOnly = facts({ ...lightingFacts, installation: { value: "NONE", detail: "Yalnızca teslim", quote: "" } });
    const result = assessTender(inputFor("eu-ted/ted-policy-street-lighting-install", supplyOnly, { now: new Date("2026-09-01T09:00:00+03:00") }));
    expect(result.status).toBe("NEEDS_DOCUMENTS");
  });
});

// ---------------------------------------------------------------------------
// Positive example A: Find a Tender 096735-2026, outdoor cafe furniture, Eryri

const furnitureLot = lot({
  lotNumber: "1",
  productTr: "dış mekân kafe sandalyeleri ve masaları",
  category: "FURNITURE_STORAGE",
  categoryQuote: "High quality contemporary external cafe furniture comprising chairs and matching tables",
  productNature: "STANDARD",
});

const furnitureNoticeFacts = facts({
  summaryTr: "Açık hava kafe alanı için yıl boyu dışarıda kalacak sandalye ve masalar.",
  lots: [furnitureLot],
  restrictedProduct: { value: "NO", detail: "", quote: "" },
  awardCriteria: { value: "PRICE_QUALITY", detail: "Fiyat %60, kalite %40", quote: "" },
  documentsToCheck: ["teknik şartname (Tender details and specification)"],
});

const furnitureFacts = facts({
  ...furnitureNoticeFacts,
  lots: [{ ...furnitureLot, quantity: { text: "20 sandalye, 5 masa, 1 istifleme arabası", kind: "FIXED", quote: "" } }],
  installation: { value: "NONE", detail: "Yalnızca teslim", quote: "" },
  commissioningTraining: { value: "NO", detail: "", quote: "" },
  localService: { value: "NOT_REQUIRED", detail: "", quote: "" },
  warranty: { years: 15, detail: "15 yıl garanti", quote: "" },
  deliveryPattern: { value: "SINGLE", detail: "Tek teslimat", quote: "" },
  deliveryPoints: { value: "ONE", detail: "", quote: "" },
  pastPerformance: { value: "NOT_REQUIRED", detail: "", quote: "" },
  turnover: { value: "NOT_REQUIRED", detail: "", quote: "" },
  samples: { value: "NO", quote: "" },
});

describe("positive example A: Find a Tender 096735-2026 outdoor cafe furniture", () => {
  it("is a promising match that needs the documents from the notice alone", () => {
    const result = assessTender(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureNoticeFacts));
    expect(result.status).toBe("NEEDS_DOCUMENTS");
    expect(result.best.scores.fit.high).toBeGreaterThanOrEqual(POLICY.bands.priority);
    expect(result.best.segment).toBe("B");
    expect(result.best.actions[0]).toBe("Dokümanları indirip incele: teknik şartname (Tender details and specification).");
  });

  it("needs the manufacturer's written 15-year warranty, not bid approval, once the documents are read", () => {
    const result = assessTender(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureFacts));
    expect(result.status).toBe("NEEDS_SUPPLIER");
    expect(result.best.scores.fit.low).toBeGreaterThanOrEqual(POLICY.bands.strong);
    expect(result.best.explanation).toContain("İstenen 15 yıllık garantiyi üretici yazılı olarak üstlenmeli");
    expect(result.best.actions[0]).toBe("Üreticiden 15 yıllık garanti ve yedek parça taahhüdünü yazılı al.");
    expect(gateState(result.best, "C01")).toBe("PASS");
    expect(gateState(result.best, "C02")).toBe("FAIL");
  });

  it("narrows the ranges and raises the confidence as facts become known", () => {
    const notice = assessTender(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureNoticeFacts)).best;
    const documents = assessTender(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureFacts)).best;
    const width = (r: { low: number; high: number }) => r.high - r.low;
    expect(width(documents.scores.preliminary)).toBeLessThan(width(notice.scores.preliminary));
    expect(documents.confidence).toBeGreaterThan(notice.confidence);
  });
});

// ---------------------------------------------------------------------------
// Rules beyond the examples

const pipeFacts = facts({
  lots: [lot({ lotNumber: "1", productTr: "HDPE boru", category: "PIPES_FITTINGS", productNature: "STANDARD", quantity: { text: "3.000 m", kind: "FIXED", quote: "" } })],
  installation: { value: "NONE", detail: "", quote: "" },
  commissioningTraining: { value: "NO", detail: "", quote: "" },
  localService: { value: "NOT_REQUIRED", detail: "", quote: "" },
  warranty: { years: 2, detail: "", quote: "" },
  deliveryPattern: { value: "SINGLE", detail: "", quote: "" },
  deliveryPoints: { value: "ONE", detail: "", quote: "" },
  pastPerformance: { value: "NOT_REQUIRED", detail: "", quote: "" },
  turnover: { value: "NOT_REQUIRED", detail: "", quote: "" },
  restrictedProduct: { value: "NO", detail: "", quote: "" },
});

function syntheticInput(extracted: FactsOutput, tender: Partial<PolicyInput["tender"]> = {}): PolicyInput {
  return {
    tender: {
      valueEur: 70_000,
      submissionDeadline: new Date("2026-11-30T12:00:00Z"),
      buyerCountry: "PL",
      noticeLanguage: "PL",
      details: null,
      ...tender,
    },
    lots: [],
    facts: extracted,
    now: REVIEWED,
  };
}

describe("rules that prevent false rejections (part XI)", () => {
  it("keeps a 70,000 EUR single-delivery pipe contract over 36 months in a non-English language", () => {
    const result = assessTender(syntheticInput(facts({ ...pipeFacts, contractDuration: { months: 36, quote: "" } })));
    expect(result.status).toBe("NEEDS_SUPPLIER");
    expect(result.best.segment).toBe("E");
    expect(result.best.actions).toContain("Teklif dili PL: çeviri süresini ve maliyetini planla.");
    expect(result.best.actions).toContain("Büyük ihale: ortaklık ya da üretici liderliğinde teklif modelini değerlendir.");
  });

  it("rejects a 20,000 EUR multi-year maintenance contract instead", () => {
    const maintenance = facts({
      ...pipeFacts,
      localService: { value: "REQUIRED", detail: "Periyodik bakım", quote: "" },
      contractDuration: { months: 24, quote: "" },
    });
    expect(assessTender(syntheticInput(maintenance, { valueEur: 20_000 })).status).toBe("COMMERCIAL_NO_BID");
  });

  it("does not fail a gate on silence: unknown stays unknown", () => {
    const silent = facts({ lots: [lot({ productTr: "metal raf", category: "FURNITURE_STORAGE" })] });
    const result = assessTender(syntheticInput(silent, { valueEur: 20_000 }));
    for (const id of ["H03", "H04", "H05", "C03", "C09"]) expect(gateState(result.best, id)).toBe("UNKNOWN");
    expect(result.status).toBe("NEEDS_DOCUMENTS");
  });

  it("does not reject a CE or ISO mention: product certificates only wait on verification", () => {
    const certified = facts({ ...pipeFacts, certifications: [{ name: "EN 12201", level: "PRODUCT", quote: "" }] });
    const result = assessTender(syntheticInput(certified));
    expect(result.status).toBe("NEEDS_SUPPLIER");
    expect(gateState(result.best, "C05")).toBe("FAIL");
  });
});

describe("qualification gaps", () => {
  const iso = facts({ ...pipeFacts, certifications: [{ name: "ISO 9001", level: "BIDDER", quote: "" }] });

  it("sends a bidder-level certificate BOZKOR lacks to qualification review", () => {
    const result = assessTender(syntheticInput(iso));
    expect(result.status).toBe("NEEDS_QUALIFICATION_REVIEW");
    expect(result.best.explanation).toContain("istekli belgesi (ISO 9001)");
  });

  it("clears it when the policy lists the certificate as held", () => {
    const result = assessTender(syntheticInput(iso), { ...NUANCED, bidderCertifications: ["ISO-9001"] });
    expect(result.status).toBe("NEEDS_SUPPLIER");
  });
});

describe("structured notice details", () => {
  it("take precedence over the model's reading of the text", () => {
    const short = facts({ ...pipeFacts, framework: { value: "NO", quote: "" }, contractDuration: { months: 6, quote: "" } });
    const result = assessTender(
      syntheticInput(short, {
        valueEur: 20_000,
        details: details({ durationMonths: 24, framework: true, awardCriteria: [{ type: "price", name: "Price", weight: 100, description: null }] }),
      }),
    );
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toContain("alım miktarı garanti edilmeyen bir çerçeve anlaşmayla");
    expect(result.best.dimensions.H.notes).toContain("En düşük fiyatla değerlendirme.");
  });
});

describe("lot-level obligations (part XII.1)", () => {
  const twoLots = (installationLots: string[]) =>
    facts({
      ...pipeFacts,
      lots: [
        lot({ lotNumber: "LOT-0001", productTr: "LED armatür", category: "ELECTRICAL_LIGHTING", productNature: "STANDARD", quantity: { text: "200 adet", kind: "FIXED", quote: "" } }),
        lot({ lotNumber: "LOT-0002", productTr: "armatür montajı", category: "ELECTRICAL_LIGHTING", productNature: "STANDARD", quantity: { text: "200 adet", kind: "FIXED", quote: "" } }),
      ],
      installation: { value: "REQUIRED", detail: "Lot 2'de montaj", quote: "", lots: installationLots },
    });
  const lots = [
    { lotNumber: "LOT-0001", valueEur: 12_000 },
    { lotNumber: "LOT-0002", valueEur: 8_000 },
  ];

  it("applies an obligation only to the lots it is stated for; the others are unknown, not rejected", () => {
    for (const listed of [["LOT-0002"], ["2"]]) {
      const result = assessTender({ ...syntheticInput(twoLots(listed), { valueEur: 20_000 }), lots });
      expect(result.lots.map((l) => l.status)).toEqual(["NEEDS_DOCUMENTS", "COMMERCIAL_NO_BID"]);
      expect(result.status).toBe("NEEDS_DOCUMENTS");
      expect(result.lots[0]!.explanation).toContain("kurulum yükümlülüğü");
    }
  });

  it("applies an obligation without lots to every lot", () => {
    const result = assessTender({ ...syntheticInput(twoLots([]), { valueEur: 20_000 }), lots });
    expect(result.lots.map((l) => l.status)).toEqual(["COMMERCIAL_NO_BID", "COMMERCIAL_NO_BID"]);
  });
});

describe("rules refined after review", () => {
  const soon = { submissionDeadline: new Date("2026-10-21T12:00:00Z") };

  it("does not treat training alone on a standard product as a local obligation", () => {
    const pump = facts({
      ...pipeFacts,
      lots: [lot({ lotNumber: "1", productTr: "dalgıç pompa", category: "BASIC_EQUIPMENT", productNature: "STANDARD", quantity: { text: "4 adet", kind: "FIXED", quote: "" } })],
      commissioningTraining: { value: "YES", detail: "Operatör eğitimi", quote: "" },
    });
    const result = assessTender(syntheticInput(pump, { ...soon, valueEur: 20_000, buyerCountry: "IE" }));
    expect(result.status).not.toBe("NO_BID");
    expect(result.best.actions).toContain("Eğitim ya da devreye almanın uzaktan ya da üretici tesisinde yapılıp yapılamayacağını alıcıya sor.");
  });

  it("sends a turnover threshold to qualification review even close to the deadline: it is not compared yet", () => {
    const shelving = facts({ ...pipeFacts, turnover: { value: "REQUIRED", detail: "Son yılda en az 10.000 GBP ciro", quote: "" } });
    const result = assessTender(syntheticInput(shelving, { ...soon, valueEur: 20_000 }));
    expect(result.status).toBe("NEEDS_QUALIFICATION_REVIEW");
    expect(gateState(result.best, "H03")).toBe("UNKNOWN");
    expect(result.best.explanation).toContain("Bozkor'un bunu kendi başına karşıladığı doğrulanmadı");
  });

  it("keeps a known gap and an unchecked one apart in the reasons", () => {
    const both = facts({
      ...pipeFacts,
      pastPerformance: { value: "REQUIRED", detail: "Son 3 yılda benzer teslimat", quote: "" },
      turnover: { value: "REQUIRED", detail: "Yıllık 50.000 EUR ciro", quote: "" },
    });
    const result = assessTender(syntheticInput(both));
    expect(result.status).toBe("NEEDS_QUALIFICATION_REVIEW");
    expect(result.best.explanation).toContain(
      "Bozkor geçmiş teslimat referansı şartını kendi başına karşılamıyor; asgari ciro şartını karşıladığı da doğrulanmadı",
    );
  });

  it("names award criteria without a name by their type in Turkish", () => {
    const unnamed = details({
      awardCriteria: [
        { type: "price", name: null, weight: 60, description: null },
        { type: "quality", name: null, weight: 40, description: null },
      ],
    });
    const result = assessTender(syntheticInput(pipeFacts, { details: unnamed }));
    expect(result.best.dimensions.H.notes).toContain("Fiyat ve kalite birlikte değerlendiriliyor: fiyat %60, kalite %40.");
  });

  it("puts project approvals and certificates of unclear level under compliance, with a next step each", () => {
    const certified = facts({
      ...pipeFacts,
      certifications: [
        { name: "Network Rail PADS", level: "PROJECT", quote: "" },
        { name: "ISO 14001", level: "UNKNOWN", quote: "" },
      ],
    });
    const result = assessTender(syntheticInput(certified));
    expect(gateState(result.best, "C05")).toBe("FAIL");
    expect(result.best.actions).toContain("Network Rail PADS onayının süresini ve maliyetini öğren.");
    expect(result.best.actions).toContain("ISO 14001 belgesini kimin sağlaması gerektiğini dokümanlardan belirle.");
  });

  it("reads the award method from typed criteria and ignores description-only entries", () => {
    const withPassMark = details({
      awardCriteria: [
        { type: "price", name: "Price", weight: null, description: null },
        { type: null, name: null, weight: null, description: "Quality pass mark 60%" },
      ],
    });
    const result = assessTender(syntheticInput(pipeFacts, { details: withPassMark }));
    expect(result.best.dimensions.H.notes).toContain("En düşük fiyatla değerlendirme.");
  });

  it("does not give a lot the whole tender's value or contribution", () => {
    const tyresNoLotValues = assessTender({ ...inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts), lots: [] });
    const second = tyresNoLotValues.lots[1]!;
    expect(second.valueEur).toBeNull();
    expect(second.explanation).toContain("Lot 2 (kamyon lastikleri ve jantları) için lot değeri belirtilmemiş (ihalenin tamamı 24.100 EUR)");
    expect(second.explanation).not.toContain("toplam katkı");
  });

  it("keeps the long-contract service rule for service: installation alone falls to the installation rule", () => {
    const installOnly = facts({
      ...pipeFacts,
      installation: { value: "REQUIRED", detail: "", quote: "" },
      contractDuration: { months: 24, quote: "" },
    });
    const result = assessTender(syntheticInput(installOnly, { valueEur: 20_000 }));
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toContain("sahada kurulum içeriyor");
    expect(result.best.explanation).not.toContain("servis ortağımız yok");
  });

  it("calls a specialised product specialised, and only safety-critical machinery safety-critical", () => {
    const analyser = facts({
      ...pipeFacts,
      lots: [lot({ lotNumber: "1", productTr: "laboratuvar analiz cihazı", category: "COMPLEX_ELECTRONICS", productNature: "SPECIALISED" })],
      localService: { value: "REQUIRED", detail: "", quote: "" },
    });
    const result = assessTender(syntheticInput(analyser, { ...soon, valueEur: 50_000 }));
    expect(result.status).toBe("NO_BID");
    expect(result.best.explanation).toContain("uzmanlık isteyen bir ürün için");
    expect(result.best.explanation).not.toContain("güvenlik açısından kritik");
  });

  it("lets a quoted lack of guaranteed volume count as a framework even when the details say none", () => {
    const noGuarantee = facts({
      ...pipeFacts,
      deliveryPattern: { value: "UNKNOWN", detail: "", quote: "" },
      framework: { value: "YES", quote: "no guarantee of volume" },
    });
    const result = assessTender(syntheticInput(noGuarantee, { valueEur: 20_000, details: details({ framework: false, durationMonths: 24 }) }));
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toContain("alım miktarı garanti edilmeyen bir çerçeve anlaşmayla");
  });

  it("writes a capitalised product name in lower case inside the sentence, but keeps acronyms", () => {
    const named = (productTr: string) =>
      assessTender(syntheticInput(facts({ ...pipeFacts, lots: [lot({ lotNumber: "1", productTr, category: "PIPES_FITTINGS", productNature: "STANDARD" })] }))).best
        .explanation;
    expect(named("Motorlu araç yedek parçası")).toContain("Bu motorlu araç yedek parçası alımı");
    expect(named("BA solunum havası kompresörü")).toContain("Bu BA solunum havası kompresörü alımı");
  });

  it("rejects a services lot as out of scope, but not goods with a service attached", () => {
    const maintenance = facts({
      ...pipeFacts,
      lots: [lot({ lotNumber: "1", productTr: "tarım makinesi bakım-onarım hizmeti", category: "OTHER_GOODS", objectType: "SERVICES" })],
    });
    const result = assessTender(syntheticInput(maintenance, { valueEur: 6_600 }));
    expect(result.status).toBe("HARD_REJECT");
    expect(result.best.explanation).toBe(
      "Kapsam dışı: Bu tarım makinesi bakım-onarım hizmeti alımı mal değil, hizmet alımı. Bozkor yalnızca mal alımlarına teklif verir.",
    );
    expect(result.best.actions).toEqual([]);
    const mixed = facts({ ...maintenance, lots: [{ ...maintenance.lots[0]!, objectType: "MIXED" }] });
    expect(assessTender(syntheticInput(mixed, { valueEur: 6_600 })).status).not.toBe("HARD_REJECT");
  });

  it("keeps long requirement details out of the reasons", () => {
    const long = facts({ ...pipeFacts, pastPerformance: { value: "REQUIRED", detail: "Son on yılda ".repeat(30), quote: "" } });
    const explanation = assessTender(syntheticInput(long)).best.explanation;
    expect(explanation).toContain("…)");
    expect(explanation.length).toBeLessThan(600);
  });

  it("knows an explicit no-warranty from an unknown one", () => {
    const none = assessTender(syntheticInput(facts({ ...pipeFacts, warranty: { years: 0, detail: "", quote: "" } }))).best;
    expect(gateState(none, "C01")).toBe("PASS");
    expect(none.dimensions.C.notes).toContain("Garanti istenmiyor.");
  });
});

describe("delivery-only stage (team decision, 16 October 2026)", () => {
  it("rejects any on-site work outright, whatever the partners and the time left", () => {
    const tyres = assessWith(inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts));
    expect(tyres.lots.map((l) => l.status)).toEqual(["COMMERCIAL_NO_BID", "COMMERCIAL_NO_BID", "COMMERCIAL_NO_BID"]);
    expect(tyres.lots[0]!.explanation).toBe(
      "Lot 1 (binek ve hafif ticari araç lastikleri ve jantları) ürün teslimine ek olarak sahada kurulum ve yerinde servis istiyor. " +
        "Şu aşamada yalnızca ürün teslimi içeren ihalelere teklif veriyoruz. " +
        "Ayrıca tutar 24 aya yayılan, ihtiyaca göre tekrarlanan siparişlerle geliyor (aylık ortalama yaklaşık 333 EUR).",
    );

    const withPartner = assessWith(inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts), { ...POLICY, servicePartnerCountries: ["BG"] });
    expect(withPartner.status).toBe("COMMERCIAL_NO_BID");

    const compressor = assessWith(inputFor("uk-fat/uk4-policy-ba-compressor", compressorFacts, { deadline: new Date("2026-12-01T12:00:00Z") }));
    expect(compressor.status).toBe("COMMERCIAL_NO_BID");
    expect(compressor.best.explanation).toContain("ürün teslimine ek olarak yerinde servis ve sahada devreye alma ya da eğitim istiyor");
  });

  it("still names a verified qualification gap as a further reason", () => {
    const result = assessWith(inputFor("eu-ted/ted-policy-generators-defence", generatorFacts));
    expect(result.status).toBe("COMMERCIAL_NO_BID");
    expect(result.best.explanation).toContain("ürün teslimine ek olarak yerinde servis istiyor");
    expect(result.best.explanation).toContain("Ayrıca geçmiş teslimat referansı");
  });

  it("rejects basic assembly on site too, unless the policy allows it again", () => {
    const assembly = facts({ ...pipeFacts, installation: { value: "MINOR", detail: "Mobilyanın yerinde kurulması", quote: "" } });
    const rejected = assessWith(syntheticInput(assembly));
    expect(rejected.status).toBe("COMMERCIAL_NO_BID");
    expect(rejected.best.explanation).toContain("ürün teslimine ek olarak sahada basit montaj istiyor");
    expect(assessWith(syntheticInput(assembly), { ...POLICY, allowMinorAssembly: true }).status).toBe("NEEDS_SUPPLIER");
  });

  it("states one expected score: the middle of the open range", () => {
    expect(expectedScore({ low: 34, high: 100 })).toBe(67);
    const notice = assessWith(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureNoticeFacts)).best;
    expect(notice.explanation).toContain(`fırsat uyumu yaklaşık ${expectedScore(notice.scores.fit)}, ama`);
    expect(notice.explanation).not.toMatch(/\d+-\d+ aralığında/);
  });

  it("leaves delivery-only tenders to the other rules", () => {
    expect(assessWith(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureFacts)).status).toBe("NEEDS_SUPPLIER");
    expect(assessWith(inputFor("eu-ted/ted-policy-spare-parts-24-months", sparePartsFacts)).status).toBe("COMMERCIAL_NO_BID");
    expect(assessWith(syntheticInput(pipeFacts)).status).toBe("NEEDS_SUPPLIER");
  });
});

describe("output", () => {
  const all = [
    assessTender(inputFor("eu-ted/ted-policy-tyres-with-services", tyreFacts)),
    assessTender(inputFor("uk-fat/uk4-policy-ba-compressor", compressorFacts)),
    assessTender(inputFor("eu-ted/ted-policy-generators-defence", generatorNoticeFacts)),
    assessTender(inputFor("uk-fat/uk4-policy-cafe-furniture", furnitureFacts)),
  ];

  it("records the policy version and gives every non-final lot a next action", () => {
    for (const result of all) {
      expect(result.policyVersion).toBe(POLICY.version);
      for (const l of result.lots) {
        if (FINAL_STATUSES.includes(l.status) || l.status === "WATCH") expect(l.actions).toEqual([]);
        else expect(l.actions.length).toBeGreaterThan(0);
        expect(l.scores.preliminary.low).toBeLessThanOrEqual(l.scores.preliminary.high);
      }
    }
  });

  it("never writes an em dash", () => {
    expect(JSON.stringify(all)).not.toContain("\u2014");
  });
});
