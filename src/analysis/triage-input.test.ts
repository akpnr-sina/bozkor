import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { normalizeTedNotice } from "@/sources/eu-ted/normalize";
import { foldNotices } from "@/sources/fold";
import type { NormalizedNotice } from "@/sources/types";
import { normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { buildTriageInput, noticeQuoteSources, TRIAGE_INPUT_LIMITS } from "./triage-input";
import type { TriageNotice, TriageProfile } from "./types";

/** A recorded notice as the triage job reads it from the tenders table. */
function fromFixture(
  source: "uk-fat" | "eu-ted",
  name: string,
  valueEur: number | null = null,
): TriageNotice {
  const normalize: (raw: unknown) => NormalizedNotice | null = source === "uk-fat" ? normalizeFatRelease : normalizeTedNotice;
  const normalized = normalize(loadFixture(source, name));
  if (!normalized) throw new Error(`${name} normalized to null`);
  const t = foldNotices([normalized]);
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
    valueEur,
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

function notice(overrides: Partial<TriageNotice> = {}): TriageNotice {
  return {
    source: "eu_ted",
    title: "Supply of standby diesel generating sets",
    description: "Supply and delivery of three 500 kVA diesel generating sets with acoustic enclosures.",
    buyerName: "Cork County Council",
    buyerCountry: "IE",
    cpvMain: "31121000",
    cpvAdditional: ["31120000"],
    valueAmount: 240_000,
    valueCurrency: "EUR",
    valueEur: 240_000,
    submissionDeadline: new Date("2026-11-17T12:00:00Z"),
    procedureType: "open",
    noticeLanguage: "EN",
    lots: [],
    ...overrides,
  };
}

/** `count` words of filler text, so cuts can land on a word boundary. */
const words = (count: number, word = "lorem") => Array.from({ length: count }, (_, i) => `${word}${i}`).join(" ");

const lot = (n: number, description: string | null = null): TriageNotice["lots"][number] => ({
  lotNumber: String(n),
  title: `Lot ${n}: generating sets`,
  description,
  cpv: ["31121000"],
  valueAmount: null,
  valueCurrency: null,
  quantityText: null,
});

const profile: TriageProfile = {
  name: "Güç (jeneratör, dağıtım, kablo)",
  description: "Jeneratör seti, güç dağıtım ekipmanı ve kablo tedariki. Kurulum veya kiralama hizmeti istemiyoruz.",
  questions: ["Asgari ciro şartı var mı, varsa ne kadar?", "Kurulum, bakım ya da yerinde servis yükümlülüğü var mı?"],
};

/** Every source text appears in the message exactly as stored. */
function expectSourcesInText(text: string, sources: Record<string, string>) {
  for (const [key, value] of Object.entries(sources)) {
    expect(text.includes(value), key).toBe(true);
  }
}

describe("buildTriageInput", () => {
  it("lays out a real Find a Tender notice in labelled sections", () => {
    const n = fromFixture("uk-fat", "uk4-tender-covered-multilot");
    const { text, sources } = buildTriageInput(n, profile);

    expect(text.startsWith("<ilan>\n<bilgiler>\nKaynak: Find a Tender (UK)\n")).toBe(true);
    expect(text).toContain("Ana CPV: 33100000");
    expect(text).toContain(`<baslik>${n.title}</baslik>`);
    expect(text).toContain('<lotlar toplam="2">');
    expect(text).toContain('<lot numara="1">');
    expect(text).toContain("<lot_basligi>IO Sternal Access Device</lot_basligi>");
    expect(text.endsWith("Yukarıdaki ilanı bu profile göre değerlendir.")).toBe(true);

    expect(Object.keys(sources)).toEqual(expect.arrayContaining(["title", "description", "lot:1:title", "lot:2:title"]));
    expectSourcesInText(text, sources);
  });

  it("keeps a TED notice in its own language and adds the euro value when the currency differs", () => {
    const n = fromFixture("eu-ted", "ted-cn-non-eur-currency", 536_412.4);
    const { text, sources } = buildTriageInput(n, profile);
    expect(text).toContain("Kaynak: TED (AB)");
    expect(text).toContain("Tahmini değer: 4000000 DKK (yaklaşık 536412 EUR)");
    expect(text).toContain(`Son teklif tarihi: ${n.submissionDeadline?.toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(sources.title).toBe(n.title);
    expectSourcesInText(text, sources);
  });

  it("cuts a long lot description of a real notice at a word boundary and marks it", () => {
    const n = fromFixture("eu-ted", "ted-cn-other-legal-basis");
    const { text, sources } = buildTriageInput(n, profile);
    const key = Object.keys(sources).find((k) => k.startsWith("lot:") && k.endsWith(":description"));
    expect(key).toBeDefined();
    const shown = sources[key!]!;
    const original = n.lots[0]!.description!.replace(/\r\n?/g, "\n").trim();

    expect(original.length).toBeGreaterThan(TRIAGE_INPUT_LIMITS.lotDescription);
    expect(shown.length).toBeLessThanOrEqual(TRIAGE_INPUT_LIMITS.lotDescription);
    expect(original.startsWith(shown)).toBe(true);
    expect(original[shown.length]).toMatch(/\s/);
    expect(text).toContain(`<lot_aciklamasi kisaltildi="evet">${shown}</lot_aciklamasi>`);
  });

  it("cuts the description to 6,000 characters and marks only what was cut", () => {
    const { text, sources } = buildTriageInput(notice({ description: words(2_000) }), profile);
    expect(sources.description!.length).toBeLessThanOrEqual(TRIAGE_INPUT_LIMITS.description);
    expect(sources.description!.length).toBeGreaterThan(TRIAGE_INPUT_LIMITS.description * 0.8);
    expect(text).toContain('<aciklama kisaltildi="evet">');
    expect(text).toContain("<baslik>Supply of standby diesel generating sets</baslik>");
  });

  it("shows at most 30 lots and says how many were left out", () => {
    const lots = Array.from({ length: 45 }, (_, i) => lot(i + 1));
    const { text, sources } = buildTriageInput(notice({ lots }), profile);
    expect(text).toContain('<lotlar toplam="45" gosterilmeyen="15">');
    expect(sources["lot:30:title"]).toBe("Lot 30: generating sets");
    expect(sources["lot:31:title"]).toBeUndefined();
  });

  it("stops adding lots when the notice texts would pass the budget, keeping the message under ~40,000 characters", () => {
    const lots = Array.from({ length: 30 }, (_, i) => lot(i + 1, words(200, `lot${i + 1}word`)));
    const { text, sources } = buildTriageInput(notice({ description: words(2_000), lots }), profile);
    const shownLots = Object.keys(sources).filter((k) => k.endsWith(":title") && k.startsWith("lot:")).length;
    const used = Object.values(sources).reduce((total, s) => total + s.length, 0);

    expect(shownLots).toBeGreaterThan(0);
    expect(shownLots).toBeLessThan(30);
    expect(used).toBeLessThanOrEqual(TRIAGE_INPUT_LIMITS.noticeTexts);
    expect(text).toContain(`gosterilmeyen="${30 - shownLots}"`);
    expect(text.length).toBeLessThan(40_000);
  });

  it("shows profile categories and keywords when the profile has them, and marks an empty description", () => {
    const { text } = buildTriageInput(notice(), {
      name: "Ana kategoriler",
      description: "",
      questions: [],
      categories: ["Güç (jeneratör, dağıtım, kablo): Jeneratör setleri, güç dağıtım ekipmanı, kablo"],
      keywords: ["generator", "cable"],
      excludedKeywords: ["hire", "maintenance services"],
    });
    expect(text).toContain("<profil_adi>Ana kategoriler</profil_adi>\n<profil_aciklamasi>(boş)</profil_aciklamasi>");
    expect(text).toContain(
      "<profil_kategorileri>\n- Güç (jeneratör, dağıtım, kablo): Jeneratör setleri, güç dağıtım ekipmanı, kablo\n</profil_kategorileri>",
    );
    expect(text).toContain("<profil_anahtar_kelimeleri>\n- generator\n- cable\n</profil_anahtar_kelimeleri>");
    expect(text).toContain("<profil_istenmeyen_kelimeleri>\n- hire\n- maintenance services\n</profil_istenmeyen_kelimeleri>");
    expect(text).not.toContain("<profil_sorulari>");
  });

  it("numbers the profile questions and leaves out empty optional sections", () => {
    const { text } = buildTriageInput(notice(), profile);
    expect(text).toContain(
      "<profil_sorulari>\n1. Asgari ciro şartı var mı, varsa ne kadar?\n2. Kurulum, bakım ya da yerinde servis yükümlülüğü var mı?\n</profil_sorulari>",
    );
    expect(text).not.toContain("<profil_kategorileri>");
    expect(text).not.toContain("<lotlar");
  });

  it("is deterministic", () => {
    const n = fromFixture("eu-ted", "ted-cn-supplies-multi-lot");
    expect(buildTriageInput(n, profile)).toEqual(buildTriageInput(n, profile));
  });
});

describe("noticeQuoteSources", () => {
  const longProfile: TriageProfile = {
    name: "Uzun profil",
    description: words(400),
    questions: Array.from({ length: 20 }, (_, i) => `${words(60)} ${i}?`),
    categories: ["Shelter ve prefabrik yapılar: Prefabrik binalar, çadır ve barınaklar"],
    keywords: ["shelter"],
    excludedKeywords: ["hire"],
  };
  const cases: [string, TriageNotice][] = [
    ["FaT multi-lot", fromFixture("uk-fat", "uk4-tender-covered-multilot")],
    ["TED multi-lot", fromFixture("eu-ted", "ted-cn-supplies-multi-lot")],
    ["TED long lot text", fromFixture("eu-ted", "ted-cn-other-legal-basis")],
    ["over the text budget", notice({ description: words(2_000), lots: Array.from({ length: 30 }, (_, i) => lot(i + 1, words(200))) })],
  ];

  it.each(cases)("gives the same sources as the prompt input for %s, whatever the profile", (_name, n) => {
    const sources = noticeQuoteSources(n);
    expect(buildTriageInput(n, profile).sources).toEqual(sources);
    expect(buildTriageInput(n, longProfile).sources).toEqual(sources);
  });

  it("leaves out texts the notice does not have", () => {
    expect(noticeQuoteSources(notice({ description: null, lots: [lot(1)] }))).toEqual({
      title: "Supply of standby diesel generating sets",
      "lot:1:title": "Lot 1: generating sets",
    });
  });
});

describe.each(["triage.v1.md", "triage.v2.md"])("prompts/%s", (file) => {
  const prompt = readFileSync(new URL(`../../prompts/${file}`, import.meta.url), "utf8");

  it("explains every tag and attribute the input uses", () => {
    const { text } = buildTriageInput(notice({ description: words(2_000), lots: Array.from({ length: 45 }, (_, i) => lot(i + 1)) }), {
      ...profile,
      categories: ["Güç: jeneratör"],
      keywords: ["generator"],
      excludedKeywords: ["hire"],
    });
    const tags = [...new Set([...text.matchAll(/<([a-z_]+)[ >]/g)].map((m) => m[1]!))];
    expect(tags.length).toBeGreaterThan(10);
    for (const tag of tags) expect(prompt, tag).toContain(`<${tag}>`);
    for (const attribute of ["kisaltildi", "gosterilmeyen"]) expect(prompt).toContain(attribute);
  });

  it("does not contain an em dash", () => {
    expect(prompt).not.toContain("\u2014");
  });
});
