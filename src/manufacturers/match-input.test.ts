import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { insertTender } from "../../tests/helpers/tenders";
import { createTestDb } from "../../tests/helpers/test-db";
import { checkFactsQuotes } from "@/analysis/facts-evidence";
import { analyses, lots } from "@/db/schema";
import { buildMatchInput, cpvNamesTr, loadMatchInput } from "./match-input";

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

// The texts the facts call read: the boots' quotes are in them, the gloves' category quote and the ISO 9001 one are not.
const SOURCES = { title: "Supply of PPE", description: "Boots and gloves.", "lot:LOT-0001:title": "Safety boots", "lot:LOT-0001:description": "EN ISO 20345 S3 safety boots" };

const ppeFacts = facts({
  lots: [
    lot({ lotNumber: "LOT-0001", productTr: "iş güvenliği botu", category: "TEXTILES_WORKWEAR", categoryQuote: "Safety boots" }),
    lot({ lotNumber: "LOT-0002", productTr: " iş eldiveni ", category: "TEXTILES_WORKWEAR", categoryQuote: "Leather gloves EN 388" }),
  ],
  certifications: [
    { name: "EN ISO 20345", level: "PRODUCT", quote: "EN ISO 20345 S3" },
    { name: "ISO 9001", level: "BIDDER", quote: "Bidders shall be ISO 9001 certified" },
  ],
});

async function insertFacts(tenderId: string) {
  await t.db.insert(analyses).values({
    tenderId,
    kind: "facts",
    model: "claude-haiku-5-5",
    promptVersion: "facts.v5",
    valid: true,
    output: { ...ppeFacts, quoteChecks: checkFactsQuotes(ppeFacts, SOURCES), sourcesHash: "h", inputUpdatedAt: new Date().toISOString() },
  });
}

async function insertTranslation(tenderId: string) {
  await t.db.insert(analyses).values({
    tenderId,
    kind: "translation",
    model: "claude-haiku-5-5",
    promptVersion: "translate.v2",
    valid: true,
    output: {
      title: "KKD alımı",
      description: "Botlar ve eldivenler.",
      lots: [
        { lotNumber: "LOT-0001", title: "Emniyet botları", description: "EN ISO 20345 S3 emniyet botları" },
        { lotNumber: "LOT-0002", title: "Eldivenler", description: "" },
      ],
      sourcesHash: "h",
    },
  });
}

