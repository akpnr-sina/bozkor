import { describe, expect, it } from "vitest";
import { profileRulesSchema, type ProfileRules } from "@/matching/rules";
import { toState } from "./form-initial";
import { toRules } from "./form-state";

/** What saving the form stores for rules it was opened with, untouched. */
const saved = (rules: ProfileRules) => profileRulesSchema.parse(toRules(toState("Güç", true, rules)));

// The example of SPEC section 6, with a threshold and a digest setting the form no longer shows.
const example = profileRulesSchema.parse({
  description: "Jeneratör seti, güç dağıtım ekipmanı ve kablo tedariki. Kurulum veya kiralama hizmeti istemiyoruz.",
  sources: ["uk_fat", "eu_ted"],
  noticeTypes: ["tender", "planning"],
  categoryIds: ["guc"],
  cpvInclude: ["3112", "312", "313"],
  cpvExclude: ["31682"],
  keywordsAny: ["generator", "generating set", "genset", "power distribution", "cable"],
  keywordsAll: ["supply"],
  keywordsNone: ["hire", "maintenance services"],
  countries: ["GB", "IE", "NL", "BE"],
  valueMinEur: 20000,
  valueMaxEur: 500000,
  includeUnknownValue: false,
  minDaysToDeadline: 10,
  regimes: ["below_threshold", "covered"],
  noticeLanguages: ["EN"],
  triageThreshold: 72,
  autoAnalyze: true,
  notify: false,
  analysisQuestions: [
    "Asgari ciro şartı var mı, varsa ne kadar?",
    "Ürün menşei ya da tedarikçinin yerleşik olduğu ülkeye kısıt var mı?",
    "Kurulum, bakım ya da yerinde servis yükümlülüğü var mı?",
  ],
});

describe("the profile form's state", () => {
  it("stores the rules it was opened with, the fields it does not show included", () => {
    expect(saved(example)).toEqual(example);
    expect(saved(example)).toMatchObject({ triageThreshold: 72, notify: false });
    const fresh = profileRulesSchema.parse({});
    expect(saved(fresh)).toEqual(fresh);
  });

  it("keeps the threshold and the digest setting when the fields it shows change", () => {
    const state = { ...toState("Güç", true, example), description: "Yalnız jeneratör seti", autoAnalyze: false };
    expect(profileRulesSchema.parse(toRules(state))).toEqual({ ...example, description: "Yalnız jeneratör seti", autoAnalyze: false });
  });
});
