import { describe, expect, it } from "vitest";
import { containsKeyword, findKeywords, normalizeText, tenderText } from "./text";

const fields = (...values: string[]) => values.map(normalizeText);

describe("normalizeText", () => {
  it("maps Turkish dotted, dotless and capital I to plain i", () => {
    expect(normalizeText("İSTANBUL Iğdır ışık")).toBe("istanbul igdir isik");
  });

  it("strips accents", () => {
    expect(normalizeText("Équipement électrique, Kühlschrank, çelik şasi")).toBe(
      "equipement electrique kuhlschrank celik sasi",
    );
  });

  it("turns punctuation and whitespace runs into single spaces", () => {
    expect(normalizeText("  generating-sets;  (diesel)\n\tCABLE/wire  ")).toBe("generating sets diesel cable wire");
  });
});

describe("tenderText", () => {
  it("keeps title, description and lot texts as separate normalized fields", () => {
    const text = tenderText({
      title: "Gen-Set Supply",
      description: null,
      lots: [
        { title: "Lot 1: Cables", description: "Armoured cable", cpv: [] },
        { title: null, description: "  ", cpv: [] },
      ],
    });
    expect(text).toEqual(["gen set supply", "lot 1 cables", "armoured cable"]);
  });
});

describe("containsKeyword", () => {
  it("matches whole words only", () => {
    expect(containsKeyword(fields("Plant hire framework"), "hire")).toBe(true);
    expect(containsKeyword(fields("Hampshire County Council"), "hire")).toBe(false);
  });

  it("accepts a plural s or es on the last word", () => {
    expect(containsKeyword(fields("Supply of Generators"), "generator")).toBe(true);
    expect(containsKeyword(fields("Diesel generating-sets, 500 kVA"), "generating set")).toBe(true);
    expect(containsKeyword(fields("Feeder pillars and distribution boxes"), "distribution box")).toBe(true);
    expect(containsKeyword(fields("Generating station works"), "generating set")).toBe(false);
  });

  it("matches multi-word phrases only as a whole, in order", () => {
    expect(containsKeyword(fields("Low voltage power distribution units"), "power distribution")).toBe(true);
    expect(containsKeyword(fields("Power, propulsion and distribution"), "power distribution")).toBe(false);
  });

  it("ignores case, accents and Turkish i forms on both sides", () => {
    expect(containsKeyword(fields("ENERJİ KABLOSU TEDARİKİ"), "enerji kablosu")).toBe(true);
    expect(containsKeyword(fields("Câble électrique"), "CABLE")).toBe(true);
    expect(containsKeyword(fields("kablo"), "KABLO")).toBe(true);
  });

  it("does not match a phrase across two fields", () => {
    expect(containsKeyword(fields("Diesel generating", "Set of spare parts"), "generating set")).toBe(false);
  });

  it("never matches a keyword without letters or digits", () => {
    expect(containsKeyword(fields("-- --"), "--")).toBe(false);
  });
});

describe("findKeywords", () => {
  it("returns hits as written in the profile, in profile order", () => {
    const text = fields("Cables and generators for the depot");
    expect(findKeywords(text, ["Generator", "genset", "CABLE"])).toEqual(["Generator", "CABLE"]);
  });

  it("returns nothing when no keyword occurs", () => {
    expect(findKeywords(fields("Catering services"), ["generator", "cable"])).toEqual([]);
  });
});
