import { describe, expect, it } from "vitest";
import { countryNameToAlpha2, normalizeAlpha2 } from "./countries";

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
