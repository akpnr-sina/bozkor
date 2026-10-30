import { describe, expect, it } from "vitest";
import { cpvLevelOf, cpvName, cpvPrefixOf, createCpvCatalog, normalizeCpvText } from "./catalog";

// A few codes shaped like the vocabulary's (names shortened), with a missing
// group (093) and codes out of scope: works (45), software (48), services (50).
const catalog = createCpvCatalog([
  ["03000000", "Agricultural, farming, fishing, forestry and related products"],
  ["03100000", "Agricultural and horticultural products"],
  ["09000000", "Petroleum products, fuel, electricity and other sources of energy"],
  ["09310000", "Electricity"],
  ["31000000", "Electrical machinery, apparatus, equipment and consumables; lighting"],
  ["31100000", "Electric motors, generators and transformers"],
  ["31120000", "Generators"],
  ["31121000", "Generating sets"],
  ["31121100", "Generating sets with compression-ignition engines"],
  ["31122000", "Generator units"],
  ["31130000", "Alternators and regenerators"],
  ["31200000", "Electricity distribution and control apparatus"],
  ["44000000", "Construction structures and materials"],
  ["45000000", "Construction work"],
  ["45100000", "Site preparation work"],
  ["48000000", "Software package and information systems"],
  ["50000000", "Repair and maintenance services"],
  ["50100000", "Repair, maintenance and associated services of vehicles"],
]);

const prefixes = (items: { prefix: string }[]) => items.map((item) => item.prefix);

describe("CPV prefixes and levels", () => {
  it("drops the trailing zeros, keeping the division's two digits", () => {
    expect(cpvPrefixOf("31121000")).toBe("31121");
    expect(cpvPrefixOf("31121100")).toBe("311211");
    expect(cpvPrefixOf("31000000")).toBe("31");
    expect(cpvPrefixOf("03000000")).toBe("03");
    expect(cpvPrefixOf("30000000")).toBe("30");
    expect(cpvPrefixOf("33111710")).toBe("3311171");
  });

  it("names the level by the prefix's length", () => {
    expect(["31", "312", "3112", "31121", "311211", "3112111", "31121111"].map(cpvLevelOf)).toEqual([
      "Bölüm",
      "Grup",
      "Sınıf",
      "Kategori",
      "Alt kategori",
      "Alt kategori",
      "Alt kategori",
    ]);
  });

  it("compares names without case, accents or punctuation", () => {
    expect(normalizeCpvText("Électricité, GÉNÉRATEURS;  et  câbles")).toBe("electricite generateurs et cables");
    expect(normalizeCpvText("JENERATÖR İLE ışık")).toBe("jenerator ile isik");
  });
});

