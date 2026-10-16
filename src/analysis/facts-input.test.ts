import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadFixture } from "../../tests/helpers/fixtures";
import { PRODUCT_CATEGORY_CODES } from "@/policy/categories";
import { normalizeTedNotice } from "@/sources/eu-ted/normalize";
import { foldNotices, type FoldedTender } from "@/sources/fold";
import type { NormalizedNotice, NoticeDetails } from "@/sources/types";
import { normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { FACTS_PROMPT_VERSION } from "./facts";
import { buildFactsInput, FACTS_INPUT_LIMITS, factsQuoteSources, type FactsNotice } from "./facts-input";
import { factsOutputSchema } from "./facts-schema";
import { findQuote } from "./quotes";
import { noticeQuoteSources } from "./triage-input";
import type { TriageNotice } from "./types";

const prompt = readFileSync(new URL(`../../prompts/${FACTS_PROMPT_VERSION}.md`, import.meta.url), "utf8");

/** One recorded notice, folded the way the worker stores it as a tender. */
function fold(normalized: NormalizedNotice | null, name: string): FoldedTender {
  if (!normalized) throw new Error(`${name} normalized to null`);
  return foldNotices([normalized]);
}

/** The tender columns triage reads: no details or documents, so the input matches triage's. */
function triageNoticeOf(t: FoldedTender): TriageNotice {
  return {
    source: t.source,
    title: t.title,
    description: t.description,
    buyerName: t.buyerName,
    buyerCountry: t.buyerCountry,
    cpvMain: t.cpvMain,
    cpvAdditional: t.cpvAdditional,
    valueAmount: t.valueAmount,
    valueCurrency: t.valueCurrency,
    valueEur: null,
    submissionDeadline: t.submissionDeadline,
    procedureType: t.procedureType,
    noticeLanguage: t.noticeLanguage,
    lots: t.lots.map(({ lotNumber, title, description, cpv, valueAmount, valueCurrency, quantityText }) => ({
      lotNumber,
      title,
      description,
      cpv,
      valueAmount,
      valueCurrency,
      quantityText,
    })),
  };
}

const fromTedFixture = (name: string) => triageNoticeOf(fold(normalizeTedNotice(loadFixture("eu-ted", name)), name));

const NORMALIZERS = { "uk-fat": normalizeFatRelease, "eu-ted": normalizeTedNotice } as const;

/** A recorded notice as the facts stage reads the stored tender: with its details and document descriptions. */
function fromFixture(source: keyof typeof NORMALIZERS, name: string): FactsNotice {
  const t = fold(NORMALIZERS[source](loadFixture(source, name)), name);
  return {
    ...triageNoticeOf(t),
    details: t.details,
    documents: t.documents.map(({ title, documentType }) => ({ title, documentType })),
  };
}

const details =(overrides: Partial<NoticeDetails> = {}): NoticeDetails => ({
  durationMonths: 24,
  framework: true,
  electronicOrdering: true,
  gpaCovered: false,
  awardCriteria: [
    { type: "price", name: "Price", weight: 60, description: null },
    { type: "quality", name: "Delivery time", weight: 40, description: "Shorter delivery scores higher" },
  ],
  selectionCriteria: [
    { type: "ef-stand", description: "Minimum annual turnover of EUR 50,000 in each of the last three years." },
    { type: "tp-abil", description: "At least two deliveries of comparable tyres in the last three years." },
  ],
  guaranteeRequired: null,
  performanceTerms: "Tyres shall be fitted and balanced at the buyer's premises within 48 hours of the order.",
  submissionLanguages: ["BG"],
  ...overrides,
});

function notice(overrides: Partial<TriageNotice> = {}): TriageNotice {
  return {
    source: "eu_ted",
    title: "Доставка на гуми и джанти",
    description: "Доставка, монтаж и баланс на гуми за леки автомобили, камиони и трактори.",
    buyerName: "Тунджа ДЛС",
    buyerCountry: "BG",
    cpvMain: "34350000",
    cpvAdditional: [],
    valueAmount: 24_100,
    valueCurrency: "EUR",
    valueEur: 24_100,
    submissionDeadline: new Date("2026-11-03T15:00:00Z"),
    procedureType: "open",
    noticeLanguage: "BG",
    lots: [],
    ...overrides,
  };
}

const lot = (n: number, description: string | null = null): TriageNotice["lots"][number] => ({
  lotNumber: String(n),
  title: `Lot ${n}: tyres`,
  description,
  cpv: ["34351100"],
  valueAmount: null,
  valueCurrency: null,
  quantityText: null,
});

const words = (count: number, word = "lorem") => Array.from({ length: count }, (_, i) => `${word}${i}`).join(" ");

describe("buildFactsInput", () => {
  it("lays out the notice like triage, without a profile", () => {
    const n = fromTedFixture("ted-cn-supplies-multi-lot");
    const { text, sources, lotNumbers } = buildFactsInput(n);

    expect(text.startsWith("<ilan>\n<bilgiler>\nKaynak: TED (AB)\n")).toBe(true);
    expect(text).toContain(`<lotlar toplam="${n.lots.length}">`);
    expect(text).not.toContain("<profil");
    expect(text.endsWith("</ilan>\n\nBu ilandaki olguları çıkar.")).toBe(true);
    expect(lotNumbers).toEqual(n.lots.map((l) => l.lotNumber));
    for (const [key, value] of Object.entries(sources)) expect(text.includes(value), key).toBe(true);
    // Within the limits the notice texts are the same as in the triage input.
    expect(sources).toEqual(noticeQuoteSources(n));
  });

  it("adds the structured details as context lines and leaves out the unknown ones", () => {
    const { text } = buildFactsInput(notice({ details: details() }));
    const info = text.slice(text.indexOf("<bilgiler>"), text.indexOf("</bilgiler>"));
    expect(info).toContain("Sözleşme süresi: 24 ay");
    expect(info).toContain("Çerçeve anlaşma: evet");
    expect(info).toContain("Elektronik sipariş: evet");
    expect(info).toContain("GPA kapsamında: hayır");
    expect(info).toContain("Teklif dilleri: BG");
    expect(info).toContain(
      "Değerlendirme kriterleri: Price, fiyat, ağırlık 60; Delivery time, kalite, ağırlık 40: Shorter delivery scores higher",
    );
    expect(info).not.toContain("Teminat");
  });

  it("keeps the award criteria line bounded: ten criteria at most, cut and on one line", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      type: "quality" as const,
      name: `Technical merit ${i}\n${words(40, `name${i}word`)}`,
      weight: 5,
      description: words(80, `desc${i}word`),
    }));
    const { text } = buildFactsInput(notice({ details: details({ awardCriteria: many }) }));
    const prefix = "Değerlendirme kriterleri (toplam 12, gösterilmeyen 2): ";
    const line = text.split("\n").find((l) => l.startsWith(prefix));

    expect(line).toBeDefined();
    const shown = line!.slice(prefix.length).split("; ");
    expect(shown).toHaveLength(FACTS_INPUT_LIMITS.awardCriteria);
    expect(shown[0]!.startsWith("Technical merit 0 name0word0 ")).toBe(true);
    expect(line).not.toContain("Technical merit 10");
    for (const criterion of shown) {
      const [label, description] = criterion.split(": ");
      expect(label!.replace(", kalite, ağırlık 5", "").length).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.awardName);
      expect(description!.length).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.awardDescription);
    }
  });

  it("writes a criterion that only has a description without a leading colon", () => {
    const weighting = { type: null, name: null, weight: null, description: "Quality pass mark 60%" };
    const { text } = buildFactsInput(notice({ details: details({ awardCriteria: [weighting] }) }));
    expect(text).toContain("\nDeğerlendirme kriterleri: Quality pass mark 60%\n");
  });

  it("makes the selection criteria and performance terms quotable sections after the lots", () => {
    const d = details();
    const { text, sources } = buildFactsInput(notice({ lots: [lot(1)], details: d }));

    expect(text).toContain(
      `<secim_kriterleri toplam="2">\n<secim_kriteri sira="1" tur="ef-stand">${d.selectionCriteria[0]!.description}</secim_kriteri>`,
    );
    expect(text.indexOf("<secim_kriterleri")).toBeGreaterThan(text.indexOf("</lotlar>"));
    expect(text.indexOf("<ifa_kosullari>")).toBeLessThan(text.indexOf("</ilan>"));
    expect(sources["selection:1"]).toBe(d.selectionCriteria[0]!.description);
    expect(sources["selection:2"]).toBe(d.selectionCriteria[1]!.description);
    expect(sources.performance).toBe(d.performanceTerms);

    expect(findQuote("Minimum annual turnover of EUR 50,000", sources)).toBe("selection:1");
    expect(findQuote("fitted and balanced at the buyer's premises", sources)).toBe("performance");
    expect(findQuote("монтаж и баланс на гуми", sources)).toBe("description");
  });

  it("cuts long selection criteria and leaves out those beyond the limits", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: null, description: words(140, `criterion${i}word`) }));
    const { text, sources } = buildFactsInput(notice({ details: details({ selectionCriteria: many, performanceTerms: null }) }));
    const shown = Object.keys(sources).filter((k) => k.startsWith("selection:"));
    const used = shown.reduce((total, k) => total + sources[k]!.length, 0);

    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(10);
    expect(used).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.selectionTexts);
    expect(text).toContain(`<secim_kriterleri toplam="12" gosterilmeyen="${12 - shown.length}">`);
    expect(text).not.toContain("<ifa_kosullari");
    for (const key of shown) expect(sources[key]!.length).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.selectionItem);
    expect(text).toContain('kisaltildi="evet"');
  });

  it("lists the lots it shows, or one empty entry when the notice has no lots", () => {
    expect(buildFactsInput(notice()).lotNumbers).toEqual([""]);

    const { text, lotNumbers } = buildFactsInput(notice({ lots: Array.from({ length: 45 }, (_, i) => lot(i + 1)) }));
    expect(lotNumbers).toHaveLength(FACTS_INPUT_LIMITS.notice.lots);
    expect(lotNumbers).toEqual([...text.matchAll(/<lot numara="([^"]*)">/g)].map((m) => m[1]));
    expect(text).toContain(`gosterilmeyen="${45 - lotNumbers.length}"`);
  });

  it("makes document descriptions quotable, as FaT 096535 writes its specification there", () => {
    const specification =
      "Supplier to provide commissioning, testing and operator training. UK-based servicing and technical support available. " +
      "Minimum 12-month warranty. Compressor to meet BS EN 12021 and be UKCA marked.";
    const compressor: FactsNotice = {
      ...notice({
        source: "uk_fat",
        title: "Breathing Air Compressor Replacement",
        description: "Replacement of the breathing air compressor used to fill breathing apparatus cylinders.",
        buyerCountry: "GB",
        valueCurrency: "GBP",
        noticeLanguage: "EN",
      }),
      documents: [
        { title: specification, documentType: "technicalSpecifications" },
        { title: null, documentType: "biddingDocuments" },
        { title: "Tender details and specification", documentType: "biddingDocuments" },
      ],
    };
    const { text, sources } = buildFactsInput(compressor);

    expect(text).toContain(
      `<dokumanlar toplam="2">\n<dokuman sira="1" tur="technicalSpecifications">${specification}</dokuman>\n` +
        '<dokuman sira="2" tur="biddingDocuments">Tender details and specification</dokuman>\n</dokumanlar>',
    );
    expect(sources["document:1"]).toBe(specification);
    expect(sources["document:2"]).toBe("Tender details and specification");
    expect(findQuote("Supplier to provide commissioning, testing and operator training", sources)).toBe("document:1");
    expect(findQuote("UK-based servicing and technical support available", sources)).toBe("document:1");
    expect(findQuote("be UKCA marked", sources)).toBe("document:1");
  });

  it("puts the documents last and keeps them within the limits", () => {
    const documents = Array.from({ length: 12 }, (_, i) => ({ title: words(140, `doc${i}word`), documentType: null }));
    const { text, sources } = buildFactsInput({ ...notice({ lots: [lot(1)], details: details() }), documents });
    const shown = Object.keys(sources).filter((k) => k.startsWith("document:"));
    const used = shown.reduce((total, k) => total + sources[k]!.length, 0);

    expect(text.indexOf("<secim_kriterleri")).toBeLessThan(text.indexOf("<ifa_kosullari"));
    expect(text.indexOf("<ifa_kosullari")).toBeLessThan(text.indexOf("<dokumanlar"));
    expect(text.indexOf("</dokumanlar>")).toBeLessThan(text.indexOf("</ilan>"));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(FACTS_INPUT_LIMITS.documents);
    expect(used).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.documentTexts);
    for (const key of shown) expect(sources[key]!.length).toBeLessThanOrEqual(FACTS_INPUT_LIMITS.document);
    expect(text).toContain(`<dokumanlar toplam="12" gosterilmeyen="${12 - shown.length}">`);
  });

  it("leaves the documents section out when no document has a description", () => {
    const { text, sources } = buildFactsInput({ ...notice(), documents: [{ title: "  ", documentType: "biddingDocuments" }] });
    expect(text).not.toContain("<dokumanlar");
    expect(Object.keys(sources).some((k) => k.startsWith("document:"))).toBe(false);
  });

  it("is deterministic, and factsQuoteSources gives the same sources", () => {
    const n: FactsNotice = {
      ...notice({ lots: [lot(1, words(400)), lot(2)], details: details() }),
      documents: [{ title: "Specification: supply only", documentType: "technicalSpecifications" }],
    };
    expect(buildFactsInput(n)).toEqual(buildFactsInput(n));
    expect(factsQuoteSources(n)).toEqual(buildFactsInput(n).sources);
  });
});

