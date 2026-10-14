import { describe, expect, it } from "vitest";
import { languageToAlpha2 } from "./languages";

describe("languageToAlpha2", () => {
  it("maps the codes TED uses for EU and EEA languages", () => {
    const expected: Record<string, string> = {
      DEU: "DE", ENG: "EN", FRA: "FR", NLD: "NL", SPA: "ES", ITA: "IT", POL: "PL", RON: "RO", ELL: "EL",
      HUN: "HU", CES: "CS", SLK: "SK", SLV: "SL", BUL: "BG", HRV: "HR", LAV: "LV", LIT: "LT", EST: "ET",
      FIN: "FI", SWE: "SV", DAN: "DA", POR: "PT", MLT: "MT", GLE: "GA", NOR: "NO", ISL: "IS",
    };
    for (const [alpha3, alpha2] of Object.entries(expected)) {
      expect(languageToAlpha2(alpha3), alpha3).toBe(alpha2);
    }
  });

  it("accepts the bibliographic forms too", () => {
    expect(languageToAlpha2("GER")).toBe("DE");
    expect(languageToAlpha2("FRE")).toBe("FR");
    expect(languageToAlpha2("DUT")).toBe("NL");
    expect(languageToAlpha2("GRE")).toBe("EL");
    expect(languageToAlpha2("RUM")).toBe("RO");
    expect(languageToAlpha2("CZE")).toBe("CS");
    expect(languageToAlpha2("SLO")).toBe("SK");
    expect(languageToAlpha2("ICE")).toBe("IS");
  });

  it("counts Bokmål and Nynorsk as Norwegian", () => {
    expect(languageToAlpha2("NOB")).toBe("NO");
    expect(languageToAlpha2("NNO")).toBe("NO");
  });

  it("ignores case and spaces, and keeps known two-letter codes", () => {
    expect(languageToAlpha2(" eng ")).toBe("EN");
    expect(languageToAlpha2("en")).toBe("EN");
    expect(languageToAlpha2("TR")).toBe("TR");
  });

  it("returns null for unknown, mixed and empty codes", () => {
    expect(languageToAlpha2("MUL")).toBeNull();
    expect(languageToAlpha2("XXX")).toBeNull();
    expect(languageToAlpha2("ZZ")).toBeNull();
    expect(languageToAlpha2("")).toBeNull();
    expect(languageToAlpha2(null)).toBeNull();
    expect(languageToAlpha2(undefined)).toBeNull();
  });
});
