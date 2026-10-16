import { describe, expect, it } from "vitest";
import { profileRulesSchema } from "@/matching/rules";
import { triageInputsChanged } from "./profile-inputs";

const profile = (name: string, rules: Record<string, unknown>) => ({ name, rules: profileRulesSchema.parse(rules) });

describe("triageInputsChanged", () => {
  const base = profile("Güç", { categoryIds: ["guc"], description: "Jeneratör", countries: ["GB"] });

  it("ignores rules triage does not read", () => {
    expect(triageInputsChanged(base, profile("Güç", { categoryIds: ["guc"], description: "Jeneratör", countries: ["IE"], valueMinEur: 1000 }))).toBe(false);
  });

  it("notices changes to the name, description, categories, keywords and questions", () => {
    expect(triageInputsChanged(base, profile("Güç ekipmanı", { categoryIds: ["guc"], description: "Jeneratör" }))).toBe(true);
    expect(triageInputsChanged(base, profile("Güç", { categoryIds: ["guc"], description: "Jeneratör ve kablo" }))).toBe(true);
    expect(triageInputsChanged(base, profile("Güç", { categoryIds: ["guc", "giyim"], description: "Jeneratör" }))).toBe(true);
    expect(triageInputsChanged(base, profile("Güç", { categoryIds: ["guc"], description: "Jeneratör", keywordsNone: ["hire"] }))).toBe(true);
    expect(triageInputsChanged(base, profile("Güç", { categoryIds: ["guc"], description: "Jeneratör", analysisQuestions: ["Kurulum var mı?"] }))).toBe(true);
  });
});
