import type { GateId, GateState, Status } from "./engine";

// Turkish names of the qualification policy's statuses and gates (UI, CLI, e-mail).

export const STATUS_LABELS: Record<Status, string> = {
  BID_REVIEW: "Teklif incelemesi",
  SHORTLIST: "Kısa liste",
  NEEDS_SUPPLIER: "Üretici bulunmalı",
  NEEDS_DOCUMENTS: "Doküman gerekli",
  NEEDS_FINANCE: "Finansman gerekli",
  NEEDS_QUALIFICATION_REVIEW: "Yeterlilik incelemesi",
  NEEDS_PARTNER: "Yerel ortak gerekli",
  WATCH: "İzle",
  COMMERCIAL_NO_BID: "Ticari olarak uygun değil",
  NO_BID: "Teklif verilemez",
  HARD_REJECT: "Kesin ret",
  EXPIRED: "Süresi doldu",
};

/** One line per status, for the filter and the legend. */
export const STATUS_DESCRIPTIONS: Record<Status, string> = {
  BID_REVIEW: "Teknik, hukuki, mali ve operasyonel koşullar doğrulandı; teklif insan onayına hazır.",
  SHORTLIST: "Aktif tedarik ve ticari analiz için uygun fırsat.",
  NEEDS_SUPPLIER: "Kritik şartlar belli ve uygun; doğrulanmış Türk üretici ve teklif gerekli.",
  NEEDS_DOCUMENTS: "Umut verici olabilir ama kritik bilgiler dokümanlarda; okunmadan uygun sayılmaz.",
  NEEDS_FINANCE: "Ticari olarak umut verici, finansmanı henüz yok.",
  NEEDS_QUALIFICATION_REVIEW: "Referans, ciro ya da istekli belgesi şartı var ya da ürün izne tabi olabilir; incelenmeden teklif hazırlanmaz.",
  NEEDS_PARTNER: "Yerel kurulum ya da servis ortağı olmadan teklif verilemez.",
  WATCH: "Kategori ya da alıcı ilginç, bu ihale değmez.",
  COMMERCIAL_NO_BID: "Katılım mümkün olabilir ama ürün teslimi dışında iş (kurulum, servis) istiyor ya da maliyet, sermaye veya operasyon yükü karşılığını vermez.",
  NO_BID: "Doğrulanmış bir şart kalan sürede yerine getirilemez.",
  HARD_REJECT: "Kapsam dışı (mal değil, hizmet ya da yapım işi alımı) ya da doğrulanmış hukuki veya zorunlu uygunluk engeli.",
  EXPIRED: "Son teklif tarihi geçti; arşivde kalır.",
};

export type StatusTone = "good" | "pending" | "conditional" | "neutral" | "rejected";

/** Badge colour group of each status. */
export const STATUS_TONES: Record<Status, StatusTone> = {
  BID_REVIEW: "good",
  SHORTLIST: "good",
  NEEDS_SUPPLIER: "good",
  NEEDS_DOCUMENTS: "pending",
  NEEDS_FINANCE: "conditional",
  NEEDS_QUALIFICATION_REVIEW: "conditional",
  NEEDS_PARTNER: "conditional",
  WATCH: "neutral",
  COMMERCIAL_NO_BID: "rejected",
  NO_BID: "rejected",
  HARD_REJECT: "rejected",
  EXPIRED: "neutral",
};

export const GATE_LABELS: Record<GateId, string> = {
  H01: "Son teklif tarihi",
  H02: "Katılım uygunluğu",
  H03: "Zorunlu yeterlilik",
  H04: "Kısıtlı ürün ve izinler",
  H05: "Süresinde yerine getirilebilirlik",
  C01: "Kritik bilgiler ve dokümanlar",
  C02: "Üretici",
  C03: "Yerel kurulum ve servis ortağı",
  C04: "Finansman",
  C05: "Ürün belgeleri",
  C06: "Miktar ve şartname tutarlılığı",
  C07: "Numune",
  C08: "Teslim şekli ve ithalat",
  C09: "Referans, ciro ve istekli belgesi",
};

export const GATE_STATE_LABELS: Record<GateState, string> = {
  PASS: "Geçti",
  FAIL: "Takıldı",
  UNKNOWN: "Bilinmiyor",
  NOT_APPLICABLE: "Geçerli değil",
};

/** Status groups for the inbox filter. */
export const STATUS_GROUPS = {
  promising: ["BID_REVIEW", "SHORTLIST", "NEEDS_SUPPLIER", "NEEDS_DOCUMENTS"],
  conditional: ["NEEDS_FINANCE", "NEEDS_QUALIFICATION_REVIEW", "NEEDS_PARTNER"],
  watch: ["WATCH"],
  rejected: ["COMMERCIAL_NO_BID", "NO_BID", "HARD_REJECT"],
  expired: ["EXPIRED"],
} as const satisfies Record<string, readonly Status[]>;
export type StatusGroup = keyof typeof STATUS_GROUPS;

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  promising: "Umut verici",
  conditional: "Koşullu",
  watch: "İzle",
  rejected: "Elenen",
  expired: "Süresi dolan",
};
