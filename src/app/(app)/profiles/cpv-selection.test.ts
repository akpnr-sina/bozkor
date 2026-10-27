import { describe, expect, it } from "vitest";
import { addCpv, cpvStanding, moveCpv, removeCpv, typedPrefix, type CpvLists } from "./cpv-selection";

const lists = (include: string[] = [], exclude: string[] = []): CpvLists => ({ include, exclude });
const guc = [
  { prefix: "3112", category: "Güç" },
  { prefix: "312", category: "Güç" },
];

describe("addCpv", () => {
  it("adds a prefix to the list asked for", () => {
    expect(addCpv(lists(), "31121", "include")).toEqual({ lists: lists(["31121"]), message: null });
    expect(addCpv(lists(["31121"]), "3113", "exclude")).toEqual({ lists: lists(["31121"], ["3113"]), message: null });
  });

  it("says when the list already holds it, itself or through a shorter prefix", () => {
    const chosen = lists(["3112"], ["45"]);
    expect(addCpv(chosen, "3112", "include")).toEqual({ lists: chosen, message: "3112 zaten Dahil listesinde." });
    expect(addCpv(chosen, "31121", "include")).toEqual({ lists: chosen, message: "31121 zaten 3112 ile kapsanıyor." });
    expect(addCpv(chosen, "451", "exclude")).toEqual({ lists: chosen, message: "451 zaten 45 ile kapsanıyor." });
  });

  it("says when a chosen category already includes it", () => {
    expect(addCpv(lists(), "31121", "include", guc)).toEqual({ lists: lists(), message: "31121 zaten Güç kategorisiyle (3112) kapsanıyor." });
    expect(addCpv(lists(), "312", "include", guc)).toMatchObject({ lists: lists(), message: expect.stringContaining("Güç kategorisiyle (312)") });
    // Excluding a part of a category is what the Hariç list is for.
    expect(addCpv(lists(), "31121", "exclude", guc)).toEqual({ lists: lists([], ["31121"]), message: null });
  });

  it("does not include a code inside an excluded prefix, which matching would never reach", () => {
    expect(addCpv(lists([], ["3112"]), "31121", "include")).toEqual({
      lists: lists([], ["3112"]),
      message: "31121, Hariç listesindeki 3112 içinde kaldığı için eşleşmez. Önce 3112 kodunu çıkarın.",
    });
  });

  it("takes out the prefixes a new shorter one holds, and moves one from the other list", () => {
    expect(addCpv(lists(["31121", "31122", "3113"]), "3112", "include")).toEqual({
      lists: lists(["3113", "3112"]),
      message: "31121, 31122 artık 3112 ile kapsandığı için listeden çıktı.",
    });
    expect(addCpv(lists(["3112"], ["45"]), "45", "include")).toEqual({
      lists: lists(["3112", "45"]),
      message: "45, Hariç listesinden Dahil listesine taşındı.",
    });
  });

  it("warns when an exclusion takes in included prefixes", () => {
    expect(addCpv(lists(["31121", "3113"]), "311", "exclude")).toEqual({
      lists: lists(["31121", "3113"], ["311"]),
      message: "Dahil listesindeki 31121, 3113 artık 311 ile hariç tutuluyor.",
    });
  });
});

describe("addCpv messages", () => {
  it("name prefixes as the picker shows them", () => {
    const show = (prefix: string) => prefix.padEnd(8, "0");
    expect(addCpv(lists(["3112"]), "31121", "include", [], show).message).toBe("31121000 zaten 31120000 ile kapsanıyor.");
    expect(addCpv(lists(["31121", "31122"]), "3112", "include", [], show).message).toBe(
      "31121000, 31122000 artık 31120000 ile kapsandığı için listeden çıktı.",
    );
    expect(moveCpv(lists(["31121"]), "31121", [], show).message).toBe("31121000, Dahil listesinden Hariç listesine taşındı.");
  });
});

describe("moveCpv and removeCpv", () => {
  it("moves a prefix to the other list under the same rules", () => {
    expect(moveCpv(lists(["31121"], ["3113"]), "31121")).toEqual({
      lists: lists([], ["3113", "31121"]),
      message: "31121, Dahil listesinden Hariç listesine taşındı.",
    });
    expect(moveCpv(lists(["31121"], ["3113"]), "3113")).toMatchObject({ lists: lists(["31121", "3113"], []) });
    // Into a list that holds it already through a shorter prefix: it stays where it is.
    expect(moveCpv(lists(["31121"], ["3112"]), "31121")).toEqual({ lists: lists(["31121"], ["3112"]), message: "31121 zaten 3112 ile kapsanıyor." });
  });

  it("removes a prefix from either list", () => {
    expect(removeCpv(lists(["31121", "3113"], ["45"]), "3113")).toEqual(lists(["31121"], ["45"]));
    expect(removeCpv(lists(["31121"], ["45"]), "45")).toEqual(lists(["31121"], []));
  });
});

describe("cpvStanding", () => {
  it("tells whether a code is chosen, held by a chosen prefix or category, or free", () => {
    const chosen = lists(["3112"], ["31122"]);
    expect(cpvStanding(chosen, "3112")).toBe("include");
    expect(cpvStanding(chosen, "31121")).toBe("covered");
    expect(cpvStanding(chosen, "31122")).toBe("exclude");
    expect(cpvStanding(chosen, "311221")).toBe("exclude");
    expect(cpvStanding(chosen, "312", guc)).toBe("covered");
    expect(cpvStanding(chosen, "33")).toBeNull();
  });
});

describe("typedPrefix", () => {
  it("takes 2 to 8 digits, a full code with its check digit too", () => {
    expect(typedPrefix(" 312 ")).toBe("312");
    expect(typedPrefix("31121000-7")).toBe("31121000");
    expect(typedPrefix("3")).toBeNull();
    expect(typedPrefix("123456789")).toBeNull();
    expect(typedPrefix("31a")).toBeNull();
    expect(typedPrefix("generator")).toBeNull();
  });
});
