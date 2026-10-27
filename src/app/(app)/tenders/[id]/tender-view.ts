import type { Stat } from "@/components/stat-strip";
import type { BadgeVariant } from "@/components/ui/badge";
import type { ReviewDecision } from "@/lib/format";
import { DECISION_LABELS, daysLeft, formatDate, formatDaysLeft, formatMoney, SOURCE_LABELS, TIMEZONE } from "@/lib/format";
import { describeReason, parseReasons, REJECTION_LABELS } from "@/matching/describe";
import { profileRulesSchema, type ProfileRules } from "@/matching/rules";
import type { MatchResult } from "@/matching/types";
import { expectedScore, type Range } from "@/policy/engine";
import type { TenderStatus } from "@/sources/types";
import { formatUsd } from "./deep-view-format";

// What the tender page shows, worked out from its data (CLAUDE.md, "Arayüz";
// SPEC section 8): the tabs, the deadline warning, the key figures, the
// timeline, why each profile matches, and the page's history. Pure, so the
// components only lay it out.

export type TenderTab = "overview" | "deep" | "documents" | "history";

export const TABS: readonly { tab: TenderTab; label: string }[] = [
  { tab: "overview", label: "Genel bakış" },
  { tab: "deep", label: "Derin analiz" },
  { tab: "documents", label: "Dokümanlar" },
  { tab: "history", label: "Geçmiş" },
];

/** The tab `?tab=` asks for; anything else is the overview. */
export function tabOf(value: string | string[] | undefined): TenderTab {
  const asked = Array.isArray(value) ? value[0] : value;
  return TABS.find((t) => t.tab === asked)?.tab ?? "overview";
}

/** The tab's address: the overview is the page itself. */
export const tabHref = (tenderId: string, tab: TenderTab) => (tab === "overview" ? `/tenders/${tenderId}` : `/tenders/${tenderId}?tab=${tab}`);

/** A tender's status as a badge colour: open is good news, cancelled bad, awarded settled. */
export const STATUS_VARIANT: Record<TenderStatus, BadgeVariant> = { open: "ok", closed: "default", awarded: "info", cancelled: "err" };

const timeFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
/** The time of day in Istanbul: "12:00". */
export const formatTime = (date: Date) => timeFormat.format(date);

/** Five days or fewer to the deadline: the page warns. */
export const DEADLINE_WARNING_DAYS = 5;

/** The warning's title when the deadline is near, or null. */
export function deadlineWarning(deadline: Date | null, now: Date): { days: number; title: string } | null {
  const days = daysLeft(deadline, now);
  if (days === null || days < 0 || days > DEADLINE_WARNING_DAYS) return null;
  return { days, title: days === 0 ? "Son teklife 1 günden az kaldı" : `Son teklife ${days} gün kaldı` };
}

const regionNames = new Intl.DisplayNames(["tr"], { type: "region" });

/** "NL" as "Hollanda"; a code the runtime does not know stays as it is. */
export function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** What the page knows of a tender's documents: files the analysis reads, files being read, links to a portal. */
type DocumentFacts = { analysisInput: boolean; fetchStatus: string; members: number; stored: boolean; processed: boolean };

/** The documents figure: "N dosya" the analysis reads, "Okunuyor", "Portal", or "Yok". */
export function documentsFigure(docs: readonly DocumentFacts[], portalUrl: string | null): { value: string; note: string | null } {
  const inputs = docs.filter((d) => d.analysisInput).length;
  const atPortal = docs.filter((d) => d.fetchStatus === "needs_manual" && !d.members).length;
  const reading = docs.filter((d) => d.stored && !d.processed).length;
  if (inputs) return { value: `${inputs} dosya`, note: atPortal ? `${atPortal} link portalda` : "analize girecek" };
  if (reading) return { value: "Okunuyor", note: `${reading} dosya okunuyor` };
  if (atPortal || portalUrl) return { value: "Portal", note: "dokümanlar alıcının portalında" };
  return { value: "Yok", note: docs.length ? `${docs.length} link, dosya yok` : null };
}

export type FigureInput = {
  valueAmount: number | null;
  valueCurrency: string | null;
  valueEur: number | null;
  submissionDeadline: Date | null;
  procedureType: string | null;
  buyerCountry: string | null;
  nutsCode: string | null;
  /** The most promising lot's fit, or null before the assessment. */
  fit: Range | null;
  documents: { value: string; note: string | null };
};

/** The six figures under the title (StatStrip, size "md"). */
export function tenderFigures(t: FigureInput, now: Date): Stat[] {
  const days = daysLeft(t.submissionDeadline, now);
  const value =
    t.valueEur !== null
      ? { value: formatMoney(t.valueEur, "EUR"), note: t.valueAmount !== null && t.valueCurrency && t.valueCurrency !== "EUR" ? formatMoney(t.valueAmount, t.valueCurrency) : null }
      : t.valueAmount !== null
        ? { value: formatMoney(t.valueAmount, t.valueCurrency), note: "EUR karşılığı yok" }
        : { value: "Belirtilmemiş", note: null };
  const fit = t.fit
    ? { value: `${expectedScore(t.fit)} / 100`, note: t.fit.low === t.fit.high ? "kesin" : `aralık ${t.fit.low}-${t.fit.high}` }
    : { value: "Sırada", note: "henüz değerlendirilmedi" };
  const country = countryName(t.buyerCountry);
  return [
    { label: "Değer", value: value.value, note: value.note ?? undefined },
    {
      label: "Son teklif",
      value: t.submissionDeadline ? formatDate(t.submissionDeadline) : "Belirtilmemiş",
      note: t.submissionDeadline ? `${formatDaysLeft(days)} · ${formatTime(t.submissionDeadline)}` : undefined,
      tone: deadlineWarning(t.submissionDeadline, now) ? "warn" : undefined,
    },
    { label: "Usul", value: t.procedureType ?? "Belirtilmemiş" },
    { label: "Uyum", value: fit.value, note: fit.note },
    { label: "Dokümanlar", value: t.documents.value, note: t.documents.note ?? undefined },
    { label: "Ülke", value: country ?? "Belirtilmemiş", note: [t.nutsCode, country && t.buyerCountry !== country ? t.buyerCountry : null].filter(Boolean).join(" · ") || undefined },
  ];
}

