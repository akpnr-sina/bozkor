import { formatNumberInput, type ProfileRules } from "@/matching/rules";
import type { FormState } from "./form-state";

// The profile form's fields filled from stored rules, on the server: the page
// hands them to the form, which keeps the rules modules out of the browser.

export function toState(name: string, active: boolean, rules: ProfileRules): FormState {
  return {
    name,
    active,
    description: rules.description,
    sources: rules.sources,
    noticeTypes: rules.noticeTypes,
    categoryIds: rules.categoryIds,
    cpvInclude: rules.cpvInclude,
    cpvExclude: rules.cpvExclude,
    keywordsAny: rules.keywordsAny.join("\n"),
    keywordsAll: rules.keywordsAll.join("\n"),
    keywordsNone: rules.keywordsNone.join("\n"),
    countries: rules.countries.join(", "),
    valueMinEur: formatNumberInput(rules.valueMinEur),
    valueMaxEur: formatNumberInput(rules.valueMaxEur),
    includeUnknownValue: rules.includeUnknownValue,
    minDaysToDeadline: rules.minDaysToDeadline?.toString() ?? "",
    regimes: rules.regimes,
    noticeLanguages: rules.noticeLanguages.join(", "),
    triageThreshold: rules.triageThreshold.toString(),
    autoAnalyze: rules.autoAnalyze,
    notify: rules.notify,
    analysisQuestions: rules.analysisQuestions.join("\n"),
  };
}
