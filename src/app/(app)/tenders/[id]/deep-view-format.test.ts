import { describe, expect, it } from "vitest";
import { deepOutputSchema, type DeepClaim, type DeepOutput } from "@/analysis/deep-schema";
import type { DeepResult, DeepView } from "@/analysis/deep-view";
import { DECISION_LABELS, formatDateTime } from "@/lib/format";
import {
  answerRows,
  budgetNote,
  claimRows,
  deepFooter,
  deepStatus,
  evaluationRows,
  formatUsd,
  itemRows,
  missingRows,
  NOT_IN_DOCUMENTS,
  olderResultNote,
  riskRows,
  skippedRows,
  sourceLabel,
  sourceTag,
  STALE_NOTE,
  suggestion,
  UNVERIFIED,
} from "./deep-view-format";

const ANALYSED = new Date("2026-10-19T11:05:00Z");
const none: DeepClaim = { value: "", quote: "", file: 0, page: 0 };
const claim = (value: string, quote = "", file = 0, page = 0): DeepClaim => ({ value, quote, file, page });

/** An output with every field empty, then the given ones; checked against the schema the analysis writes. */
function output(fields: Partial<DeepOutput> = {}): DeepOutput {
  return deepOutputSchema.parse({
    summaryTr: "",
    items: [],
    delivery: { location: none, country: none, incoterm: none, leadTime: none, schedule: none },
    eligibility: {
      supplierLocation: none,
      productOrigin: none,
      minTurnover: none,
      references: none,
      qualityCerts: [],
      insurance: [],
      securityRequirements: none,
      localPresence: none,
    },
    commercial: { contractType: none, duration: none, pricingBasis: none, paymentTerms: none, bonds: none, penalties: none, warranty: none },
    servicesScope: { installation: none, maintenance: none, training: none },
    evaluation: [],
    timeline: { clarificationDeadline: none, submissionDeadline: none, siteVisit: none },
    redFlags: [],
    profileAnswers: [],
    missingInfo: [],
    suggestedDecision: { decision: "REVIEW", reasons: ["İncelenmeli."] },
    ...fields,
  });
}

const FILES: DeepResult["files"] = [
  { n: 1, documentId: "d1", name: "Leidraad.docx" },
  { n: 2, documentId: "d2", name: "Bestek.pdf" },
];

function result(out: DeepOutput, quoteChecks: Record<string, string | null> = {}, fields: Partial<DeepResult> = {}): DeepResult {
  return {
    output: out,
    quoteChecks,
    parts: 1,
    skipped: [],
    inputUpdatedAt: ANALYSED.toISOString(),
    analysisId: "a1",
    createdAt: ANALYSED,
    model: "claude-sonnet-5-5",
    costUsd: 0.4213,
    files: FILES,
    stale: false,
    ...fields,
  };
}

const request = (fields: Partial<NonNullable<DeepView["request"]>>): NonNullable<DeepView["request"]> => ({
  status: "queued",
  requestedBy: "ekip@bozkor.com",
  requestedAt: new Date("2026-10-19T10:00:00Z"),
  startedAt: null,
  finishedAt: null,
  error: null,
  ...fields,
});

describe("sources", () => {
  it("names a file and its page, a file, and the notice", () => {
    expect(sourceLabel("file:2:p12", FILES)).toBe("Bestek.pdf, sayfa 12");
    expect(sourceLabel("file:1", FILES)).toBe("Leidraad.docx");
    expect(sourceLabel("file:9:p3", FILES)).toBe("dosya 9, sayfa 3");
    expect(sourceLabel("notice:description", FILES)).toBe("ilan metni");
    expect(sourceLabel("notice:lot:LOT-0001:title", FILES)).toBe("ilan metni");
  });

  it("marks a quote not found, a quote not checked and a claim without a quote unverified", () => {
    const read = { quoteChecks: { "eligibility.minTurnover": "file:2:p4", "eligibility.productOrigin": null }, files: FILES };
    expect(sourceTag(read, "eligibility.minTurnover", " minimum turnover of EUR 500,000 ")).toEqual({
      verified: true,
      label: "Bestek.pdf, sayfa 4",
      quote: "minimum turnover of EUR 500,000",
    });
    expect(sourceTag(read, "eligibility.productOrigin", "EU origin only")).toMatchObject({ verified: false, label: UNVERIFIED, quote: "EU origin only" });
    expect(sourceTag(read, "eligibility.references", "three references")).toMatchObject({ verified: false, label: UNVERIFIED });
    const bare = sourceTag(read, "eligibility.minTurnover", "  ");
    expect(bare).toMatchObject({ verified: false, label: UNVERIFIED, quote: "" });
    expect(bare.verified ? "" : bare.why).toContain("alıntı vermedi");
  });
});

