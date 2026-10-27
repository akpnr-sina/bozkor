import { describe, expect, it } from "vitest";
import type { ProfileRules } from "@/matching/rules";
import type { MatchResult } from "@/matching/types";
import {
  countryName,
  deadlineWarning,
  documentsFigure,
  historyRows,
  matchRows,
  tabHref,
  tabOf,
  tenderFigures,
  timelineSteps,
  type FigureInput,
  type HistoryInput,
} from "./tender-view";

const NOW = new Date("2026-10-20T09:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const inDays = (days: number) => new Date(NOW.getTime() + days * 24 * HOUR_MS);

describe("tabs", () => {
  it("opens the tab the address asks for, and the overview for anything else", () => {
    expect(tabOf(undefined)).toBe("overview");
    expect(tabOf("deep")).toBe("deep");
    expect(tabOf(["documents", "history"])).toBe("documents");
    expect(tabOf("analysis")).toBe("overview");
    expect(tabHref("t1", "overview")).toBe("/tenders/t1");
    expect(tabHref("t1", "history")).toBe("/tenders/t1?tab=history");
  });
});

describe("deadlineWarning", () => {
  it("warns five days or fewer before the deadline, not after it", () => {
    expect(deadlineWarning(null, NOW)).toBeNull();
    expect(deadlineWarning(inDays(6), NOW)).toBeNull();
    expect(deadlineWarning(inDays(5.5), NOW)).toEqual({ days: 5, title: "Son teklife 5 gün kaldı" });
    expect(deadlineWarning(inDays(0.5), NOW)).toEqual({ days: 0, title: "Son teklife 1 günden az kaldı" });
    expect(deadlineWarning(inDays(-0.5), NOW)).toBeNull();
  });
});

const doc = (fields: Partial<{ analysisInput: boolean; fetchStatus: string; members: number; stored: boolean; processed: boolean }>) => ({
  analysisInput: false,
  fetchStatus: "fetched",
  members: 0,
  stored: true,
  processed: true,
  ...fields,
});

describe("documentsFigure", () => {
  it("counts the files the analysis reads, and says so when some links still lead to the portal", () => {
    expect(documentsFigure([doc({ analysisInput: true }), doc({ analysisInput: true })], null)).toEqual({ value: "2 dosya", note: "analize girecek" });
    expect(documentsFigure([doc({ analysisInput: true }), doc({ fetchStatus: "needs_manual", stored: false })], null)).toEqual({ value: "1 dosya", note: "1 link portalda" });
  });

  it("says when files are being read, are at the portal, or are missing", () => {
    expect(documentsFigure([doc({ processed: false })], null)).toEqual({ value: "Okunuyor", note: "1 dosya okunuyor" });
    expect(documentsFigure([], "https://portal.example")).toEqual({ value: "Portal", note: "dokümanlar alıcının portalında" });
    expect(documentsFigure([doc({ stored: false, fetchStatus: "failed" })], null)).toEqual({ value: "Yok", note: "1 link, dosya yok" });
    expect(documentsFigure([], null)).toEqual({ value: "Yok", note: null });
  });
});

const figures = (fields: Partial<FigureInput> = {}) =>
  tenderFigures(
    {
      valueAmount: 120_000,
      valueCurrency: "GBP",
      valueEur: 138_000,
      submissionDeadline: inDays(20),
      procedureType: "Açık usul",
      buyerCountry: "NL",
      nutsCode: "NL329",
      fit: { low: 60, high: 80 },
      documents: { value: "3 dosya", note: "analize girecek" },
      ...fields,
    },
    NOW,
  );

describe("tenderFigures", () => {
  it("gives the six figures in order, the value in EUR with the original under it", () => {
    const stats = figures();
    expect(stats.map((s) => s.label)).toEqual(["Değer", "Son teklif", "Usul", "Uyum", "Dokümanlar", "Ülke"]);
    expect(stats[0]).toMatchObject({ value: "€138.000", note: "£120.000" });
    expect(stats[3]).toMatchObject({ value: "70 / 100", note: "aralık 60-80" });
    expect(stats[5]).toMatchObject({ value: "Hollanda", note: "NL329 · NL" });
    expect(stats[1]?.tone).toBeUndefined();
  });

  it("colours a near deadline and says what is not known", () => {
    const stats = figures({ submissionDeadline: inDays(2.5), valueEur: null, valueAmount: null, fit: null, buyerCountry: null, nutsCode: null, procedureType: null });
    expect(stats[0]).toMatchObject({ value: "Belirtilmemiş" });
    expect(stats[1]).toMatchObject({ tone: "warn" });
    expect(stats[1]?.note).toMatch(/^2 gün · \d{2}:\d{2}$/);
    expect(stats[2]).toMatchObject({ value: "Belirtilmemiş" });
    expect(stats[3]).toMatchObject({ value: "Sırada", note: "henüz değerlendirilmedi" });
    expect(stats[5]).toMatchObject({ value: "Belirtilmemiş", note: undefined });
  });

  it("keeps a value without an EUR rate in its own currency", () => {
    expect(figures({ valueEur: null })[0]).toMatchObject({ value: "£120.000", note: "EUR karşılığı yok" });
    expect(figures({ fit: { low: 72, high: 72 } })[3]).toMatchObject({ value: "72 / 100", note: "kesin" });
  });
});

describe("countryName", () => {
  it("names a country in Turkish and keeps a code it does not know", () => {
    expect(countryName("de")).toBe("Almanya");
    expect(countryName("XQ")).toBe("XQ");
    expect(countryName(null)).toBeNull();
  });
});

describe("timelineSteps", () => {
  it("puts the known dates in order: those passed, the next one, those after it", () => {
    const steps = timelineSteps({ publishedAt: inDays(-10), clarificationDeadline: inDays(3), submissionDeadline: inDays(12) }, NOW);
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Yayın", "past"],
      ["Soru son günü", "next"],
      ["Son teklif", "later"],
    ]);
  });

  it("leaves out an unknown date and orders by date, not by kind", () => {
    const steps = timelineSteps({ publishedAt: null, clarificationDeadline: inDays(-1), submissionDeadline: inDays(-2) }, NOW);
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ["Son teklif", "past"],
      ["Soru son günü", "past"],
    ]);
  });
});

