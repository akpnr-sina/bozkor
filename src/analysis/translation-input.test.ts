import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTranslationInput, TRANSLATION_INPUT_LIMITS } from "./translation-input";
import type { TriageNotice } from "./types";
import { TRANSLATION_PROMPT_VERSION } from "./translate";

const prompt = readFileSync(new URL(`../../prompts/${TRANSLATION_PROMPT_VERSION}.md`, import.meta.url), "utf8");

const lot = (n: number, description: string | null = "Opis") => ({
  lotNumber: String(n),
  title: `Część ${n}`,
  description,
  cpv: [],
  valueAmount: null,
  valueCurrency: null,
  quantityText: null,
});

const notice = (overrides: Partial<TriageNotice> = {}): TriageNotice => ({
  source: "eu_ted",
  title: "Dostawa hełmów strażackich",
  description: "Przedmiotem zamówienia jest dostawa 120 hełmów.",
  buyerName: "Gmina",
  buyerCountry: "PL",
  cpvMain: "35113400",
  cpvAdditional: [],
  valueAmount: null,
  valueCurrency: null,
  valueEur: null,
  submissionDeadline: null,
  procedureType: null,
  noticeLanguage: "PL",
  lots: [lot(1), lot(2)],
  ...overrides,
});

describe("buildTranslationInput", () => {
  it("sends only the notice's texts and lists the lots it sent", () => {
    const { text, lotNumbers, truncated } = buildTranslationInput(notice());
    expect(text).toBe(
      [
        '<ilan dil="PL">',
        "<baslik>Dostawa hełmów strażackich</baslik>",
        "<aciklama>Przedmiotem zamówienia jest dostawa 120 hełmów.</aciklama>",
        '<lotlar toplam="2">',
        '<lot numara="1">',
        "<lot_basligi>Część 1</lot_basligi>",
        "<lot_aciklamasi>Opis</lot_aciklamasi>",
        "</lot>",
        '<lot numara="2">',
        "<lot_basligi>Część 2</lot_basligi>",
        "<lot_aciklamasi>Opis</lot_aciklamasi>",
        "</lot>",
        "</lotlar>",
        "</ilan>",
        "",
        "Yukarıdaki ilanı Türkçeye çevir.",
      ].join("\n"),
    );
    expect(lotNumbers).toEqual(["1", "2"]);
    expect(truncated).toBe(false);
  });

  it("keeps a lot without texts, so the answer can still name it", () => {
    const { text, lotNumbers } = buildTranslationInput(notice({ lots: [{ ...lot(1, null), title: null }] }));
    expect(text).toContain('<lot numara="1">\n</lot>');
    expect(lotNumbers).toEqual(["1"]);
  });

  it("marks cut texts and left-out lots, and reports that the input was cut", () => {
    const long = "słowo ".repeat(3_000);
    const many = Array.from({ length: 45 }, (_, i) => lot(i + 1));
    const { text, lotNumbers, truncated } = buildTranslationInput(notice({ description: long, lots: many }));
    expect(text).toContain('<aciklama kisaltildi="evet">');
    expect(text).toContain(`<lotlar toplam="45" gosterilmeyen="${45 - TRANSLATION_INPUT_LIMITS.lots}">`);
    expect(lotNumbers).toHaveLength(TRANSLATION_INPUT_LIMITS.lots);
    expect(truncated).toBe(true);
  });

  it("stops adding lots at the text budget", () => {
    const big = Array.from({ length: 30 }, (_, i) => lot(i + 1, "x ".repeat(750)));
    const { text, lotNumbers } = buildTranslationInput(notice({ description: "y ".repeat(4_000), lots: big }));
    expect(lotNumbers.length).toBeLessThan(30);
    expect(text.length).toBeLessThan(TRANSLATION_INPUT_LIMITS.texts + 5_000);
  });
});

describe("the current translation prompt", () => {
  it("explains every tag and attribute the input uses", () => {
    const { text } = buildTranslationInput(notice({ description: "z ".repeat(5_000), lots: Array.from({ length: 45 }, (_, i) => lot(i + 1)) }));
    const tags = [...new Set([...text.matchAll(/<([a-z_]+)[ >]/g)].map((m) => m[1]!))];
    expect(tags.sort()).toEqual(["aciklama", "baslik", "ilan", "lot", "lot_aciklamasi", "lot_basligi", "lotlar"]);
    for (const tag of tags) expect(prompt, tag).toContain(`<${tag}`);
    for (const attribute of ["dil", "kisaltildi", "toplam", "gosterilmeyen", "numara"]) expect(prompt).toContain(attribute);
  });

  it("does not contain an em dash", () => {
    expect(prompt).not.toContain("\u2014");
  });
});