describe("loadMatchInput", () => {
  it("reads each lot in order with its facts, translation and Turkish CPV names", async () => {
    const id = await insertTender(t.db, { contractNature: "goods", cpvMain: "18000000", cpvAdditional: ["18830000"], title: "Supply of PPE", description: "Boots and gloves." });
    await t.db.insert(lots).values([
      { tenderId: id, lotNumber: "LOT-0002", title: "Gloves", cpv: ["18424000"] },
      { tenderId: id, lotNumber: "LOT-0001", title: "Safety boots", description: "EN ISO 20345 S3 safety boots", cpv: ["18830000-6"], quantityText: "500 pairs" },
    ]);
    await insertFacts(id);
    await insertTranslation(id);

    const input = await loadMatchInput(t.db, id);
    expect(input).toMatchObject({ tenderId: id, hasFacts: true, tenderCpv: ["18000000", "18830000"] });
    const [boots, gloves] = input!.lots;
    expect(boots).toEqual({
      lotNumber: "LOT-0001",
      nature: "goods",
      objectType: "GOODS",
      category: "TEXTILES_WORKWEAR",
      productTr: "iş güvenliği botu",
      productNature: "UNKNOWN",
      cpv: ["18830000"],
      cpvNamesTr: ["Koruyucu ayakkabılar"],
      textTr: "Emniyet botları\nEN ISO 20345 S3 emniyet botları",
      textOriginal: "Safety boots\nEN ISO 20345 S3 safety boots",
      quantityText: "500 pairs",
      certifications: [
        { name: "EN ISO 20345", level: "PRODUCT", verified: true },
        { name: "ISO 9001", level: "BIDDER", verified: false },
      ],
    });
    // The gloves' category quote is not in the texts: the policy sees the object type as unknown.
    expect(gloves).toMatchObject({ lotNumber: "LOT-0002", objectType: "UNKNOWN", productTr: "iş eldiveni", cpvNamesTr: ["Eldivenler"], textTr: "Eldivenler", textOriginal: "Gloves" });
  });

  it("reads a tender without lots, facts or translation from its own codes and texts", async () => {
    const id = await insertTender(t.db, { contractNature: "goods", cpvMain: "31121000", cpvAdditional: ["31000000"], title: "Diesel generator 12,5 kVA", description: "Towable." });
    const input = await loadMatchInput(t.db, id);
    expect(input).toEqual({
      tenderId: id,
      hasFacts: false,
      tenderCpv: ["31121000", "31000000"],
      lots: [
        {
          lotNumber: "",
          nature: "goods",
          objectType: null,
          category: null,
          productTr: null,
          productNature: null,
          cpv: ["31121000", "31000000"],
          cpvNamesTr: ["Jeneratör setleri"],
          textTr: null,
          textOriginal: "Diesel generator 12,5 kVA\nTowable.",
          quantityText: null,
          certifications: [],
        },
      ],
    });
  });

  it("keeps a lot of several without codes of its own empty, and gives a lone lot the tender's codes", async () => {
    const id = await insertTender(t.db, { contractNature: "goods", cpvMain: "35112000", cpvAdditional: ["35113400", "44211000"], title: "Rescue equipment" });
    await t.db.insert(lots).values([
      { tenderId: id, lotNumber: "LOT-0001", title: "Decontamination", cpv: ["35112000"] },
      { tenderId: id, lotNumber: "LOT-0002", title: "Boats", cpv: [] },
    ]);
    const several = await loadMatchInput(t.db, id);
    expect(several!.tenderCpv).toEqual(["35112000", "35113400", "44211000"]);
    expect(several!.lots.map((l) => [l.lotNumber, l.cpv, l.cpvNamesTr.length])).toEqual([
      ["LOT-0001", ["35112000"], 1],
      ["LOT-0002", [], 0],
    ]);
    const alone = await insertTender(t.db, { contractNature: "goods", cpvMain: "35113400", cpvAdditional: [], title: "Protective clothing" });
    await t.db.insert(lots).values([{ tenderId: alone, lotNumber: "LOT-0001", title: "Suits", cpv: [] }]);
    expect((await loadMatchInput(t.db, alone))!.lots[0]!.cpv).toEqual(["35113400"]);
  });

  it("is null for a tender that does not exist", async () => {
    expect(await loadMatchInput(t.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("buildMatchInput", () => {
  // The facts stage writes an empty lot number when the notice has no lots (facts-schema).
  const single = facts({ lots: [lot({ lotNumber: "", productTr: "dizel jeneratör", category: "COMPLEX_GENERATORS" })] });
  const tender = { id: "t1", contractNature: "goods" as const, cpvMain: "31121000", cpvAdditional: [], title: "Generators", description: null };
  const sources = (lotRows: { lotNumber: string }[]) => ({
    tender,
    lots: lotRows.map((row) => ({ ...row, title: null, description: null, cpv: [], quantityText: null })),
    facts: { stored: { facts: single, quoteChecks: null, sourcesHash: null }, facts: single },
    translation: null,
  });

  it("gives the only lot the only facts lot, whatever lot number came with each", () => {
    expect(buildMatchInput(sources([{ lotNumber: "LOT-0001" }])).lots[0]).toMatchObject({ lotNumber: "LOT-0001", productTr: "dizel jeneratör", cpv: ["31121000"], textOriginal: "Generators" });
    expect(buildMatchInput(sources([])).lots).toMatchObject([{ lotNumber: "", productTr: "dizel jeneratör", category: "COMPLEX_GENERATORS" }]);
  });

  it("does not guess which of several lots a facts lot belongs to", () => {
    const input = buildMatchInput(sources([{ lotNumber: "LOT-0001" }, { lotNumber: "LOT-0002" }]));
    expect(input.lots.map((l) => l.productTr)).toEqual([null, null]);
  });
});

describe("cpvNamesTr", () => {
  it("names class-level codes and finer, once each, and leaves out wider ones", () => {
    expect(cpvNamesTr(["34350000", "34300000", "34350000", "18830000"])).toEqual(["Ağır ve hafif hizmet taşıtları için lastikler", "Koruyucu ayakkabılar"]);
    expect(cpvNamesTr(["18000000", "31000000"])).toEqual([]);
  });
});
