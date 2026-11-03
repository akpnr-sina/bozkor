import { describe, expect, it } from "vitest";
import { formatSize, lotSizes, parseNumber, publishedRange, sizeFit } from "./size";

describe("parseNumber", () => {
  it("reads decimal commas and dots, and thousands", () => {
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("5.5")).toBe(5.5);
    expect(parseNumber("1.100")).toBe(1100);
    expect(parseNumber("1,500")).toBe(1500);
  });
});

describe("lotSizes", () => {
  it("reads kVA as it is and turns kW into kVA with the power factor", () => {
    expect(lotSizes("Hinattavat sähkövoimakoneet 12,5 kVa")).toEqual([{ kind: "power", low: 12.5, high: 12.5, fromKw: false }]);
    expect(lotSizes("Nešiojamas 6 kW elektros generatorius")).toEqual([{ kind: "power", low: 7.5, high: 7.5, fromKw: true }]);
    expect(lotSizes("1,2 MW gas genset")).toEqual([{ kind: "power", low: 1500, high: 1500, fromKw: true }]);
  });

  it("takes everything a lot names, ranges included, from the smallest to the largest", () => {
    expect(lotSizes("10-20 kVA and a 100 kVA set")).toEqual([{ kind: "power", low: 10, high: 100, fromKw: false }]);
  });

  it("does not read energy or milliwatts as power", () => {
    expect(lotSizes("Battery 200 kWh, laser 5 mW")).toEqual([]);
  });

  it("reads metric thread sizes, upper-case M only", () => {
    expect(lotSizes("Bolts M12x50 and nuts M16")).toEqual([{ kind: "thread", low: 12, high: 16, fromKw: false }]);
    expect(lotSizes("Area 12 m2")).toEqual([]);
  });
});

describe("publishedRange", () => {
  it("spans every figure a manufacturer gives", () => {
    expect(publishedRange("Endüstriyel dizel jeneratör: 10-3300 kVA;Portatif jeneratör: 1-12 kVA", "power")).toEqual({ kind: "power", low: 1, high: 3300 });
    expect(publishedRange("Yayımlanan dizel örnek modeller: KD13 13 kVA;KD1500 1500 kVA", "power")).toEqual({ kind: "power", low: 13, high: 1500 });
    expect(publishedRange("IDEA motorlu seri: standby 6-15 kVA;prime 5.5-14 kVA", "power")).toEqual({ kind: "power", low: 5.5, high: 15 });
    expect(publishedRange("Somun M5-M72;Cıvata M8-M20", "thread")).toEqual({ kind: "thread", low: 5, high: 72 });
    expect(publishedRange("M6x10-M12x100", "thread")).toEqual({ kind: "thread", low: 6, high: 12 });
  });

  it("is null without a figure of that kind", () => {
    expect(publishedRange("Debriyaj ürünleri: 215-430 mm", "power")).toBeNull();
    expect(publishedRange(null, "thread")).toBeNull();
  });
});

describe("sizeFit", () => {
  it("fits when the ranges overlap, not when they do not, and is unknown without a range", () => {
    const lot = { kind: "power" as const, low: 7.5, high: 7.5 };
    expect(sizeFit(lot, { kind: "power", low: 3, high: 16 })).toBe("in");
    expect(sizeFit(lot, { kind: "power", low: 18, high: 1100 })).toBe("out");
    expect(sizeFit(lot, null)).toBe("unknown");
  });

  it("writes sizes the Turkish way", () => {
    expect(formatSize({ kind: "power", low: 7.5, high: 7.5 })).toBe("7,5 kVA");
    expect(formatSize({ kind: "power", low: 18, high: 1100 })).toBe("18-1.100 kVA");
    expect(formatSize({ kind: "thread", low: 6, high: 30 })).toBe("M6-M30");
  });
});
