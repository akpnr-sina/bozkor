import { readFactsOutput, type FactsOutput } from "./facts-schema";
import { findQuote } from "./quotes";
import type { QuoteSources } from "./types";

// Rule 5 for facts: each quote is looked up in the texts the model read when
// the answer comes in, and the result is stored with it. A fact whose quote is
// not found is shown as unverified and does not drive a decision: the policy
// engine sees it as unknown (qualification policy part X: no unsupported
// assumption becomes a confirmed fact).

/** Tender-level facts with one value and one quote. */
export const QUOTED_FACTS = [
  "installation",
  "commissioningTraining",
  "localService",
  "warranty",
  "deliveryPattern",
  "deliveryPoints",
  "contractDuration",
  "framework",
  "brand",
  "pastPerformance",
  "turnover",
  "samples",
  "siteVisit",
  "restrictedProduct",
  "awardCriteria",
] as const;
export type QuotedFact = (typeof QUOTED_FACTS)[number];

/** Source key where each quote was found in the text the model saw; null when it was not. */
export type FactsQuoteChecks = {
  facts: Record<QuotedFact, string | null>;
  certifications: (string | null)[];
  lots: { category: string | null; nature: string | null; quantity: string | null }[];
};

export function checkFactsQuotes(output: FactsOutput, sources: QuoteSources): FactsQuoteChecks {
  return {
    facts: Object.fromEntries(QUOTED_FACTS.map((key) => [key, findQuote(output[key].quote, sources)])) as Record<QuotedFact, string | null>,
    certifications: output.certifications.map((c) => findQuote(c.quote, sources)),
    lots: output.lots.map((lot) => ({
      category: findQuote(lot.categoryQuote, sources),
      nature: findQuote(lot.natureQuote, sources),
      quantity: findQuote(lot.quantity.quote, sources),
    })),
  };
}

/**
 * A facts analysis' output: the model's answer plus what was checked when it
 * came in, and the tender's updated_at when its notice was read (ISO).
 */
export type StoredFacts = FactsOutput & { quoteChecks: FactsQuoteChecks; sourcesHash: string; inputUpdatedAt: string };

export type ReadFacts = { facts: FactsOutput; quoteChecks: FactsQuoteChecks | null; sourcesHash: string | null };

/** The answer and its checks; checks are null when missing or not matching the answer. */
export function readStoredFacts(output: unknown): ReadFacts | null {
  const facts = readFactsOutput(output);
  if (!facts) return null;
  const stored = output as { quoteChecks?: Partial<Record<keyof FactsQuoteChecks, unknown>>; sourcesHash?: unknown };
  const checks = stored.quoteChecks;
  const fits =
    !!checks &&
    typeof checks.facts === "object" &&
    checks.facts !== null &&
    Array.isArray(checks.certifications) &&
    checks.certifications.length === facts.certifications.length &&
    Array.isArray(checks.lots) &&
    checks.lots.length === facts.lots.length;
  return {
    facts,
    quoteChecks: fits ? (checks as FactsQuoteChecks) : null,
    sourcesHash: typeof stored.sourcesHash === "string" ? stored.sourcesHash : null,
  };
}

function evidenced<T extends { value: string }>(fact: T, found: boolean): T {
  return fact.value === "UNKNOWN" || found ? fact : ({ ...fact, value: "UNKNOWN" } as T);
}

/**
 * The facts the policy engine may act on: a stated value whose quote was not
 * found becomes unknown and a certificate without one is left out. Duration,
 * framework and typed award criteria the notice also gives as structured
 * details reach the engine from tenders.details instead. Without checks
 * nothing counts as evidenced.
 */
export function evidencedFacts(facts: FactsOutput, checks: FactsQuoteChecks | null): FactsOutput {
  const found = (key: QuotedFact) => !!checks?.facts[key];
  return {
    ...facts,
    lots: facts.lots.map((lot, i) => {
      const lotChecks = checks?.lots[i];
      return {
        ...lot,
        productNature: lot.productNature === "UNKNOWN" || lotChecks?.nature ? lot.productNature : "UNKNOWN",
        objectType: lot.objectType === "UNKNOWN" || lotChecks?.category ? lot.objectType : "UNKNOWN",
        quantity: lot.quantity.kind === "UNKNOWN" || lotChecks?.quantity ? lot.quantity : { ...lot.quantity, kind: "UNKNOWN" },
      };
    }),
    installation: evidenced(facts.installation, found("installation")),
    commissioningTraining: evidenced(facts.commissioningTraining, found("commissioningTraining")),
    localService: evidenced(facts.localService, found("localService")),
    warranty: facts.warranty.years === null || found("warranty") ? facts.warranty : { ...facts.warranty, years: null },
    deliveryPattern: evidenced(facts.deliveryPattern, found("deliveryPattern")),
    deliveryPoints: evidenced(facts.deliveryPoints, found("deliveryPoints")),
    contractDuration:
      facts.contractDuration.months === null || found("contractDuration") ? facts.contractDuration : { ...facts.contractDuration, months: null },
    framework: evidenced(facts.framework, found("framework")),
    brand: evidenced(facts.brand, found("brand")),
    certifications: facts.certifications.filter((_, i) => !!checks?.certifications[i]),
    pastPerformance: evidenced(facts.pastPerformance, found("pastPerformance")),
    turnover: evidenced(facts.turnover, found("turnover")),
    samples: evidenced(facts.samples, found("samples")),
    siteVisit: evidenced(facts.siteVisit, found("siteVisit")),
    restrictedProduct: evidenced(facts.restrictedProduct, found("restrictedProduct")),
    awardCriteria: evidenced(facts.awardCriteria, found("awardCriteria")),
  };
}
