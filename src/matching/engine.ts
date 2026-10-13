import type { ProfileRules } from "./rules";
import { containsKeyword, findKeywords, tenderText } from "./text";
import type { MatchableTender, MatchContext, MatchReason, MatchResult, RuleKey } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

const unique = <T>(values: T[]): T[] => [...new Set(values)];
const rejected = (rule: RuleKey): MatchResult => ({ matched: false, rejectedBy: rule });

/**
 * An empty list means no filter (undefined). Otherwise returns the tender's
 * value when the list contains it, or null to reject; an unknown value never passes.
 */
function listed<T extends string>(allowed: readonly string[], value: T | null): T | null | undefined {
  if (!allowed.length) return undefined;
  return value !== null && allowed.includes(value) ? value : null;
}

/**
 * Applies a criteria profile to one tender (SPEC section 6). Pure: the clock
 * and the category taxonomy come from `context`. Rules run in a fixed order
 * and the first one that rejects is reported; a match lists why each
 * configured rule passed.
 */
export function matchTender(tender: MatchableTender, rules: ProfileRules, context: MatchContext): MatchResult {
  const reasons: MatchReason[] = [];

  if (tender.status !== "open") return rejected("status");

  const source = listed(rules.sources, tender.source);
  if (source === null) return rejected("source");
  if (source !== undefined) reasons.push({ rule: "source", value: source });

  const noticeType = listed(rules.noticeTypes, tender.noticeType);
  if (noticeType === null) return rejected("noticeType");
  if (noticeType !== undefined) reasons.push({ rule: "noticeType", value: noticeType });

  const regime = listed(rules.regimes, tender.regime);
  if (regime === null) return rejected("regime");
  if (regime !== undefined) reasons.push({ rule: "regime", value: regime });

  const country = listed(rules.countries, tender.buyerCountry);
  if (country === null) return rejected("country");
  if (country !== undefined) reasons.push({ rule: "country", value: country });

  const language = listed(rules.noticeLanguages, tender.noticeLanguage);
  if (language === null) return rejected("language");
  if (language !== undefined) reasons.push({ rule: "language", value: language });

  // A passed deadline closes the tender whatever the profile says; an unknown one passes.
  const deadline = tender.submissionDeadline?.getTime() ?? null;
  const now = context.now.getTime();
  if (deadline !== null && deadline <= now) return rejected("deadline");
  if (rules.minDaysToDeadline !== null) {
    const daysLeft = deadline === null ? null : Math.floor((deadline - now) / DAY_MS);
    if (daysLeft !== null && daysLeft < rules.minDaysToDeadline) return rejected("deadline");
    reasons.push({ rule: "deadline", daysLeft });
  }

  if (rules.valueMinEur !== null || rules.valueMaxEur !== null) {
    const { valueEur } = tender;
    if (valueEur === null) {
      if (!rules.includeUnknownValue) return rejected("value");
    } else if (
      (rules.valueMinEur !== null && valueEur < rules.valueMinEur) ||
      (rules.valueMaxEur !== null && valueEur > rules.valueMaxEur)
    ) {
      return rejected("value");
    }
    reasons.push({ rule: "value", valueEur });
  }

  // Normalizing long descriptions is the costliest step; only keyword rules need it.
  let text: string[] | undefined;
  const fields = () => (text ??= tenderText(tender));

  if (rules.keywordsNone.some((keyword) => containsKeyword(fields(), keyword))) return rejected("keywordsNone");

  const categories = new Map(context.categories.map((category) => [category.id, category.cpvPrefixes]));
  const includePrefixes = unique([
    ...rules.cpvInclude,
    // Unknown category ids are ignored; a blank prefix would match every code.
    ...rules.categoryIds.flatMap((id) => categories.get(id) ?? []).filter(Boolean),
  ]);
  const codes = unique(
    [tender.cpvMain, ...tender.cpvAdditional, ...tender.lots.flatMap((lot) => lot.cpv)].filter(
      (code): code is string => Boolean(code),
    ),
  );
  const includable = codes.filter((code) => !rules.cpvExclude.some((prefix) => code.startsWith(prefix)));

  if (includePrefixes.length || rules.keywordsAny.length) {
    // CPV or keyword: missing a relevant tender costs more than an extra one, and triage scores them later.
    const hitCodes = includable.filter((code) => includePrefixes.some((prefix) => code.startsWith(prefix)));
    const hitPrefixes = includePrefixes.filter((prefix) => hitCodes.some((code) => code.startsWith(prefix)));
    const hits = rules.keywordsAny.length ? findKeywords(fields(), rules.keywordsAny) : [];
    if (!hitCodes.length && !hits.length) return rejected("topic");
    if (hitCodes.length) reasons.push({ rule: "cpv", codes: hitCodes, prefixes: hitPrefixes });
    if (hits.length) reasons.push({ rule: "keywordsAny", hits });
  } else if (rules.cpvExclude.length && codes.length && !includable.length) {
    return rejected("topic");
  }

  if (rules.keywordsAll.length) {
    const hits = findKeywords(fields(), rules.keywordsAll);
    if (hits.length < rules.keywordsAll.length) return rejected("keywordsAll");
    reasons.push({ rule: "keywordsAll", hits });
  }

  return { matched: true, reasons };
}
