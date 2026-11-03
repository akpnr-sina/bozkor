import { describe, expect, it } from "vitest";
import type { ManufacturerForMatch } from "@/manufacturers/types";
import { filterManufacturers, filterOptions, isFiltered, manufacturersQuery, poolFigures, readManufacturerFilters } from "./filters";

function firm(id: string, fields: Partial<ManufacturerForMatch> = {}): ManufacturerForMatch {
  return {
    id,
    legalName: id,
    province: null,
    categories: [],
    families: [],
    products: [],
    materials: [],
    standards: [],
    sizeRange: null,
    productionMethod: null,
    certifications: [],
    aqap: "unknown",
    as9100: "unknown",
    exports: "unknown",
    fitLevel: null,
    hasEvidenceQuote: false,
    hasContact: false,
    contactState: "not_contacted",
    ...fields,
  };
}

const POOL = [
  firm("BZ-000000000001", {
    legalName: "Örnek Jeneratör San. A.Ş.",
    province: "Tekirdağ",
    categories: ["COMPLEX_GENERATORS"],
    families: ["F16"],
    products: ["Dizel jeneratör setleri", "Aydınlatma kuleleri"],
    certifications: [{ name: "ISO 9001", kind: "management", validUntil: null }],
    exports: "yes",
    hasContact: true,
  }),
  firm("BZ-000000000002", {
    legalName: "İş Giyim Tekstil Ltd. Şti.",
    province: "İstanbul",
    categories: ["TEXTILES_WORKWEAR", "BASIC_EQUIPMENT"],
    families: ["F13", "F14"],
    products: ["İş elbiseleri", "Yüksek görünürlüklü yelekler"],
    materials: ["Polyester"],
    certifications: [{ name: "CE", kind: "product", validUntil: null }],
    contactState: "info_requested",
    hasContact: true,
  }),
  firm("BZ-000000000003", {
    legalName: "Savunma Metal A.Ş.",
    province: "Ankara",
    categories: ["METAL_HARDWARE"],
    families: ["F03"],
    products: ["CNC işlenmiş parçalar"],
    aqap: "2110",
    exports: "no",
  }),
  firm("BZ-000000000004", { legalName: "Kalıp Döküm", province: "Ankara", categories: ["METAL_HARDWARE"], certifications: [{ name: "AQAP 2310", kind: "defense", validUntil: "2028-01-01" }] }),
];

const ids = (list: readonly ManufacturerForMatch[]) => list.map((m) => m.id.slice(-1));

describe("readManufacturerFilters", () => {
  it("keeps known values and drops the rest", () => {
    expect(readManufacturerFilters({})).toEqual({ q: "", category: "", family: "", province: "", certificate: "", exports: "", contact: "", page: 1 });
    expect(
      readManufacturerFilters({ q: "  dizel   jeneratör ", category: "COMPLEX_GENERATORS", family: "F16", province: "Tekirdağ", certificate: "aqap", exports: "yes", contact: "confirmed", page: "3" }),
    ).toEqual({ q: "dizel jeneratör", category: "COMPLEX_GENERATORS", family: "F16", province: "Tekirdağ", certificate: "aqap", exports: "yes", contact: "confirmed", page: 3 });
    expect(readManufacturerFilters({ category: "METAL", family: "F18", certificate: "iso", exports: "evet", contact: "called", page: "0", q: ["a", "b"] })).toEqual(readManufacturerFilters({}));
    expect(readManufacturerFilters({ q: "x".repeat(300) }).q).toHaveLength(100);
  });

  it("round-trips through the query string, defaults left out", () => {
    const f = readManufacturerFilters({ q: "iş elbisesi", family: "F13", province: "İstanbul", page: "2" });
    expect(manufacturersQuery(f)).toBe("?q=i%C5%9F+elbisesi&family=F13&province=%C4%B0stanbul&page=2");
    expect(readManufacturerFilters(Object.fromEntries(new URLSearchParams(manufacturersQuery(f).slice(1))))).toEqual(f);
    expect(manufacturersQuery(readManufacturerFilters({}))).toBe("");
    expect(manufacturersQuery(f, 1)).toBe("?q=i%C5%9F+elbisesi&family=F13&province=%C4%B0stanbul");
    expect([isFiltered(f), isFiltered(readManufacturerFilters({ page: "2" }))]).toEqual([true, false]);
  });
});

describe("filterManufacturers", () => {
  const f = (params: Record<string, string>) => ids(filterManufacturers(POOL, readManufacturerFilters(params)));

  it("searches the name, products and materials without case or Turkish letters", () => {
    expect(f({ q: "JENERATOR" })).toEqual(["1"]);
    expect(f({ q: "is elbise" })).toEqual(["2"]);
    expect(f({ q: "polyester" })).toEqual(["2"]);
    expect(f({ q: "cnc parça" })).toEqual(["3"]);
    expect(f({ q: "jeneratör yelek" })).toEqual([]);
  });

  it("filters by category, family and province", () => {
    expect(f({ category: "METAL_HARDWARE" })).toEqual(["3", "4"]);
    expect(f({ category: "BASIC_EQUIPMENT" })).toEqual(["2"]);
    expect(f({ family: "F14" })).toEqual(["2"]);
    expect(f({ province: "Ankara" })).toEqual(["3", "4"]);
    expect(f({ province: "ankara" })).toEqual([]);
  });

  it("filters by certificates, AQAP from the column or a certificate", () => {
    expect(f({ certificate: "any" })).toEqual(["1", "2", "3", "4"]);
    expect(f({ certificate: "aqap" })).toEqual(["3", "4"]);
    expect(f({ certificate: "management" })).toEqual(["1"]);
    expect(f({ certificate: "product" })).toEqual(["2"]);
    expect(ids(filterManufacturers([...POOL, firm("BZ-000000000005")], readManufacturerFilters({ certificate: "none" })))).toEqual(["5"]);
  });

  it("filters by exports and contact state, and combines filters", () => {
    expect(f({ exports: "yes" })).toEqual(["1"]);
    expect(f({ exports: "unknown" })).toEqual(["2", "4"]);
    expect(f({ contact: "info_requested" })).toEqual(["2"]);
    expect(f({ contact: "not_contacted" })).toEqual(["1", "3", "4"]);
    expect(f({ province: "Ankara", certificate: "aqap", exports: "no" })).toEqual(["3"]);
  });
});

describe("filterOptions and poolFigures", () => {
  it("offer only what the pool has, in the taxonomy's and Turkish order", () => {
    expect(filterOptions(POOL)).toEqual({
      categories: ["METAL_HARDWARE", "TEXTILES_WORKWEAR", "BASIC_EQUIPMENT", "COMPLEX_GENERATORS"],
      families: ["F03", "F13", "F14", "F16"],
      provinces: ["Ankara", "İstanbul", "Tekirdağ"],
    });
    expect(poolFigures(POOL)).toEqual({ total: 4, aqap: 2, exports: 1, withContact: 2 });
  });
});