describe("createCpvCatalog", () => {
  it("finds a code by its prefix or its eight digits, with its level and whether it has codes under it", () => {
    expect(catalog.item("31121")).toEqual({ prefix: "31121", code: "31121000", label: "Generating sets", labelTr: null, level: "Kategori", hasChildren: true });
    expect(catalog.item("31121000")).toMatchObject({ prefix: "31121", label: "Generating sets" });
    expect(catalog.item("311211")).toMatchObject({ level: "Alt kategori", hasChildren: false });
    expect(catalog.label("3112")).toBe("Generators");
    expect(catalog.item("3119")).toBeNull();
    expect(catalog.label("99")).toBeNull();
  });

  it("puts each code under the nearest code above it, past a missing level", () => {
    expect(prefixes(catalog.children("31"))).toEqual(["311", "312"]);
    expect(prefixes(catalog.children("311"))).toEqual(["3112", "3113"]);
    expect(prefixes(catalog.children("3112"))).toEqual(["31121", "31122"]);
    expect(prefixes(catalog.children("31121"))).toEqual(["311211"]);
    // 09310000 has no group 093 above it: it hangs from the division.
    expect(prefixes(catalog.children("09"))).toEqual(["0931"]);
    expect(catalog.children("311211")).toEqual([]);
    expect(catalog.children("77")).toEqual([]);
  });

  it("starts the tree at the goods divisions: no works, software or services", () => {
    expect(prefixes(catalog.children(null))).toEqual(["03", "09", "31", "44"]);
    expect(catalog.children(null)[0]).toMatchObject({ level: "Bölüm", hasChildren: true });
  });

  it("finds codes by their first digits, the code itself first, higher levels first", () => {
    expect(prefixes(catalog.search("3112"))).toEqual(["3112", "31121", "31122", "311211"]);
    expect(prefixes(catalog.search("311", 3))).toEqual(["311", "3112", "3113"]);
    // Eight digits are one code.
    expect(prefixes(catalog.search("31121000"))).toEqual(["31121"]);
    expect(prefixes(catalog.search("31121000-7"))).toEqual(["31121"]);
    expect(prefixes(catalog.search(" 312 "))).toEqual(["312"]);
    expect(prefixes(catalog.search("31", 3))).toEqual(["31", "311", "312"]);
    // Out of scope, and digits that are no code.
    expect(catalog.search("45")).toEqual([]);
    expect(catalog.search("50")).toEqual([]);
    expect(catalog.search("123456789")).toEqual([]);
  });

  it("finds codes by words in any case or accent: the name, its start, a word's start, inside, all the words", () => {
    expect(prefixes(catalog.search("generators"))).toEqual(["3112", "311", "3113"]);
    expect(prefixes(catalog.search("GÉNÉRATING"))).toEqual(["31121", "311211"]);
    // A word that starts with it (311) comes before a word it is inside (3113), whatever the level.
    expect(prefixes(catalog.search("generat"))).toEqual(["3112", "31121", "31122", "311211", "311", "3113"]);
    // Names starting with it, the division first; then a word inside a name.
    expect(prefixes(catalog.search("electric"))).toEqual(["31", "311", "312", "0931", "09"]);
    expect(prefixes(catalog.search("sets compression"))).toEqual(["311211"]);
    expect(prefixes(catalog.search("ignition"))).toEqual(["311211"]);
    // Services and works are out of the profile's scope.
    expect(catalog.search("maintenance")).toEqual([]);
    expect(catalog.search("construction work")).toEqual([]);
    expect(catalog.search("e")).toEqual([]);
    expect(catalog.search("   ")).toEqual([]);
  });
});

describe("Turkish names", () => {
  const bilingual = createCpvCatalog(
    [
      ["31000000", "Electrical machinery, apparatus, equipment and consumables; lighting"],
      ["31120000", "Generators"],
      ["31121000", "Generating sets"],
      ["31121100", "Generating sets with compression-ignition engines"],
      ["31130000", "Alternators"],
    ],
    [
      ["31000000", "Elektrikli makineler, cihazlar, ekipman ve sarf malzemeleri; aydınlatma"],
      ["31120000", "Jeneratörler"],
      ["31121000", "Jeneratör setleri"],
      ["31121100", "Dizel motorlu jeneratör setleri"],
    ],
  );

  it("gives a code its Turkish name beside the official English one, and shows the Turkish where there is one", () => {
    const item = bilingual.item("3112")!;
    expect(item).toMatchObject({ label: "Generators", labelTr: "Jeneratörler" });
    expect(cpvName(item)).toBe("Jeneratörler");
    expect(bilingual.item("3113")).toMatchObject({ label: "Alternators", labelTr: null });
    expect(cpvName(bilingual.item("3113")!)).toBe("Alternators");
    expect(bilingual.children("31")[0]).toMatchObject({ labelTr: "Jeneratörler" });
  });

  it("finds codes by either name, without Turkish letters too, ranked by the better of the two", () => {
    expect(prefixes(bilingual.search("jeneratör"))).toEqual(["3112", "31121", "311211"]);
    expect(prefixes(bilingual.search("JENERATOR SET"))).toEqual(["31121", "311211"]);
    expect(prefixes(bilingual.search("dizel"))).toEqual(["311211"]);
    // "generating sets" starts the English name of 31121, and is only inside 311211's.
    expect(prefixes(bilingual.search("generating sets"))).toEqual(["31121", "311211"]);
    expect(prefixes(bilingual.search("aydinlatma"))).toEqual(["31"]);
  });
});