describe("claim rows", () => {
  it("leaves empty fields out, except turnover, origin, the supplier's location and the deadline", () => {
    const read = result(output(), {});
    expect(claimRows(read, "delivery")).toEqual([]);
    expect(claimRows(read, "servicesScope")).toEqual([]);
    expect(claimRows(read, "eligibility").map((r) => [r.label, r.value, r.empty, r.source])).toEqual([
      ["Asgari ciro", NOT_IN_DOCUMENTS, true, null],
      ["Ürün menşei", NOT_IN_DOCUMENTS, true, null],
      ["Tedarikçinin yeri", NOT_IN_DOCUMENTS, true, null],
    ]);
    expect(claimRows(read, "timeline").map((r) => [r.path, r.value])).toEqual([["timeline.submissionDeadline", NOT_IN_DOCUMENTS]]);
  });

  it("gives each claim its source, list items each their own path", () => {
    const out = output({
      eligibility: {
        ...output().eligibility,
        minTurnover: claim(" 500.000 EUR, son 3 yıl ", "minimum annual turnover of EUR 500,000", 2, 4),
        qualityCerts: [claim("ISO 9001", "ISO 9001 certificate", 2, 5), claim(""), claim("ISO 14001", "ISO 14001")],
      },
    });
    const rows = claimRows(result(out, { "eligibility.minTurnover": "file:2:p4", "eligibility.qualityCerts.0": "file:2:p5", "eligibility.qualityCerts.2": null }), "eligibility");
    expect(rows.map((r) => [r.path, r.label, r.value, r.source?.label])).toEqual([
      ["eligibility.minTurnover", "Asgari ciro", "500.000 EUR, son 3 yıl", "Bestek.pdf, sayfa 4"],
      ["eligibility.productOrigin", "Ürün menşei", NOT_IN_DOCUMENTS, undefined],
      ["eligibility.supplierLocation", "Tedarikçinin yeri", NOT_IN_DOCUMENTS, undefined],
      ["eligibility.qualityCerts.0", "Kalite belgesi", "ISO 9001", "Bestek.pdf, sayfa 5"],
      ["eligibility.qualityCerts.2", "Kalite belgesi", "ISO 14001", UNVERIFIED],
    ]);
  });
});

describe("lists", () => {
  it("lays out items lot by lot, with quantity and unit together, empty ones left out", () => {
    const out = output({
      items: [
        { lot: "LOT-0002", description: " Dizel jeneratör ", quantity: "12", unit: "adet", specs: [" 400 kVA ", ""], standards: ["ISO 8528"], certifications: ["CE"], quote: "12 diesel generating sets", file: 2, page: 7 },
        { lot: "", description: "", quantity: "", unit: "", specs: [], standards: [], certifications: [], quote: "", file: 0, page: 0 },
        { lot: "", description: "Kablo", quantity: "", unit: "metre", specs: [], standards: [], certifications: [], quote: "", file: 0, page: 0 },
      ],
    });
    const rows = itemRows(result(out, { "items.0": "file:2:p7" }));
    expect(rows.map((r) => [r.path, r.lot, r.description, r.quantity, r.specs, r.source.label])).toEqual([
      ["items.0", "Lot 2", "Dizel jeneratör", "12 adet", ["400 kVA"], "Bestek.pdf, sayfa 7"],
      ["items.2", null, "Kablo", "metre", [], UNVERIFIED],
    ]);
  });

  it("puts the most severe risks first, keeping the model's order within a severity", () => {
    const flag = (issue: string, severity: "high" | "medium" | "low") => ({ issue, severity, quote: "", file: 0, page: 0 });
    const out = output({ redFlags: [flag("Kısa teslim", "low"), flag("Yerel servis", "high"), flag("", "high"), flag("Ceza", "medium"), flag("Teminat", "high")] });
    expect(riskRows(result(out)).map((r) => [r.path, r.severity])).toEqual([
      ["redFlags.1", "high"],
      ["redFlags.4", "high"],
      ["redFlags.3", "medium"],
      ["redFlags.0", "low"],
    ]);
  });

  it("gives an unanswered profile question no source, and weights as details", () => {
    const out = output({
      profileAnswers: [
        { question: "Asgari ciro şartı var mı?", answer: "Evet, 500.000 EUR.", quote: "EUR 500,000", file: 2, page: 4 },
        { question: "Kurulum yükümlülüğü var mı?", answer: "Dokümanlarda yok.", quote: "", file: 0, page: 0 },
      ],
      evaluation: [
        { criterion: "Fiyat", weight: "%60", quote: "Price 60%", file: 1, page: 0 },
        { criterion: "Kalite", weight: " ", quote: "", file: 0, page: 0 },
      ],
    });
    const read = result(out, { "profileAnswers.0": "file:2:p4", "evaluation.0": "file:1" });
    expect(answerRows(read).map((r) => [r.text, r.detail, r.source?.label ?? null])).toEqual([
      ["Asgari ciro şartı var mı?", "Evet, 500.000 EUR.", "Bestek.pdf, sayfa 4"],
      ["Kurulum yükümlülüğü var mı?", NOT_IN_DOCUMENTS, null],
    ]);
    expect(evaluationRows(read).map((r) => [r.text, r.detail, r.source?.label])).toEqual([
      ["Fiyat", "%60", "Leidraad.docx"],
      ["Kalite", null, UNVERIFIED],
    ]);
  });

  it("keeps missing information and the suggestion's reasons without blanks", () => {
    const out = output({ missingInfo: ["Teslim süresi", " "], suggestedDecision: { decision: "GO", reasons: ["Ürün uyuyor.", " "] } });
    expect(missingRows(result(out))).toEqual(["Teslim süresi"]);
    expect(suggestion(result(out))).toEqual({ label: DECISION_LABELS.GO, reasons: ["Ürün uyuyor."] });
  });
});

