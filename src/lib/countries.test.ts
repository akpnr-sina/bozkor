import { describe, expect, it } from "vitest";
import { ALPHA3_TO_ALPHA2, alpha3ToAlpha2, countryNameToAlpha2, isCountryCode, normalizeAlpha2 } from "./countries";

describe("countryNameToAlpha2", () => {
  it("maps English country names", () => {
    expect(countryNameToAlpha2("United Kingdom")).toBe("GB");
    expect(countryNameToAlpha2("Ireland")).toBe("IE");
    expect(countryNameToAlpha2("Germany")).toBe("DE");
    expect(countryNameToAlpha2("The Netherlands")).toBe("NL");
  });

  it("maps UK nations and old names through aliases", () => {
    expect(countryNameToAlpha2("Northern Ireland")).toBe("GB");
    expect(countryNameToAlpha2("Scotland")).toBe("GB");
    expect(countryNameToAlpha2("Turkey")).toBe("TR");
    expect(countryNameToAlpha2("Türkiye")).toBe("TR");
  });

  it("returns null for unknown or empty names", () => {
    expect(countryNameToAlpha2("Atlantis")).toBeNull();
    expect(countryNameToAlpha2("")).toBeNull();
    expect(countryNameToAlpha2(null)).toBeNull();
  });
});

describe("normalizeAlpha2", () => {
  it("uppercases valid codes and maps UK to GB", () => {
    expect(normalizeAlpha2("gb")).toBe("GB");
    expect(normalizeAlpha2("UK")).toBe("GB");
  });

  it("rejects codes that are not two letters", () => {
    expect(normalizeAlpha2("GBR")).toBeNull();
    expect(normalizeAlpha2("1A")).toBeNull();
    expect(normalizeAlpha2(undefined)).toBeNull();
  });
});

describe("alpha3ToAlpha2", () => {
  it("maps EU, EEA and candidate countries, the UK, Switzerland and the US", () => {
    const expected: Record<string, string> = {
      AUT: "AT", BEL: "BE", BGR: "BG", HRV: "HR", CYP: "CY", CZE: "CZ", DNK: "DK", EST: "EE", FIN: "FI",
      FRA: "FR", DEU: "DE", GRC: "GR", HUN: "HU", IRL: "IE", ITA: "IT", LVA: "LV", LTU: "LT", LUX: "LU",
      MLT: "MT", NLD: "NL", POL: "PL", PRT: "PT", ROU: "RO", SVK: "SK", SVN: "SI", ESP: "ES", SWE: "SE",
      ISL: "IS", LIE: "LI", NOR: "NO",
      ALB: "AL", BIH: "BA", GEO: "GE", MDA: "MD", MNE: "ME", MKD: "MK", SRB: "RS", TUR: "TR", UKR: "UA",
      GBR: "GB", CHE: "CH", USA: "US",
    };
    for (const [alpha3, alpha2] of Object.entries(expected)) {
      expect(alpha3ToAlpha2(alpha3), alpha3).toBe(alpha2);
    }
  });

  it("maps the EU's codes for Kosovo", () => {
    expect(alpha3ToAlpha2("XKX")).toBe("XK");
    expect(alpha3ToAlpha2("1A0")).toBe("XK");
  });

  it("ignores case and surrounding spaces", () => {
    expect(alpha3ToAlpha2(" deu ")).toBe("DE");
  });

  it("returns null for unknown, empty and two-letter codes", () => {
    expect(alpha3ToAlpha2("XYZ")).toBeNull();
    expect(alpha3ToAlpha2("DE")).toBeNull();
    expect(alpha3ToAlpha2("")).toBeNull();
    expect(alpha3ToAlpha2(null)).toBeNull();
    expect(alpha3ToAlpha2(undefined)).toBeNull();
  });

  it("covers all of ISO 3166-1 with distinct, valid alpha-2 codes", () => {
    const iso = [...ALPHA3_TO_ALPHA2].filter(([alpha3]) => alpha3 !== "XKX" && alpha3 !== "1A0");
    expect(iso).toHaveLength(249);
    expect(new Set(iso.map(([, alpha2]) => alpha2)).size).toBe(249);
    for (const [alpha3, alpha2] of ALPHA3_TO_ALPHA2) {
      expect(isCountryCode(alpha2), `${alpha3} -> ${alpha2}`).toBe(true);
    }
  });
});