export type TimelineStep = { label: string; at: Date; state: "past" | "next" | "later" };

/** The tender's dates that are known, in order: those passed, the next one, those after it. */
export function timelineSteps(t: { publishedAt: Date | null; clarificationDeadline: Date | null; submissionDeadline: Date | null }, now: Date): TimelineStep[] {
  const dates: { label: string; at: Date | null }[] = [
    { label: "Yayın", at: t.publishedAt },
    { label: "Soru son günü", at: t.clarificationDeadline },
    { label: "Son teklif", at: t.submissionDeadline },
  ];
  let nextGiven = false;
  return dates
    .filter((step): step is { label: string; at: Date } => step.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map(({ label, at }) => {
      if (at.getTime() <= now.getTime()) return { label, at, state: "past" };
      const state = nextGiven ? "later" : "next";
      nextGiven = true;
      return { label, at, state };
    });
}

export type MatchInput = {
  profileId: string;
  profileName: string;
  profileActive: boolean;
  reasons: unknown;
  unmatchedAt: Date | null;
  rules: unknown;
};

export type MatchRow = { profileId: string; name: string; active: boolean; unmatchedAt: Date | null; held: string[]; failed: string[] };

/**
 * Why each profile matches: the rules that held when it matched, and for a
 * profile that matches no more, the rule that fails now (`evaluate` applies
 * the profile's rules to the tender as it is).
 */
export function matchRows(matches: readonly MatchInput[], evaluate: (rules: ProfileRules) => MatchResult): MatchRow[] {
  return matches.map((m) => {
    let failed: string[] = [];
    if (m.unmatchedAt) {
      const rules = profileRulesSchema.safeParse(m.rules);
      const result = rules.success ? evaluate(rules.data) : null;
      if (result && !result.matched) failed = [REJECTION_LABELS[result.rejectedBy]];
    }
    return { profileId: m.profileId, name: m.profileName, active: m.profileActive, unmatchedAt: m.unmatchedAt, held: parseReasons(m.reasons).map(describeReason), failed };
  });
}

export type HistoryRow = { at: Date; event: string; detail: string | null; who: string; tone: BadgeVariant | null };

const KIND_LABELS: Record<string, string> = {
  facts: "Olgu çıkarma",
  deep: "Derin analiz çağrısı",
  translation: "Çeviri",
  triage: "Ön değerlendirme",
};

const firstLine = (text: string | null) => text?.split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? null;

export type HistoryInput = {
  tender: { source: string; publishedAt: Date | null; createdAt: Date; changedAt: Date | null };
  reviews: readonly { decision: ReviewDecision | null; note: string | null; decidedBy: string; decidedAt: Date }[];
  analyses: readonly { kind: string; model: string; promptVersion: string; costUsd: number; valid: boolean; error: string | null; createdAt: Date }[];
  deepRequests: readonly { status: string; requestedBy: string | null; requestedAt: Date; finishedAt: Date | null; error: string | null }[];
};

/** What happened to the tender, newest first: the notice, the team's decisions, the analyses and their requests. */
export function historyRows(input: HistoryInput): HistoryRow[] {
  const source = SOURCE_LABELS[input.tender.source as keyof typeof SOURCE_LABELS] ?? input.tender.source;
  const rows: HistoryRow[] = [];
  const { tender } = input;
  if (tender.publishedAt) rows.push({ at: tender.publishedAt, event: "İlan yayımlandı", detail: null, who: source, tone: null });
  rows.push({ at: tender.createdAt, event: "Sisteme alındı", detail: null, who: "Sistem", tone: null });
  if (tender.changedAt) rows.push({ at: tender.changedAt, event: "İlan değişti", detail: "Düzeltme ya da güncelleme ilanı geldi.", who: source, tone: "warn" });
  for (const review of input.reviews) {
    rows.push({
      at: review.decidedAt,
      event: review.decision ? `Karar verildi (${DECISION_LABELS[review.decision]})` : "Karar geri alındı",
      detail: review.note,
      who: review.decidedBy,
      tone: null,
    });
  }
  for (const a of input.analyses) {
    rows.push({
      at: a.createdAt,
      event: `${KIND_LABELS[a.kind] ?? a.kind} (${a.promptVersion})`,
      detail: [a.model, formatUsd(a.costUsd), a.valid ? "geçerli" : `geçersiz${a.error ? `: ${firstLine(a.error)}` : ""}`].join(" · "),
      who: "Sistem",
      tone: a.valid ? null : "err",
    });
  }
  for (const r of input.deepRequests) {
    rows.push({ at: r.requestedAt, event: "Derin analiz istendi", detail: null, who: r.requestedBy ?? "Profil (otomatik)", tone: null });
    if (r.finishedAt && (r.status === "done" || r.status === "failed")) {
      rows.push({
        at: r.finishedAt,
        event: r.status === "done" ? "Derin analiz tamamlandı" : "Derin analiz başarısız",
        detail: r.status === "failed" ? firstLine(r.error) : null,
        who: "Sistem",
        tone: r.status === "failed" ? "err" : "ok",
      });
    }
  }
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}