describe("buildFactsInput with recorded notices", () => {
  it("quotes the specification FaT 096535 writes in its document description", () => {
    const { text, sources } = buildFactsInput(fromFixture("uk-fat", "uk4-policy-ba-compressor"));

    // The link to the notice page on Find a Tender is not a document.
    expect(text).toContain(
      '<dokumanlar toplam="1">\n<dokuman sira="1" tur="technicalSpecifications">Capability to remotely charge BA cylinders',
    );
    expect(text).toContain("\nSözleşme süresi: 12 ay\n");
    expect(findQuote("Supplier to provide commissioning, testing and operator training", sources)).toBe("document:1");
    expect(findQuote("UK-based servicing and technical support available", sources)).toBe("document:1");
  });

  it("quotes the services and equipment TED 702149 asks for in its Bulgarian texts", () => {
    const { text, sources, lotNumbers } = buildFactsInput(fromFixture("eu-ted", "ted-policy-tyres-with-services"));

    expect(lotNumbers).toEqual(["LOT-0001", "LOT-0002", "LOT-0003"]);
    expect(findQuote("услуги по демонтаж, лепене, баланс", sources)).toBe("description");
    // Every lot states the same equipment requirement; it is shown once.
    expect(text).toContain('<secim_kriterleri toplam="1">\n<secim_kriteri sira="1" tur="slc-abil-facil-tools">');
    expect(findQuote('не по-малко от 1 брой на "баланс-машина" или еквивалентно оборудване', sources)).toBe("selection:1");
    // Zero-width spaces sit between "автомобили" and "собственост"; a copied quote has none.
    expect(sources["lot:LOT-0001:description"]).toMatch(/\p{Cf}/u);
    expect(findQuote("леки и лекотоварни автомобили собственост на ТП ДЛС Тунджа", sources)).toBe(
      "lot:LOT-0001:description",
    );
  });
});