describe("matchRows", () => {
  const match = {
    profileId: "p1",
    profileName: "Güç",
    profileActive: true,
    reasons: [{ rule: "country", value: "IE" }, { rule: "bogus" }],
    unmatchedAt: null,
    rules: { countries: ["IE"] },
  };

  it("lists the rules that held, and for a profile that matches no more the rule that fails now", () => {
    const seen: ProfileRules[] = [];
    const evaluate = (rules: ProfileRules): MatchResult => {
      seen.push(rules);
      return { matched: false, rejectedBy: "country" };
    };
    const [current] = matchRows([match], evaluate);
    expect(current).toMatchObject({ name: "Güç", held: ["Ülke: IE"], failed: [] });
    expect(seen).toHaveLength(0);
    const [stale] = matchRows([{ ...match, unmatchedAt: NOW }], evaluate);
    expect(stale?.failed).toEqual(["Ülke uymuyor"]);
    expect(seen[0]?.countries).toEqual(["IE"]);
  });

  it("names no failing rule when the profile's rules cannot be read or match again", () => {
    const failing = (): MatchResult => ({ matched: false, rejectedBy: "country" });
    expect(matchRows([{ ...match, unmatchedAt: NOW, rules: { countries: "IE" } }], failing)[0]?.failed).toEqual([]);
    expect(matchRows([{ ...match, unmatchedAt: NOW }], () => ({ matched: true, reasons: [] }))[0]?.failed).toEqual([]);
  });
});

describe("historyRows", () => {
  const input: HistoryInput = {
    tender: { source: "eu_ted", publishedAt: inDays(-9), createdAt: inDays(-8), changedAt: inDays(-3) },
    reviews: [
      { decision: "WATCH", note: "Fiyatı izleyelim", decidedBy: "a@bozkor.com", decidedAt: inDays(-2) },
      { decision: null, note: null, decidedBy: "b@bozkor.com", decidedAt: inDays(-1) },
    ],
    analyses: [
      { kind: "facts", model: "claude-haiku-5-5", promptVersion: "facts.v5", costUsd: 0.0026, valid: true, error: null, createdAt: inDays(-7) },
      { kind: "deep", model: "claude-sonnet-5-5", promptVersion: "deep.v1", costUsd: 0.42, valid: false, error: "\nAPI hatası (529): overloaded\nayrıntı", createdAt: inDays(-0.5) },
    ],
    deepRequests: [
      { status: "failed", requestedBy: null, requestedAt: inDays(-0.6), finishedAt: inDays(-0.4), error: "Zaman aşımı" },
      { status: "queued", requestedBy: "a@bozkor.com", requestedAt: inDays(-0.1), finishedAt: null, error: null },
    ],
  };

  it("tells what happened, newest first, with who did it", () => {
    const rows = historyRows(input);
    expect(rows.map((r) => r.event)).toEqual([
      "Derin analiz istendi",
      "Derin analiz başarısız",
      "Derin analiz çağrısı (deep.v1)",
      "Derin analiz istendi",
      "Karar geri alındı",
      "Karar verildi (WATCH: izlenecek)",
      "İlan değişti",
      "Olgu çıkarma (facts.v5)",
      "Sisteme alındı",
      "İlan yayımlandı",
    ]);
    expect(rows.map((r) => r.at.getTime())).toEqual([...rows.map((r) => r.at.getTime())].sort((a, b) => b - a));
    expect(rows[0]?.who).toBe("a@bozkor.com");
    expect(rows[3]?.who).toBe("Profil (otomatik)");
    expect(rows.at(-1)?.who).toBe("TED (AB)");
  });

  it("shows a failed call's first error line and its cost, in the error tone", () => {
    const call = historyRows(input).find((r) => r.event.startsWith("Derin analiz çağrısı"));
    expect(call).toMatchObject({ tone: "err", who: "Sistem", detail: "claude-sonnet-5-5 · 0,42 USD · geçersiz: API hatası (529): overloaded" });
    const facts = historyRows(input).find((r) => r.event.startsWith("Olgu çıkarma"));
    expect(facts).toMatchObject({ tone: null, detail: "claude-haiku-5-5 · 0,01 USD'den az · geçerli" });
    expect(historyRows(input).find((r) => r.event === "Karar verildi (WATCH: izlenecek)")?.detail).toBe("Fiyatı izleyelim");
  });
});
