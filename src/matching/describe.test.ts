import { describe, expect, it } from "vitest";
import { describeReason, parseReasons } from "./describe";

describe("parseReasons", () => {
  it("keeps well-formed reasons and drops unknown or malformed entries", () => {
    const stored = [
      { rule: "cpv", codes: ["31121000"], prefixes: ["3112"] },
      { rule: "status" },
      { rule: "cpv", codes: "31121000" },
      { rule: "deadline", daysLeft: 12 },
      { rule: "value", valueEur: null },
      { rule: "regime", value: "imaginary" },
      "noise",
      null,
    ];
    expect(parseReasons(stored)).toEqual([
      { rule: "cpv", codes: ["31121000"], prefixes: ["3112"] },
      { rule: "deadline", daysLeft: 12 },
      { rule: "value", valueEur: null },
    ]);
  });

  it("returns nothing for a value that is not a list", () => {
    expect(parseReasons({ rule: "cpv", codes: [], prefixes: [] })).toEqual([]);
    expect(parseReasons(null)).toEqual([]);
  });
});

describe("describeReason", () => {
  it("presents days left as of the evaluation, with less than a day for 0", () => {
    expect(describeReason({ rule: "deadline", daysLeft: 12 })).toBe("Değerlendirildiğinde son tarihe 12 gün kalmıştı");
    expect(describeReason({ rule: "deadline", daysLeft: 0 })).toBe("Değerlendirildiğinde son tarihe 1 günden az kalmıştı");
    expect(describeReason({ rule: "deadline", daysLeft: null })).toBe("Son tarih belirtilmemiş");
  });

  it("describes every reason in Turkish", () => {
    expect(describeReason({ rule: "cpv", codes: ["31121000", "31321000"], prefixes: ["3112", "313"] })).toBe(
      "CPV 31121000, 31321000 (önek 3112, 313)",
    );
    expect(describeReason({ rule: "keywordsAny", hits: ["generator", "cable"] })).toBe(
      'Anahtar kelime: "generator", "cable"',
    );
    expect(describeReason({ rule: "source", value: "uk_fat" })).toBe("Kaynak: Find a Tender (UK)");
  });
});
