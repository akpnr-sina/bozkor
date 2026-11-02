import type { AqapLevel, CertificationKind, FitLevel, Tri } from "./types";

// Turkish labels for the manufacturer codes (UI text is Turkish, CLAUDE.md). The pool's own wording is kept
// where it has one, so the page reads like the files the team works with.

export const MANUFACTURER_KIND_LABELS = { producer: "Üretici", producer_trader: "Üretici ve ticaret" } as const;

export const ADDRESS_KIND_LABELS = { factory: "Fabrika", head_office: "Merkez ofis", branch: "Şube", unknown: "Bilinmiyor" } as const;

export const PROVINCE_BASIS_LABELS = {
  factory: "Teyitli fabrika adresi",
  company: "Firmanın kendi beyanı",
  directory: "Rehber adresi",
  unknown: "Bilinmiyor",
} as const;

export const TRI_LABELS: Record<Tri, string> = { yes: "Evet", no: "Hayır", unknown: "Bilinmiyor" };

export const AQAP_LABELS: Record<AqapLevel, string> = { "2110": "AQAP 2110", "2120": "AQAP 2120", none: "Yok", unknown: "Bilinmiyor" };

/** The pool's "İhale uygunluğu"; shown as the researcher's note, never as a score. */
export const FIT_LEVEL_LABELS: Record<FitLevel, string> = { medium: "Orta", low: "Düşük" };

export const CONTACT_STATE_LABELS = {
  not_contacted: "İletişime geçilmedi",
  info_requested: "Bilgi istendi",
  awaiting_reply: "Yanıt bekleniyor",
  confirmed: "Üretici teyit edildi",
  unsuitable: "Uygun değil",
} as const;

export const CERTIFICATION_KIND_LABELS: Record<CertificationKind, string> = {
  management: "Yönetim sistemi",
  product: "Ürün belgesi",
  defense: "Savunma",
  other: "Diğer",
};
