import type { ProfileRulesInput } from "@/matching/rules";

// The profile form's fields and the rules they stand for. Every rule has a
// field here, shown on the form or not, so saving the form keeps what it does
// not show. The browser's half: the rules (Zod, the schema) are imported for
// their types only; the server builds the fields (form-initial.ts).

/** Text-field state; converted to rules on every change. */
export type FormState = {
  name: string;
  active: boolean;
  description: string;
  sources: string[];
  noticeTypes: string[];
  categoryIds: string[];
  /** Prefixes, as the CPV picker keeps them. */
  cpvInclude: string[];
  cpvExclude: string[];
  keywordsAny: string;
  keywordsAll: string;
  keywordsNone: string;
  countries: string;
  valueMinEur: string;
  valueMaxEur: string;
  includeUnknownValue: boolean;
  minDaysToDeadline: string;
  regimes: string[];
  noticeLanguages: string;
  /** Not on the form (unused since Faz 4) but kept, so saving leaves it as stored. */
  triageThreshold: string;
  autoAnalyze: boolean;
  /** Not on the form (no daily digest) but kept, so saving leaves it as stored. */
  notify: boolean;
  analysisQuestions: string;
};

const splitWords = (text: string) => text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
const splitLines = (text: string) => text.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean);
// Questions contain commas, so only line breaks separate them.
const splitQuestions = (text: string) => text.split(/[\r\n]+/).map((t) => t.trim()).filter(Boolean);

/** Number fields stay text: the schema parses them, so unreadable input is rejected rather than dropped. */
export function toRules(s: FormState): ProfileRulesInput {
  return {
    description: s.description,
    sources: s.sources as ProfileRulesInput["sources"],
    noticeTypes: s.noticeTypes as ProfileRulesInput["noticeTypes"],
    categoryIds: s.categoryIds,
    cpvInclude: s.cpvInclude,
    cpvExclude: s.cpvExclude,
    keywordsAny: splitLines(s.keywordsAny),
    keywordsAll: splitLines(s.keywordsAll),
    keywordsNone: splitLines(s.keywordsNone),
    countries: splitWords(s.countries),
    valueMinEur: s.valueMinEur,
    valueMaxEur: s.valueMaxEur,
    includeUnknownValue: s.includeUnknownValue,
    minDaysToDeadline: s.minDaysToDeadline,
    regimes: s.regimes as ProfileRulesInput["regimes"],
    noticeLanguages: splitWords(s.noticeLanguages),
    triageThreshold: s.triageThreshold,
    autoAnalyze: s.autoAnalyze,
    notify: s.notify,
    analysisQuestions: splitQuestions(s.analysisQuestions),
  };
}
