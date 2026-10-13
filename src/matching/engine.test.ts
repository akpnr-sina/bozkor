import { describe, expect, it } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { foldNotices } from "@/sources/fold";
import { normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { matchTender } from "./engine";
import { profileRulesSchema, type ProfileRulesInput } from "./rules";
import type { MatchCategory, MatchContext, MatchReason, MatchResult, MatchableTender, RuleKey } from "./types";

// Seeded categories (migration 0005).
const categories: MatchCategory[] = [
  { id: "giyim", cpvPrefixes: ["181", "3581", "351134"] },
  { id: "arac-parcalari", cpvPrefixes: ["343"] },
  { id: "shelter", cpvPrefixes: ["44211", "39522530"] },
  { id: "guc", cpvPrefixes: ["3112", "312", "313"] },
];
const now = new Date("2026-10-13T09:00:00Z");
const context: MatchContext = { categories, now };

const HOUR_MS = 60 * 60 * 1000;
const days = (n: number) => new Date(now.getTime() + n * 24 * HOUR_MS);

function tender(overrides: Partial<MatchableTender> = {}): MatchableTender {
  return {
    source: "uk_fat",
    noticeType: "tender",
    regime: "covered",
    status: "open",
    title: "Supply of diesel generating sets",
    description: "Supply and delivery of three 500 kVA diesel generating sets with acoustic enclosures.",
    buyerCountry: "GB",
    cpvMain: "31121000",
    cpvAdditional: [],
    valueEur: 120_000,
    submissionDeadline: days(20),
    noticeLanguage: "EN",
    lots: [],
    ...overrides,
  };
}

/** Rules through the real schema, so defaults (noticeTypes ["tender"], includeUnknownValue) apply. */
const rules = (input: ProfileRulesInput = {}) => profileRulesSchema.parse(input);
const match = (t: MatchableTender, input: ProfileRulesInput = {}) => matchTender(t, rules(input), context);
const rejectedBy = (rule: RuleKey): MatchResult => ({ matched: false, rejectedBy: rule });

function reasonsOf(result: MatchResult): MatchReason[] {
  if (!result.matched) throw new Error(`expected a match, got rejectedBy ${result.rejectedBy}`);
  return result.reasons;
}
const ruleNames = (result: MatchResult) => reasonsOf(result).map((reason) => reason.rule);

/** A tender folded from a recorded Find a Tender release; value_eur comes from FX rates, so tests set it. */
function fromFixture(name: string, valueEur: number | null): MatchableTender {
  const notice = normalizeFatRelease(loadFixture("uk-fat", name));
  if (!notice) throw new Error(`${name} normalized to null`);
  const t = foldNotices([notice]);
  return {
    source: t.source,
    noticeType: t.noticeType,
    regime: t.regime,
    status: t.status,
    title: t.title,
    description: t.description,
    buyerCountry: t.buyerCountry,
    cpvMain: t.cpvMain,
    cpvAdditional: t.cpvAdditional,
    valueEur,
    submissionDeadline: t.submissionDeadline,
    noticeLanguage: t.noticeLanguage,
    lots: t.lots.map(({ title, description, cpv }) => ({ title, description, cpv })),
  };
}

describe("matchTender", () => {
  it("matches an open tender against an empty profile; only the default notice type adds a reason", () => {
    expect(match(tender())).toEqual({ matched: true, reasons: [{ rule: "noticeType", value: "tender" }] });
  });

  describe("status", () => {
    it("passes open tenders", () => {
      expect(match(tender({ status: "open" })).matched).toBe(true);
    });

    it.each(["closed", "awarded", "cancelled"] as const)("rejects %s tenders", (status) => {
      expect(match(tender({ status }))).toEqual(rejectedBy("status"));
    });
  });

  describe("source, notice type, regime, country and language", () => {
    it("add no filter and no reason when the list is empty", () => {
      const t = tender({ buyerCountry: null, noticeLanguage: null, regime: "unknown" });
      expect(ruleNames(match(t))).toEqual(["noticeType"]);
    });

    it("pass with the tender's value as the reason when it is listed", () => {
      const result = match(tender(), {
        sources: ["uk_fat"],
        noticeTypes: ["planning", "tender"],
        regimes: ["below_threshold", "covered"],
        countries: ["GB", "IE"],
        noticeLanguages: ["EN"],
      });
      expect(reasonsOf(result)).toEqual([
        { rule: "source", value: "uk_fat" },
        { rule: "noticeType", value: "tender" },
        { rule: "regime", value: "covered" },
        { rule: "country", value: "GB" },
        { rule: "language", value: "EN" },
      ]);
    });

    const notListed: [RuleKey, ProfileRulesInput, Partial<MatchableTender>][] = [
      ["source", { sources: ["eu_ted"] }, {}],
      ["noticeType", {}, { noticeType: "planning" }],
      ["regime", { regimes: ["below_threshold"] }, {}],
      ["country", { countries: ["IE", "NL"] }, {}],
      ["language", { noticeLanguages: ["DE"] }, {}],
    ];
    it.each(notListed)("reject when the %s is not listed", (rule, input, overrides) => {
      expect(match(tender(overrides), input)).toEqual(rejectedBy(rule));
    });

    const unknown: [RuleKey, ProfileRulesInput, Partial<MatchableTender>][] = [
      ["noticeType", {}, { noticeType: null }],
      ["regime", { regimes: ["covered"] }, { regime: "unknown" }],
      ["country", { countries: ["GB"] }, { buyerCountry: null }],
      ["language", { noticeLanguages: ["EN"] }, { noticeLanguage: null }],
    ];
    it.each(unknown)("reject an unknown %s when the list is set", (rule, input, overrides) => {
      expect(match(tender(overrides), input)).toEqual(rejectedBy(rule));
    });
  });

  describe("deadline", () => {
    it("rejects a tender whose deadline has passed, even without minDaysToDeadline", () => {
      expect(match(tender({ submissionDeadline: now }))).toEqual(rejectedBy("deadline"));
      expect(match(tender({ submissionDeadline: days(-1) }))).toEqual(rejectedBy("deadline"));
    });

    it("counts whole days left and passes at the minimum", () => {
      const t = tender({ submissionDeadline: new Date(days(10).getTime() + 23 * HOUR_MS) });
      expect(reasonsOf(match(t, { minDaysToDeadline: 10 }))).toContainEqual({ rule: "deadline", daysLeft: 10 });
      expect(match(t, { minDaysToDeadline: 11 })).toEqual(rejectedBy("deadline"));
    });

    it("passes an unknown deadline, with daysLeft null when a minimum is set", () => {
      const t = tender({ noticeType: "planning", submissionDeadline: null });
      expect(reasonsOf(match(t, { noticeTypes: ["planning"], minDaysToDeadline: 10 }))).toContainEqual({
        rule: "deadline",
        daysLeft: null,
      });
    });

    it("adds a reason only when minDaysToDeadline is set, 0 included", () => {
      expect(ruleNames(match(tender()))).not.toContain("deadline");
      expect(reasonsOf(match(tender(), { minDaysToDeadline: 0 }))).toContainEqual({ rule: "deadline", daysLeft: 20 });
    });
  });

  describe("value", () => {
    it("is inactive without bounds, even for an unknown value", () => {
      expect(ruleNames(match(tender({ valueEur: null }), { includeUnknownValue: false }))).not.toContain("value");
    });

    it("includes both bounds", () => {
      const range = { valueMinEur: 20_000, valueMaxEur: 500_000 };
      expect(reasonsOf(match(tender({ valueEur: 20_000 }), range))).toContainEqual({ rule: "value", valueEur: 20_000 });
      expect(reasonsOf(match(tender({ valueEur: 500_000 }), range))).toContainEqual({ rule: "value", valueEur: 500_000 });
    });

    it("rejects values outside the bounds", () => {
      expect(match(tender({ valueEur: 19_999.99 }), { valueMinEur: 20_000 })).toEqual(rejectedBy("value"));
      expect(match(tender({ valueEur: 500_000.01 }), { valueMaxEur: 500_000 })).toEqual(rejectedBy("value"));
    });

    it("lets includeUnknownValue decide for an unknown value", () => {
      const t = tender({ valueEur: null });
      expect(reasonsOf(match(t, { valueMinEur: 20_000 }))).toContainEqual({ rule: "value", valueEur: null });
      expect(match(t, { valueMinEur: 20_000, includeUnknownValue: false })).toEqual(rejectedBy("value"));
    });

    it("treats a bound of 0 as set", () => {
      expect(match(tender({ valueEur: null }), { valueMinEur: 0, includeUnknownValue: false })).toEqual(
        rejectedBy("value"),
      );
    });
  });

  describe("keywordsNone", () => {
    it("rejects when an excluded keyword appears in any text, lots included", () => {
      const t = tender({ lots: [{ title: "Lot 2: Generator hire", description: null, cpv: [] }] });
      expect(match(t, { keywordsNone: ["hire"] })).toEqual(rejectedBy("keywordsNone"));
    });

    it("does not reject on a word that only contains the keyword", () => {
      const t = tender({ title: "Hampshire County Council: supply of standby generators" });
      expect(match(t, { keywordsNone: ["hire"] }).matched).toBe(true);
    });
  });

  describe("topic", () => {
    it("passes on a CPV prefix from cpvInclude", () => {
      expect(reasonsOf(match(tender(), { cpvInclude: ["3112"] }))).toContainEqual({
        rule: "cpv",
        codes: ["31121000"],
        prefixes: ["3112"],
      });
    });

    it("adds the prefixes of selected categories and ignores unknown category ids", () => {
      expect(reasonsOf(match(tender(), { categoryIds: ["missing", "guc"] }))).toContainEqual({
        rule: "cpv",
        codes: ["31121000"],
        prefixes: ["3112"],
      });
    });

    it("checks main, additional and lot CPVs; codes in tender order, prefixes in rule order", () => {
      const t = tender({
        cpvMain: "31200000",
        cpvAdditional: ["31121000", "31200000", "09310000"],
        lots: [{ title: null, description: null, cpv: ["31300000", "31121000"] }],
      });
      expect(reasonsOf(match(t, { cpvInclude: ["313", "3112", "312"] }))).toContainEqual({
        rule: "cpv",
        codes: ["31200000", "31121000", "31300000"],
        prefixes: ["313", "3112", "312"],
      });
    });

    it("passes on a keyword alone when no CPV matches", () => {
      const t = tender({ title: "Supply of armoured cables", description: null, cpvMain: "45310000" });
      expect(reasonsOf(match(t, { cpvInclude: ["313"], keywordsAny: ["genset", "cable"] }))).toEqual([
        { rule: "noticeType", value: "tender" },
        { rule: "keywordsAny", hits: ["cable"] },
      ]);
    });

    it("gives both reasons when a CPV and a keyword match", () => {
      const reasons = reasonsOf(match(tender(), { cpvInclude: ["3112"], keywordsAny: ["generating set"] }));
      expect(reasons.slice(-2)).toEqual([
        { rule: "cpv", codes: ["31121000"], prefixes: ["3112"] },
        { rule: "keywordsAny", hits: ["generating set"] },
      ]);
    });

    it("rejects when neither a CPV prefix nor a keyword matches", () => {
      const t = tender({ title: "Catering services", description: null, cpvMain: "55520000" });
      expect(match(t, { cpvInclude: ["3112"], keywordsAny: ["generator"] })).toEqual(rejectedBy("topic"));
    });

    it("leaves excluded codes out of the CPV check", () => {
      const spareParts = tender({ title: "Spare parts", description: null });
      expect(match(spareParts, { cpvInclude: ["311"], cpvExclude: ["31121"] })).toEqual(rejectedBy("topic"));

      const result = match(tender(), { cpvInclude: ["311"], cpvExclude: ["31121"], keywordsAny: ["generating set"] });
      expect(ruleNames(result)).not.toContain("cpv");
      expect(reasonsOf(result)).toContainEqual({ rule: "keywordsAny", hits: ["generating set"] });
    });

    describe("without include prefixes or keywordsAny", () => {
      it("rejects a tender whose codes are all excluded", () => {
        const t = tender({ lots: [{ title: null, description: null, cpv: ["31121100"] }] });
        expect(match(t, { cpvExclude: ["3112"] })).toEqual(rejectedBy("topic"));
      });

      it("passes without a reason when a code is not excluded or the tender has no codes", () => {
        expect(ruleNames(match(tender({ cpvAdditional: ["31321000"] }), { cpvExclude: ["3112"] }))).toEqual([
          "noticeType",
        ]);
        expect(ruleNames(match(tender({ cpvMain: null }), { cpvExclude: ["3112"] }))).toEqual(["noticeType"]);
      });

      it("passes without a reason when only unknown categories are selected", () => {
        expect(ruleNames(match(tender(), { categoryIds: ["missing"] }))).toEqual(["noticeType"]);
      });
    });
  });

  describe("keywordsAll", () => {
    it("passes when every keyword occurs, listing them as written", () => {
      expect(reasonsOf(match(tender(), { keywordsAll: ["Diesel", "acoustic enclosure"] }))).toContainEqual({
        rule: "keywordsAll",
        hits: ["Diesel", "acoustic enclosure"],
      });
    });

    it("rejects when one keyword is missing", () => {
      expect(match(tender(), { keywordsAll: ["diesel", "solar"] })).toEqual(rejectedBy("keywordsAll"));
    });
  });

  it("reports the first rule that rejects and lists reasons in rule order", () => {
    const strict: ProfileRulesInput = {
      sources: ["eu_ted"],
      noticeTypes: ["planning"],
      regimes: ["below_threshold"],
      countries: ["IE"],
      noticeLanguages: ["EN"],
      minDaysToDeadline: 30,
      valueMaxEur: 50_000,
      keywordsNone: ["diesel"],
      cpvInclude: ["44211"],
      keywordsAny: ["photovoltaic"],
      keywordsAll: ["solar"],
    };
    const steps: [Partial<MatchableTender>, RuleKey][] = [
      [{ status: "cancelled", noticeLanguage: "DE" }, "status"],
      [{ status: "open" }, "source"],
      [{ source: "eu_ted" }, "noticeType"],
      [{ noticeType: "planning" }, "regime"],
      [{ regime: "below_threshold" }, "country"],
      [{ buyerCountry: "IE" }, "language"],
      [{ noticeLanguage: "EN" }, "deadline"],
      [{ submissionDeadline: days(40) }, "value"],
      [{ valueEur: 40_000 }, "keywordsNone"],
      [{ title: "Supply of generating sets", description: null }, "topic"],
      [{ cpvMain: "44211100" }, "keywordsAll"],
    ];
    let t = tender();
    for (const [overrides, rule] of steps) {
      t = { ...t, ...overrides };
      expect(match(t, strict), `after ${JSON.stringify(overrides)}`).toEqual(rejectedBy(rule));
    }

    t = { ...t, title: "Supply of solar photovoltaic generating sets" };
    expect(ruleNames(match(t, strict))).toEqual([
      "source",
      "noticeType",
      "regime",
      "country",
      "language",
      "deadline",
      "value",
      "cpv",
      "keywordsAny",
      "keywordsAll",
    ]);
  });
});

describe("SPEC section 6 example profile", () => {
  const power = rules({
    description: "Jeneratör seti, güç dağıtım ekipmanı ve kablo tedariki. Kurulum veya kiralama hizmeti istemiyoruz.",
    sources: ["uk_fat", "eu_ted"],
    noticeTypes: ["tender", "planning"],
    categoryIds: ["guc"],
    cpvInclude: ["3112", "312", "313"],
    cpvExclude: [],
    keywordsAny: ["generator", "generating set", "genset", "power distribution", "cable"],
    keywordsAll: [],
    keywordsNone: ["hire", "maintenance services"],
    countries: ["GB", "IE", "NL", "BE"],
    valueMinEur: 20000,
    valueMaxEur: 500000,
    includeUnknownValue: true,
    minDaysToDeadline: 10,
    regimes: ["below_threshold", "covered"],
    noticeLanguages: ["EN"],
    triageThreshold: 60,
    autoAnalyze: false,
    notify: true,
    analysisQuestions: [
      "Asgari ciro şartı var mı, varsa ne kadar?",
      "Ürün menşei ya da tedarikçinin yerleşik olduğu ülkeye kısıt var mı?",
      "Kurulum, bakım ya da yerinde servis yükümlülüğü var mı?",
    ],
  });

  it("matches an Irish generator and power distribution tender with every reason", () => {
    const t = tender({
      source: "eu_ted",
      buyerCountry: "IE",
      title: "Supply of standby diesel generating sets and LV power distribution boards",
      description:
        "Framework for the supply and delivery of generating sets, distribution boards and associated cables to regional hospitals.",
      cpvMain: "31121000",
      cpvAdditional: ["31200000"],
      lots: [
        { title: "Lot 1: Generating sets", description: null, cpv: ["31121000"] },
        { title: "Lot 2: Power distribution boards and cables", description: null, cpv: ["31200000", "31321000"] },
      ],
      valueEur: 240_000,
      submissionDeadline: days(25),
    });
    expect(matchTender(t, power, context)).toEqual({
      matched: true,
      reasons: [
        { rule: "source", value: "eu_ted" },
        { rule: "noticeType", value: "tender" },
        { rule: "regime", value: "covered" },
        { rule: "country", value: "IE" },
        { rule: "language", value: "EN" },
        { rule: "deadline", daysLeft: 25 },
        { rule: "value", valueEur: 240_000 },
        { rule: "cpv", codes: ["31121000", "31200000", "31321000"], prefixes: ["3112", "312", "313"] },
        { rule: "keywordsAny", hits: ["generating set", "power distribution", "cable"] },
      ],
    });
  });

  it("matches a planning notice whose deadline and value are not known yet", () => {
    const t = tender({ noticeType: "planning", submissionDeadline: null, valueEur: null });
    expect(reasonsOf(matchTender(t, power, context))).toEqual(
      expect.arrayContaining([
        { rule: "noticeType", value: "planning" },
        { rule: "deadline", daysLeft: null },
        { rule: "value", valueEur: null },
      ]),
    );
  });

  it("rejects hire and maintenance work even when the codes match", () => {
    const t = tender({ title: "Generator hire and maintenance services framework", description: null });
    expect(matchTender(t, power, context)).toEqual(rejectedBy("keywordsNone"));
  });

  it("does not mistake Hampshire for hire", () => {
    const t = tender({ title: "Hampshire County Council: supply of power cables", description: null, cpvMain: "31321000" });
    expect(matchTender(t, power, context).matched).toBe(true);
  });

  it("rejects a real medical devices tender on topic", () => {
    // Value left unknown so the range does not decide first.
    expect(matchTender(fromFixture("uk4-tender-covered-multilot", null), power, context)).toEqual(rejectedBy("topic"));
  });

  it("rejects a real defence tender on regime", () => {
    expect(matchTender(fromFixture("uk4-tender-defence", null), power, context)).toEqual(rejectedBy("regime"));
  });
});

describe("real Find a Tender notices", () => {
  it("matches the naval firefighting helmet tender to the clothing category", () => {
    const result = matchTender(
      fromFixture("uk4-tender-defence", 615_000),
      rules({ categoryIds: ["giyim"], countries: ["GB"], minDaysToDeadline: 10 }),
      context,
    );
    expect(reasonsOf(result)).toEqual([
      { rule: "noticeType", value: "tender" },
      { rule: "country", value: "GB" },
      { rule: "deadline", daysLeft: 24 },
      { rule: "cpv", codes: ["18143000", "35113400"], prefixes: ["181", "351134"] },
    ]);
  });

  it("rejects the same tender once its deadline has passed", () => {
    const afterDeadline: MatchContext = { categories, now: new Date("2026-11-07T00:00:00Z") };
    expect(matchTender(fromFixture("uk4-tender-defence", null), rules({ categoryIds: ["giyim"] }), afterDeadline)).toEqual(
      rejectedBy("deadline"),
    );
  });
});
