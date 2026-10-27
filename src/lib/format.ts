import type { reviewDecision } from "@/db/schema";
import type { ContractNature, Regime, SourceId, TenderStatus } from "@/sources/types";

// Turkish labels and formatting shared by the UI. Times are shown in Istanbul.

export const TIMEZONE = "Europe/Istanbul";
const DAY_MS = 24 * 60 * 60_000;

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, dateStyle: "medium", timeStyle: "short" });
const dateFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, dateStyle: "medium" });
const numberFormat = new Intl.NumberFormat("tr-TR");

const clockFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
const dayMonthFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit" });
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export const formatDateTime = (date: Date | null) => (date ? dateTimeFormat.format(date) : "Belirtilmemiş");

/** A time of day: "14:20" when it is today in Istanbul, "19.10 14:20" otherwise. */
export function formatClock(date: Date, now: Date): string {
  const time = clockFormat.format(date);
  if (dayKeyFormat.format(date) === dayKeyFormat.format(now)) return time;
  // ICU writes the day and month alone with a slash in Turkish; the dotted form matches full dates.
  const part = (type: string) => dayMonthFormat.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return `${part("day")}.${part("month")} ${time}`;
}

const longDateFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, day: "numeric", month: "long", year: "numeric" });
const weekdayFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: TIMEZONE, weekday: "long" });

/** "20 Ekim 2026 · Pazartesi". */
export const formatLongDate = (date: Date) => `${longDateFormat.format(date)} · ${weekdayFormat.format(date)}`;

const regionNames = new Intl.DisplayNames(["tr"], { type: "region" });

/** A country's Turkish name from its ISO alpha-2 code: "DE" is "Almanya". */
export function countryName(code: string | null): string {
  if (!code) return "Belirtilmemiş";
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** How long ago, short: "şimdi", "12 dk", "3 sa", "2 gün". */
export function formatAgo(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "şimdi";
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} sa`;
  return `${Math.floor(hours / 24)} gün`;
}
export const formatDate = (date: Date | null) => (date ? dateFormat.format(date) : "Belirtilmemiş");
export const formatNumber = (value: number) => numberFormat.format(value);

const sizeFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** A file size as people read it: "850 KB", "12,4 MB". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Bilinmiyor";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${sizeFormat.format(bytes / 1024 / 1024)} MB`;
  return `${sizeFormat.format(bytes / 1024 / 1024 / 1024)} GB`;
}

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "Belirtilmemiş";
  if (!currency) return numberFormat.format(amount);
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${numberFormat.format(amount)} ${currency}`;
  }
}

/** "Lot 1" for TED's "LOT-0001" and Find a Tender's "1"; other identifiers as given. */
export function lotLabel(lotNumber: string): string {
  const match = /^LOT-0*(\d+)$/i.exec(lotNumber.trim());
  return `Lot ${match ? match[1] : lotNumber.trim()}`;
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

/** Rubric V2 section 7 contract conditions found in a notice (src/analysis/triage-schema.ts). */
export const CONDITION_FLAG_LABELS: Record<string, string> = {
  INSTALLATION_COMMISSIONING: "Kurulum ya da devreye alma",
  LOCAL_SERVICE_SLA: "Yerel servis ya da SLA",
  LONG_WARRANTY: "Uzun garanti",
  FRAMEWORK_NO_GUARANTEE: "Çerçeve anlaşma, sipariş garantisi yok",
  SMALL_FREQUENT_ORDERS: "Küçük ve sık siparişler",
  MANUFACTURER_AUTHORISATION: "Üretici yetkisi",
  BIDDER_CERTIFICATION: "İstekli belgesi",
  PRODUCT_CERTIFICATION: "Ürün sertifikası ya da standardı",
  LOCAL_PREMISES: "Yerel tesis ya da ofis",
  SELECTION_CRITERIA: "Yeterlilik şartları",
  HIDDEN_SERVICES: "Hizmet içeriği",
  BRAND_NO_EQUIVALENT: "Marka şartı, muadil yok",
  SAMPLES_REQUIRED: "Numune ya da demo",
  SHORT_DELIVERY: "Kısa teslim süresi",
  SITE_HANDLING: "Zor teslim koşulları",
  AWARD_WEIGHTING: "Değerlendirme ağırlıkları",
  VALUE_CONFLICT: "Tutar çelişkisi",
  GPA_NOT_COVERED: "GPA kapsamı dışı",
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
