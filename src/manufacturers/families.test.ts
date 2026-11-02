import { describe, expect, it } from "vitest";
import { cpvPrefixOf } from "@/matching/cpv/catalog";
import vocabulary from "@/matching/cpv/cpv-2008.json";
import turkish from "@/matching/cpv/cpv-2008-tr.json";
import { FAMILIES, FAMILY_CODES, familiesOfCpvs, isFamilyCode } from "./families";

const codeOfPrefix = new Map((vocabulary as [string, string][]).map(([code]) => [cpvPrefixOf(code), code]));
const turkishName = new Map(turkish as [string, string][]);

describe("FAMILIES", () => {
  it("has the pool's seventeen families, F01 to F17 in order", () => {
    expect(FAMILY_CODES).toEqual(Array.from({ length: 17 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`));
    expect(isFamilyCode("F16")).toBe(true);
    expect(isFamilyCode("F18")).toBe(false);
    expect(isFamilyCode("toString")).toBe(false);
  });

  it("uses only catalogue prefixes of goods codes, each once per family", () => {
    for (const code of FAMILY_CODES) {
      const prefixes: readonly string[] = FAMILIES[code].prefixes;
      expect(new Set(prefixes).size, code).toBe(prefixes.length);
      for (const prefix of prefixes) {
        const cpv = codeOfPrefix.get(prefix);
        expect(cpv, `${code} ${prefix}`).toBeDefined();
        expect(turkishName.get(cpv!), `${code} ${prefix} is not a goods code`).toBeTruthy();
      }
    }
  });

  it("shares a prefix between families only where the overlap is meant", () => {
    const owners = new Map<string, string[]>();
    for (const code of FAMILY_CODES) for (const p of FAMILIES[code].prefixes) owners.set(p, [...(owners.get(p) ?? []), code]);
    const shared = Object.fromEntries([...owners].filter(([, fams]) => fams.length > 1));
    expect(shared).toEqual({ "4214": ["F03", "F12"], "44212": ["F04", "F15"], "351134": ["F13", "F14"] });
  });

  it("leaves out the codes that drew wrong lots or have no maker in the pool", () => {
    const all: string[] = FAMILY_CODES.flatMap((code) => [...FAMILIES[code].prefixes]);
    for (const left of ["315", "3121", "349138", "3314142", "44165", "4451"]) expect(all, left).not.toContain(left);
  });
});

describe("familiesOfCpvs", () => {
  it("finds the family of a code at or under a prefix, with or without the check digit", () => {
    expect(familiesOfCpvs(["18830000"])).toEqual(["F14"]);
    expect(familiesOfCpvs(["31121000-3"])).toEqual(["F16"]);
    expect(familiesOfCpvs(["34320000", "44531000"])).toEqual(["F01", "F17"]);
  });

  it("gives both families for a shared prefix", () => {
    expect(familiesOfCpvs(["35113400"])).toEqual(["F13", "F14"]);
  });

  it("gives no family for a code broader than every prefix, or for codes outside the bridge", () => {
    expect(familiesOfCpvs(["18000000"])).toEqual([]);
    expect(familiesOfCpvs(["31000000"])).toEqual([]);
    expect(familiesOfCpvs(["31520000"])).toEqual([]);
    expect(familiesOfCpvs(["33141420"])).toEqual([]);
    expect(familiesOfCpvs([])).toEqual([]);
    expect(familiesOfCpvs(["", "x"])).toEqual([]);
  });

  it("keeps switching devices in F05, not in F16", () => {
    expect(familiesOfCpvs(["31210000"])).toEqual(["F05"]);
  });
});
