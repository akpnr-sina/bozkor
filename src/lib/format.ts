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
/** "Lot 1" for TED's "LOT-0001" and Find a Tender's "1"; other identifiers as given. */
export function lotLabel(lotNumber: string): string {
  const match = /^LOT-0*(\d+)$/i.exec(lotNumber.trim());
  return `Lot ${match ? match[1] : lotNumber.trim()}`;
}

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