/** Every enum value in a schema: the prompt explains what each one means. */
function enumValues(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodEnum) return schema.options.map(String);
  if (schema instanceof z.ZodObject) return Object.values(schema.shape).flatMap((field) => enumValues(field as z.ZodType));
  if (schema instanceof z.ZodArray) return enumValues(schema.element as z.ZodType);
  if (schema instanceof z.ZodNullable) return enumValues(schema.unwrap() as z.ZodType);
  return [];
}

describe("the current facts prompt", () => {
  it("describes every product category code", () => {
    for (const code of PRODUCT_CATEGORY_CODES) expect(prompt, code).toContain(`\`${code}\``);
  });

  it("explains every fact, lot field and value of the schema", () => {
    const keys = [...Object.keys(factsOutputSchema.shape), ...Object.keys(factsOutputSchema.shape.lots.element.shape)];
    for (const key of keys) expect(prompt, key).toContain(`\`${key}\``);
    for (const value of new Set(enumValues(factsOutputSchema))) expect(prompt, value).toContain(`\`${value}\``);
    // Obligations can differ between lots.
    expect(prompt).toContain("`installation`, `commissioningTraining` ve `localService` içindeki `lots`");
  });

  it("explains every tag and attribute the input uses", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: "ef-stand", description: words(300, `c${i}w`) }));
    const { text } = buildFactsInput({
      ...notice({
        description: words(2_000),
        lots: Array.from({ length: 45 }, (_, i) => lot(i + 1, "Summer tyres")),
        details: details({
          selectionCriteria: many,
          performanceTerms: words(600),
          awardCriteria: Array.from({ length: 12 }, (_, i) => ({ type: "price" as const, name: `Price ${i}`, weight: null, description: null })),
        }),
      }),
      documents: Array.from({ length: 12 }, (_, i) => ({ title: words(300, `d${i}w`), documentType: "technicalSpecifications" })),
    });
    const tags = [...new Set([...text.matchAll(/<([a-z_]+)[ >]/g)].map((m) => m[1]!))];
    expect(tags).toEqual(expect.arrayContaining(["secim_kriteri", "ifa_kosullari", "lot_bilgileri", "dokuman"]));
    for (const tag of tags) expect(prompt, tag).toContain(`<${tag}>`);
    for (const attribute of ["kisaltildi", "gosterilmeyen", "numara", "tur"]) expect(prompt, attribute).toContain(`\`${attribute}\``);
    expect(text).toContain("Değerlendirme kriterleri (toplam 12, gösterilmeyen 2): ");
    expect(prompt).toContain("`(toplam N, gösterilmeyen M)`");
  });

  it("does not contain an em dash", () => {
    expect(prompt).not.toContain("\u2014");
  });
});
