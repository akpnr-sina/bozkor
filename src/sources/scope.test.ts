import { describe, expect, it } from "vitest";
import { isProductScope } from "./scope";

describe("isProductScope", () => {
  it("keeps goods", () => {
    expect(isProductScope("goods", "31121000")).toBe(true);
    expect(isProductScope("goods", null)).toBe(true);
  });

  it("drops services and works whatever the CPV", () => {
    expect(isProductScope("services", "31121000")).toBe(false);
    expect(isProductScope("works", "44211000")).toBe(false);
  });

  it("drops software packages even when they are classed as goods", () => {
    expect(isProductScope("goods", "48440000")).toBe(false);
  });

  it("falls back to the CPV division when the nature is not stated", () => {
    expect(isProductScope(null, "18143000")).toBe(true);
    expect(isProductScope(null, "45210000")).toBe(false);
    expect(isProductScope(null, "72000000")).toBe(false);
    expect(isProductScope(null, null)).toBe(false);
  });
});
