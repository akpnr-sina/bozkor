import { describe, expect, it } from "vitest";
import { isProductScope } from "@/sources/scope";
import { cpvPrefixOf } from "./catalog";
import vocabulary from "./cpv-2008.json";
import turkish from "./cpv-2008-tr.json";
import { cpvChildren, cpvItems, cpvLabel, searchCpv } from "./index";
import { CPV_CODE_COUNT, cpvProblems, type CpvRow } from "./source";

const rows = vocabulary as CpvRow[];

describe("cpv-2008.json", () => {
  it("holds the whole vocabulary: every code once, eight digits, with an English name, in code order", () => {
    expect(rows).toHaveLength(CPV_CODE_COUNT);
    expect(cpvProblems(rows)).toEqual([]);
    expect(rows.map(([code]) => code)).toEqual(rows.map(([code]) => code).sort());
    expect(new Set(rows.map(([code]) => code.slice(0, 2))).size).toBe(45);
  });

  it("has the codes the profiles and the team know", () => {
    const names = new Map(rows);
    expect(names.get("03000000")).toBe("Agricultural, farming, fishing, forestry and related products");
    expect(names.get("18100000")).toBe("Occupational clothing, special workwear and accessories");
    expect(names.get("31120000")).toBe("Generators");
    expect(names.get("31121000")).toBe("Generating sets");
    expect(names.get("35113400")).toBe("Protective and safety clothing");
    expect(names.get("03131300")).toBe("Maté");
  });

  it("gives each code its own prefix", () => {
    const prefixes = rows.map(([code]) => cpvPrefixOf(code));
    expect(new Set(prefixes).size).toBe(rows.length);
  });
});

describe("cpv-2008-tr.json", () => {
  const names = new Map(turkish as [string, string][]);

  it("names every goods code the form offers in Turkish, and nothing else", () => {
    const goods = rows.filter(([code]) => isProductScope(null, code)).map(([code]) => code);
    expect(goods.filter((code) => !names.get(code)?.trim())).toEqual([]);
    expect([...names.keys()].filter((code) => !isProductScope(null, code))).toEqual([]);
    expect([...names.values()].filter((name) => name.includes("\u2014"))).toEqual([]);
  });

  it("has the names the team looks for", () => {
    expect(names.get("31121000")).toBe("Jeneratör setleri");
    expect(names.get("18100000")).toBe("Meslek giysileri, özel iş giysileri ve aksesuarları");
    expect(names.get("44211000")).toBe("Prefabrik binalar");
    expect(searchCpv("jeneratör").map((item) => item.code)).toContain("31121000");
    expect(cpvChildren(null).every((item) => item.labelTr)).toBe(true);
  });
});

describe("the CPV catalog on the vocabulary", () => {
  it("names stored prefixes, and full codes stored as prefixes", () => {
    expect(cpvLabel("31121")).toBe("Generating sets");
    expect(cpvLabel("3112")).toBe("Generators");
    expect(cpvLabel("31121000")).toBe("Generating sets");
    expect(cpvLabel("181")).toBe("Occupational clothing, special workwear and accessories");
    expect(cpvLabel("31999")).toBeNull();
    expect(cpvItems(["3112", "31999", "3112"])).toEqual({
      "3112": { prefix: "3112", code: "31120000", label: "Generators", labelTr: "Jeneratörler", level: "Sınıf", hasChildren: true },
      "31999": null,
    });
  });

  it("roots the tree at the goods divisions, 03 to 44 without software", () => {
    const roots = cpvChildren(null);
    const divisions = roots.map((item) => item.prefix);
    expect(divisions[0]).toBe("03");
    expect(divisions.at(-1)).toBe("44");
    expect(divisions).toContain("18");
    expect(divisions).toContain("31");
    expect(divisions.some((d) => Number(d) >= 45)).toBe(false);
    expect(roots.every((item) => item.level === "Bölüm" && item.hasChildren && isProductScope(null, item.code))).toBe(true);
    expect(divisions).toHaveLength(22);
  });

  it("goes down the tree level by level, every code under the one above it", () => {
    expect(cpvChildren("3112").map((item) => item.prefix)).toEqual(expect.arrayContaining(["31121", "31122"]));
    for (const item of cpvChildren("31")) {
      expect(item.prefix.startsWith("31")).toBe(true);
      for (const child of cpvChildren(item.prefix)) expect(child.prefix.startsWith(item.prefix)).toBe(true);
    }
  });

  it("searches codes by digits and names, within goods", () => {
    expect(searchCpv("31121000")[0]).toMatchObject({ prefix: "31121", label: "Generating sets" });
    expect(searchCpv("3112", 3).map((item) => item.prefix)).toEqual(["3112", "31121", "31122"]);
    expect(searchCpv("generating sets")[0]).toMatchObject({ prefix: "31121" });
    expect(searchCpv("MATE")).toEqual(expect.arrayContaining([expect.objectContaining({ code: "03131300" })]));
    expect(searchCpv("protective and safety clothing")[0]).toMatchObject({ code: "35113400" });
    // Works, software and services stay out.
    expect(searchCpv("45")).toEqual([]);
    expect(searchCpv("construction work")).toEqual([]);
    expect(searchCpv("software package").every((item) => !item.code.startsWith("48"))).toBe(true);
  });
});