describe("states", () => {
  const view = (fields: Partial<DeepView>): DeepView => ({ state: "none", request: null, result: null, budget: { spentUsd: 0, budgetUsd: 100 }, ...fields });

  it("offers the analysis when none was asked for, with what it costs", () => {
    expect(deepStatus(view({}))).toMatchObject({ title: "Henüz analiz edilmedi", action: "Analiz et", waiting: false, error: null });
    expect(deepStatus(view({})).detail).toContain("0,3-2 USD");
  });

  it("waits, refreshing, while a request is queued or running", () => {
    const queued = deepStatus(view({ state: "queued", request: request({}) }));
    expect(queued).toMatchObject({ title: "Sırada", action: null, waiting: true });
    expect(queued.detail).toContain("ekip@bozkor.com");
    expect(queued.detail).toContain(formatDateTime(new Date("2026-10-19T10:00:00Z")));
    expect(deepStatus(view({ state: "queued", request: request({ requestedBy: null }) })).detail).toContain("Profilin otomatik analizi");
    const running = deepStatus(view({ state: "running", request: request({ status: "running", startedAt: new Date("2026-10-19T10:02:00Z") }) }));
    expect(running).toMatchObject({ title: "Analiz ediliyor", action: null, waiting: true });
    expect(running.detail).toContain(formatDateTime(new Date("2026-10-19T10:02:00Z")));
  });

  it("says why the last request failed, and offers to try again", () => {
    const error = "API hatası: 529 overloaded\nayrıntı";
    const failed = deepStatus(view({ state: "failed", request: request({ status: "failed", finishedAt: new Date("2026-10-19T10:09:00Z"), error }) }));
    expect(failed).toMatchObject({ title: "Son analiz başarısız", action: "Yeniden dene", waiting: false, error });
    expect(failed.detail).toBe(`${formatDateTime(new Date("2026-10-19T10:09:00Z"))}: API hatası: 529 overloaded`);
  });

  it("offers to analyse again once done", () => {
    expect(deepStatus(view({ state: "done", result: result(output()) }))).toMatchObject({ title: "Analiz edildi", action: "Yeniden analiz et", waiting: false });
  });

  it("warns beside the button once the month's budget is spent", () => {
    expect(budgetNote({ spentUsd: 99.99, budgetUsd: 100 })).toBeNull();
    expect(budgetNote({ spentUsd: 100, budgetUsd: 100 })).toBe("Aylık LLM bütçesi doldu; analiz yine çalışır ama maliyeti aşar.");
    expect(budgetNote({ spentUsd: 0, budgetUsd: 0 })).not.toBeNull();
  });
});

describe("footnotes", () => {
  it("gives the model, the cost, the time and the parts", () => {
    expect(deepFooter(result(output()))).toEqual(["Model: claude-sonnet-5-5", "Maliyet: 0,42 USD", formatDateTime(ANALYSED)]);
    expect(deepFooter(result(output(), {}, { parts: 3 }))).toContain("3 parçada okundu");
    expect(formatUsd(1.5)).toBe("1,50 USD");
    expect(formatUsd(0.001)).toBe("0,01 USD'den az");
    expect(formatUsd(0)).toBe("0,00 USD");
  });

  it("lists the files left out with why, and says when a result is old or stale", () => {
    expect(skippedRows(result(output(), {}, { skipped: [{ documentId: "d9", name: "Tekeningen.dwg", reason: "okunmayan biçim" }] }))).toEqual(["Tekeningen.dwg: okunmayan biçim"]);
    expect(olderResultNote(result(output()))).toBe(`Aşağıdaki sonuç önceki analizin (${formatDateTime(ANALYSED)}).`);
    expect(STALE_NOTE).toBe("Dokümanlar ya da ilan analizden sonra değişti; sonuç güncel olmayabilir.");
  });

  it("writes no em dash", () => {
    const texts = [
      STALE_NOTE,
      NOT_IN_DOCUMENTS,
      UNVERIFIED,
      budgetNote({ spentUsd: 1, budgetUsd: 1 }),
      ...(["none", "queued", "running", "failed", "done"] as const).flatMap((state) => {
        const s = deepStatus({ state, request: request({ status: state === "none" ? "queued" : state, error: "x" }), result: null });
        return [s.title, s.detail, s.action];
      }),
    ];
    for (const text of texts) expect(text ?? "").not.toContain(String.fromCharCode(0x2014));
  });
});
