import { describe, expect, it } from "vitest";
import { formatNumberInput, parseNumberInput, profileRulesSchema } from "./rules";

const firstIssue = (input: Record<string, unknown>) => profileRulesSchema.safeParse(input).error?.issues[0]?.message;

const AMOUNT_MESSAGE = "Tutar sayı olmalı, örn. 20.000 ya da 1,5";
const DAYS_MESSAGE = "Gün sayısı 0 ile 365 arasında tam sayı olmalı, örn. 10";
const THRESHOLD_MESSAGE = "Uyum eşiği 0 ile 100 arasında tam sayı olmalı";

describe("parseNumberInput", () => {
  it.each([
    ["20000", 20_000],
    ["20.000", 20_000],
    ["1.250.000", 1_250_000],
    ["20,000", 20_000],
    ["1,250,000", 1_250_000],
    ["20000.50", 20_000.5],
    ["1,5", 1.5],
    ["0,25", 0.25],
    ["1.250.000,5", 1_250_000.5],
    ["1,250,000.50", 1_250_000.5],
    [" 20 000 ", 20_000],
    ["€20.000", 20_000],
    ["20.000 EUR", 20_000],
    ["eur 1,5", 1.5],
    ["-5", -5],
  ])("reads %j as %d", (text, expected) => {
    expect(parseNumberInput(text)).toBe(expected);
  });

  it("turns empty text into null and passes other values through", () => {
    expect(parseNumberInput("  ")).toBeNull();
    expect(parseNumberInput(42)).toBe(42);
    expect(parseNumberInput(null)).toBeNull();
    expect(parseNumberInput(undefined)).toBeUndefined();
  });

  it.each(["20k", "10 gün", "0.125", "1.2345", "1.250.000.5", "1,250,000,50", "12.34.56", "1e5", "--5"])(
    "returns %j unchanged so the schema can reject it",
    (text) => {
      expect(parseNumberInput(text)).toBe(text);
    },
  );
});

describe("formatNumberInput", () => {
  it.each([0, 1.5, 999.99, 1_000, 20_000, 20_000.5, 1_250_000.5])("shows %d so that reading it back gives the same value", (value) => {
    expect(parseNumberInput(formatNumberInput(value))).toBe(value);
  });

  it("uses Turkish separators and an empty field for null", () => {
    expect(formatNumberInput(1_250_000.5)).toBe("1.250.000,5");
    expect(formatNumberInput(null)).toBe("");
  });
});

describe("profileRulesSchema", () => {
  it("reads typed amounts and rejects unreadable ones instead of dropping them", () => {
    expect(profileRulesSchema.parse({ valueMinEur: "20.000", valueMaxEur: "1.250.000,5" })).toMatchObject({
      valueMinEur: 20_000,
      valueMaxEur: 1_250_000.5,
    });
    expect(profileRulesSchema.parse({ valueMinEur: "" }).valueMinEur).toBeNull();
    expect(firstIssue({ valueMinEur: "20k" })).toBe(AMOUNT_MESSAGE);
    expect(firstIssue({ valueMinEur: Number.NaN })).toBe(AMOUNT_MESSAGE);
    expect(firstIssue({ valueMaxEur: "-5" })).toBe("Tutar negatif olamaz");
    expect(firstIssue({ valueMinEur: "500.000", valueMaxEur: "20.000" })).toBe(
      "En düşük tutar en yüksek tutardan büyük olamaz",
    );
  });

  it("accepts only whole days between 0 and 365", () => {
    expect(profileRulesSchema.parse({ minDaysToDeadline: "10" }).minDaysToDeadline).toBe(10);
    expect(profileRulesSchema.parse({ minDaysToDeadline: "" }).minDaysToDeadline).toBeNull();
    for (const text of ["10 gün", "7,5", "400", "-1"]) {
      expect(firstIssue({ minDaysToDeadline: text }), text).toBe(DAYS_MESSAGE);
    }
  });

  it("defaults an empty triage threshold to 60 and rejects anything but 0 to 100", () => {
    expect(profileRulesSchema.parse({ triageThreshold: "" }).triageThreshold).toBe(60);
    expect(profileRulesSchema.parse({ triageThreshold: "75" }).triageThreshold).toBe(75);
    expect(firstIssue({ triageThreshold: "abc" })).toBe(THRESHOLD_MESSAGE);
    expect(firstIssue({ triageThreshold: "101" })).toBe(THRESHOLD_MESSAGE);
  });

  it("maps UK and EL to their ISO codes and rejects codes that are not countries", () => {
    expect(profileRulesSchema.parse({ countries: ["uk", "EL", "ie", "GB"] }).countries).toEqual(["GB", "GR", "IE"]);
    expect(firstIssue({ countries: ["EN"] })).toBe("EN bir ülke kodu değil; iki harfli ISO kodu girin, örn. GB, IE, NL");
    expect(firstIssue({ countries: ["EU"] })).toContain("EU bir ülke kodu değil");
    expect(firstIssue({ countries: ["GBR"] })).toBe("Ülke kodu iki harf olmalı (ISO 3166 alpha-2)");
  });

  it("drops the check digit of a copied CPV code", () => {
    expect(profileRulesSchema.parse({ cpvInclude: ["31121000-7", " 3112 "] }).cpvInclude).toEqual(["31121000", "3112"]);
    expect(firstIssue({ cpvExclude: ["3112-0"] })).toBe("CPV öneki 2 ile 8 rakam arasında olmalı");
  });

  it("explains length and count limits in Turkish", () => {
    const questions = Array.from({ length: 21 }, (_, i) => `Soru ${i + 1}?`);
    expect(firstIssue({ analysisQuestions: questions })).toBe("En fazla 20 soru eklenebilir");
    expect(firstIssue({ keywordsAny: ["x".repeat(101)] })).toBe("Anahtar kelime en fazla 100 karakter olabilir");
    expect(firstIssue({ keywordsNone: ["--"] })).toBe("Anahtar kelime en az bir harf ya da rakam içermeli");
  });
});
