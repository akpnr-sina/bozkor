import type { reviewDecision } from "@/db/schema";
import type { ContractNature, Regime, SourceId, TenderStatus } from "@/sources/types";

// Turkish labels and formatting shared by the UI. Times are shown in Istanbul.

export const TIMEZONE = "Europe/Istanbul";
const DAY_MS = 24 * 60 * 60_000;

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, dateStyle: "medium", timeStyle: "short" });
const dateFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat("tr-TR");

export const formatDateTime = (date: Date | null) => (date ? dateTimeFormat.format(date) : "Belirtilmemiş");
export const formatDate = (date: Date | null) => (date ? dateFormat.format(date) : "Belirtilmemiş");
export const formatNumber = (value: number) => numberFormat.format(value);

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Belirtilmemiş";
  if (!currency) return numberFormat.format(amount);
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${numberFormat.format(amount)} ${currency}`;
  }
}

/** Whole days until the deadline, rounded down; negative once it has passed. */
export function daysLeft(deadline: Date | null, now: Date): number | null {
  return deadline ? Math.floor((deadline.getTime() - now.getTime()) / DAY_MS) : null;
}

export function formatDaysLeft(days: number | null): string {
  if (days === null) return "Belirtilmemiş";
  if (days < 0) return "Kapandı";
  if (days === 0) return "Bugün";
  return `${days} gün`;
}

export const SOURCE_LABELS: Record<SourceId, string> = {
  uk_fat: "Find a Tender (UK)",
  eu_ted: "TED (AB)",
};

export const STATUS_LABELS: Record<TenderStatus, string> = {
  open: "Açık",
  closed: "Kapandı",
  awarded: "Sonuçlandı",
  cancelled: "İptal",
};

export const REGIME_LABELS: Record<Regime, string> = {
  covered: "Eşik üstü",
  below_threshold: "Eşik altı",
  utilities: "Kamu hizmetleri (utilities)",
  defence: "Savunma ve güvenlik",
  unknown: "Bilinmiyor",
};

export const CONTRACT_NATURE_LABELS: Record<ContractNature, string> = {
  goods: "Mal alımı",
  services: "Hizmet",
  works: "Yapım işi",
};

export const NOTICE_TYPE_LABELS: Record<string, string> = {
  planning: "Planlama",
  tender: "İhale",
};

export type ReviewDecision = (typeof reviewDecision.enumValues)[number];

export const DECISION_LABELS: Record<ReviewDecision, string> = {
  GO: "GO: teklif verilecek",
  REVIEW: "REVIEW: incelenecek",
  NO_GO: "NO_GO: teklif verilmeyecek",
  WATCH: "WATCH: izlenecek",
};

export const DECISION_SHORT: Record<ReviewDecision, string> = {
  GO: "GO",
  REVIEW: "REVIEW",
  NO_GO: "NO_GO",
  WATCH: "WATCH",
};
