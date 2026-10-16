import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { facts, lot } from "../../../../../tests/helpers/facts";
import type { Analysis } from "@/db/schema";
import { checkFactsQuotes, evidencedFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import { assessTender } from "@/policy/engine";
import { AssessmentCard } from "./assessment-card";

// The card is a server component without data access: render it to HTML and
// check what the team reads.

const REVIEWED = new Date("2026-10-15T09:00:00+03:00");
const sources = {
  title: "High Quality Cafe Furniture",
  description: "High quality contemporary external cafe furniture comprising chairs and matching tables. Delivery only. Minimum 15 year guarantee.",
};

function render(extracted: FactsOutput, lots: { lotNumber: string; valueEur: number | null }[] = []) {
  const quoteChecks = checkFactsQuotes(extracted, sources);
  const evidenced = evidencedFacts(extracted, quoteChecks);
  const assessment = assessTender({
    tender: { valueEur: 14_000, submissionDeadline: new Date("2026-11-09T12:00:00Z"), buyerCountry: "GB", noticeLanguage: "EN", details: null },
    lots,
    facts: evidenced,
    now: REVIEWED,
  });
  return renderToStaticMarkup(
    createElement(AssessmentCard, {
      result: { assessment, latest: { analysisId: "a1", createdAt: REVIEWED, stored: { facts: extracted, quoteChecks, sourcesHash: "h" }, facts: evidenced } },
      latestAttempt: null,
      stale: false,
      details: null,
      tenderId: "t1",
    }),
  );
}

const furniture = facts({
  summaryTr: "Kafe sandalyeleri ve masaları.",
  lots: [
    lot({
      productTr: "dış mekân kafe mobilyası",
      category: "FURNITURE_STORAGE",
      categoryQuote: "contemporary external cafe furniture",
      productNature: "STANDARD",
      natureQuote: "contemporary external cafe furniture",
      quantity: { text: "20 sandalye, 5 masa", kind: "FIXED", quote: "comprising chairs and matching tables" },
    }),
  ],
  installation: { value: "NONE", detail: "Yalnızca teslim", quote: "Delivery only." },
  commissioningTraining: { value: "NO", detail: "", quote: "Delivery only." },
  localService: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
  warranty: { years: 15, detail: "En az 15 yıl", quote: "Minimum 15 year guarantee." },
  deliveryPattern: { value: "SINGLE", detail: "", quote: "Delivery only." },
  pastPerformance: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
  turnover: { value: "NOT_REQUIRED", detail: "", quote: "Delivery only." },
  // Not in the notice: shown as unverified and left out of the decision.
  samples: { value: "YES", quote: "Samples must be provided within 5 days." },
});

describe("AssessmentCard", () => {
  it("shows the verdict, the scores, the next actions and the facts with their sources", () => {
    const html = render(furniture);
    expect(html).toContain("Üretici bulunmalı");
    expect(html).toContain("İstenen 15 yıllık garantiyi üretici yazılı olarak üstlenmeli");
    expect(html).toContain("Fırsat uyumu");
    expect(html).toContain("Sonraki adımlar");
    expect(html).toContain("Üreticiden 15 yıllık garanti ve yedek parça taahhüdünü yazılı al.");
    expect(html).toContain("kaynak: açıklama");
    expect(html).toContain("doğrulanmadı, kararda kullanılmadı");
    expect(html).toContain("Kapılar");
    expect(html).not.toContain("\u2014");
  });

  it("adds a lot table for tenders with several lots", () => {
    const twoLots = facts({
      ...furniture,
      lots: [
        { ...furniture.lots[0]!, lotNumber: "LOT-0001" },
        { ...furniture.lots[0]!, lotNumber: "LOT-0002", productTr: "kafe masaları" },
      ],
    });
    const html = render(twoLots, [
      { lotNumber: "LOT-0001", valueEur: 9_000 },
      { lotNumber: "LOT-0002", valueEur: 5_000 },
    ]);
    expect(html).toContain("Lot bazında");
    expect(html).toContain("En umut verici lot: Lot 1");
    expect(html).toContain("kafe masaları");
  });

  it("explains a failed extraction when there is no verdict yet", () => {
    const attempt = { id: "x", valid: false, output: null, error: "API hatası (529): overloaded", createdAt: REVIEWED } as Analysis;
    const html = renderToStaticMarkup(
      createElement(AssessmentCard, { result: null, latestAttempt: attempt, stale: false, details: null, tenderId: "t1" }),
    );
    expect(html).toContain("Olgu çıkarma başarısız");
    expect(html).toContain("AI servisi hata verdi");
    expect(html).toContain("pnpm facts --tender=t1");
  });
});
