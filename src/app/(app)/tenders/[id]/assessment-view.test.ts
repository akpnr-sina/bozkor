import { describe, expect, it } from "vitest";
import { details, facts, lot } from "../../../../../tests/helpers/facts";
import { checkFactsQuotes, evidencedFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import { assessTender, type PolicyInput } from "@/policy/engine";
import type { NoticeDetails } from "@/sources/types";
import { allFacts, decidingFacts, factGroups, STRUCTURED_SOURCE, summaryChecks, type FactKey } from "./assessment-view";

const NOW = new Date("2026-10-15T09:00:00+03:00");
/** Eleven working days ahead: a partner could still be found. */
const LATER = new Date("2026-11-09T12:00:00Z");
/** Five working days ahead: too late for a partner or a permitted structure. */
const SOON = new Date("2026-10-22T12:00:00Z");

const SOURCES = {
  title: "Cafe furniture",
  description:
    "Contemporary external cafe furniture. Delivery only. Minimum 15 year guarantee. The supplier shall install the furniture on site. Maintenance visits on site for the contract term. Bidders must show three similar contracts. Orders are placed as needed.",
};

function setup(extracted: FactsOutput, options: { deadline?: Date; details?: NoticeDetails | null } = {}) {
  const quoteChecks = checkFactsQuotes(extracted, SOURCES);
  const stored = { facts: extracted, quoteChecks, sourcesHash: "h" };
  const input: PolicyInput = {
    tender: { valueEur: 14_000, submissionDeadline: options.deadline ?? LATER, buyerCountry: "GB", noticeLanguage: "EN", details: options.details ?? null },
    lots: [],
    facts: evidencedFacts(extracted, quoteChecks),
    now: NOW,
  };
  return { stored, input, assessment: assessTender(input) };
}

const furniture = (fields: Partial<FactsOutput> = {}) =>
  facts({
    lots: [lot({ productTr: "kafe mobilyası", category: "FURNITURE_STORAGE", categoryQuote: "Contemporary external cafe furniture", productNature: "STANDARD", natureQuote: "Contemporary external cafe furniture" })],
    installation: { value: "NONE", detail: "", quote: "Delivery only." },
    commissioningTraining: { value: "NO", detail: "", quote: "Delivery only." },
    localService: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
    warranty: { years: 15, detail: "", quote: "Minimum 15 year guarantee." },
    deliveryPattern: { value: "SINGLE", detail: "", quote: "Delivery only." },
    pastPerformance: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
    turnover: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
    ...fields,
  });

const keys = (set: Set<FactKey>) => [...set].sort();

describe("decidingFacts", () => {
  it("names no fact for a promising status", () => {
    const { stored, input, assessment } = setup(furniture());
    expect(assessment.status).toBe("NEEDS_SUPPLIER");
    expect(keys(decidingFacts(input, stored))).toEqual([]);
  });

  it("names each piece of on-site work a delivery-only rejection rests on, even when either alone would reject", () => {
    const { stored, input, assessment } = setup(
      furniture({
        installation: { value: "REQUIRED", detail: "", quote: "The supplier shall install the furniture on site.", lots: [] },
        localService: { value: "REQUIRED", detail: "", quote: "Maintenance visits on site for the contract term.", lots: [] },
      }),
    );
    expect(assessment.status).toBe("COMMERCIAL_NO_BID");
    expect(keys(decidingFacts(input, stored))).toEqual(["installation", "localService"]);
  });

  it("names the reference requirement a no-bid rests on, not what only moves the score", () => {
    const { stored, input, assessment } = setup(furniture({ pastPerformance: { value: "REQUIRED", detail: "üç benzer iş", quote: "Bidders must show three similar contracts." } }), {
      deadline: SOON,
    });
    expect(assessment.status).toBe("NO_BID");
    expect(keys(decidingFacts(input, stored))).toEqual(["pastPerformance"]);
  });

  it("names the structured duration and the order pattern small repeated orders rest on", () => {
    const { stored, input, assessment } = setup(furniture({ deliveryPattern: { value: "REPEATED", detail: "", quote: "Orders are placed as needed." } }), {
      details: details({ durationMonths: 48 }),
    });
    expect(assessment.status).toBe("COMMERCIAL_NO_BID");
    expect(keys(decidingFacts(input, stored))).toEqual(["contractDuration", "deliveryPattern"]);
  });

  it("names the product of a services lot, which is out of scope", () => {
    const services = furniture();
    services.lots = [{ ...services.lots[0]!, objectType: "SERVICES" }];
    const { stored, input, assessment } = setup(services);
    expect(assessment.status).toBe("HARD_REJECT");
    expect(keys(decidingFacts(input, stored))).toEqual(["lot:0:product"]);
  });

  it("never names a fact whose quote was not found", () => {
    const { stored, input, assessment } = setup(furniture({ installation: { value: "REQUIRED", detail: "", quote: "Installation by the supplier.", lots: [] } }));
    expect(assessment.status).not.toBe("COMMERCIAL_NO_BID");
    expect(decidingFacts(input, stored).has("installation")).toBe(false);
  });
});

describe("factGroups", () => {
  it("groups the facts as the deep analysis does, with their tones", () => {
    const { stored } = setup(furniture({ samples: { value: "YES", quote: "Samples within 5 days." } }));
    const groups = factGroups(stored, null, [], new Set<FactKey>(["warranty"]));
    expect(groups.map((g) => g.title)).toEqual(["Ürün ve miktar", "Hizmet kapsamı", "Teslimat", "Ticari şartlar", "Yeterlilik"]);
    const byKey = new Map(allFacts(groups).map((f) => [f.key, f]));
    expect(byKey.get("warranty")).toMatchObject({ value: "15 yıl", tone: "err", source: "açıklama", quoted: true });
    // Unknown: amber, nothing to quote.
    expect(byKey.get("brand")).toMatchObject({ value: "Bilinmiyor", tone: "warn", quoted: false });
    // Stated without a quote found: grey, with the badge.
    expect(byKey.get("samples")).toMatchObject({ value: "Evet", tone: "muted", source: null, unverifiedBadge: true });
    // A lot's product needs no badge: the policy uses it whether or not its quote was found.
    expect(byKey.get("lot:0:product")).toMatchObject({ label: "Ürün", unverifiedBadge: false, tone: null });
  });

  it("shows a value from the notice's structured fields with that source and no quote", () => {
    const { stored } = setup(furniture());
    const groups = factGroups(stored, details({ durationMonths: 24, framework: true }), [], new Set());
    const byKey = new Map(allFacts(groups).map((f) => [f.key, f]));
    expect(byKey.get("contractDuration")).toMatchObject({ value: "24 ay", source: STRUCTURED_SOURCE, quoted: false, tone: null });
    expect(byKey.get("framework")).toMatchObject({ value: "Evet", source: STRUCTURED_SOURCE, quoted: false });
  });

  it("names the lot of an obligation and of a lot's nature when there are several lots", () => {
    const extracted = furniture({ installation: { value: "REQUIRED", detail: "", quote: "The supplier shall install the furniture on site.", lots: ["LOT-0002"] } });
    extracted.lots = [
      { ...extracted.lots[0]!, lotNumber: "LOT-0001" },
      { ...extracted.lots[0]!, lotNumber: "LOT-0002", productTr: "kafe masaları" },
    ];
    const { stored } = setup(extracted);
    const groups = factGroups(stored, null, [], new Set());
    const byKey = new Map(allFacts(groups).map((f) => [f.key, f]));
    expect(byKey.get("installation")?.value).toBe("Lot 2: Zorunlu");
    expect(byKey.get("lot:1:product")).toMatchObject({ label: "Lot 2", value: "kafe masaları" });
    expect(byKey.get("lot:1:nature")?.scope).toBe("Lot 2");
  });
});

describe("summaryChecks", () => {
  it("lists the deciding facts, then the failing gates, then the hard gates, five at most", () => {
    const { stored, input, assessment } = setup(
      furniture({ installation: { value: "REQUIRED", detail: "sahada", quote: "The supplier shall install the furniture on site.", lots: [] } }),
    );
    const all = allFacts(factGroups(stored, null, [], decidingFacts(input, stored)));
    const checks = summaryChecks(assessment.best, all);
    expect(checks).toHaveLength(5);
    expect(checks[0]).toEqual({ id: "installation", label: "Kurulum: Zorunlu", state: "failed", note: "sahada" });
    const failing = assessment.best.gates.filter((g) => g.state === "FAIL").map((g) => g.id);
    expect(checks.slice(1, 1 + failing.length).map((c) => c.id)).toEqual(failing.slice(0, 4));
    expect(checks.every((c, i) => i < 1 + failing.length || c.id.startsWith("H"))).toBe(true);
  });

  it("names a lot's nature with its lot", () => {
    const fact = { key: "lot:1:nature" as const, scope: "Lot 2", label: "Nitelik", value: "Standart ürün", detail: "", quote: "", source: null, quoted: true, unverifiedBadge: true, tone: "err" as const };
    expect(summaryChecks({ gates: [] }, [fact])[0]?.label).toBe("Lot 2 · Nitelik: Standart ürün");
  });
});
