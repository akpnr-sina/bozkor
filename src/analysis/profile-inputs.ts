import type { ProfileRules } from "@/matching/rules";

/** What triage reads from a profile (see TriageProfile); other rules only decide which tenders match. */
export function triageInputsOf(name: string, rules: ProfileRules) {
  return {
    name,
    description: rules.description,
    categoryIds: rules.categoryIds,
    keywordsAny: rules.keywordsAny,
    keywordsNone: rules.keywordsNone,
    analysisQuestions: rules.analysisQuestions,
  };
}

/** Whether a profile edit changes what triage reads, so its open matches need a new triage. */
export function triageInputsChanged(
  before: { name: string; rules: ProfileRules },
  after: { name: string; rules: ProfileRules },
): boolean {
  return JSON.stringify(triageInputsOf(before.name, before.rules)) !== JSON.stringify(triageInputsOf(after.name, after.rules));
}
