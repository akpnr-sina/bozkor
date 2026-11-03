import { FAMILY_CODES, isFamilyCode, type FamilyCode } from "@/manufacturers/families";
import { CONTACT_STATE_LABELS } from "@/manufacturers/labels";
import type { ContactState, ManufacturerForMatch, Tri } from "@/manufacturers/types";
import { normalizeText } from "@/matching/text";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_CODES, type ProductCategory } from "@/policy/categories";

// The /manufacturers list's filters, read from the URL and applied to the pool in memory (the projection
// of src/manufacturers/projection.ts): 252 firms need no query per filter.

export const PAGE_SIZE = 50;
const MAX_QUERY = 100;
const MAX_PAGE = 1000;

/** "any": some certificate or AQAP; "aqap": AQAP 2110/2120 or an AQAP certificate; "none": nothing known. */
export type CertificateFilter = "" | "any" | "aqap" | "management" | "product" | "none";

export const CERTIFICATE_FILTER_LABELS: Record<Exclude<CertificateFilter, "">, string> = {
  any: "Herhangi bir belge",
  aqap: "AQAP",
  management: "Yönetim sistemi belgesi",
  product: "Ürün belgesi",
  none: "Belgesi bilinmeyen",
};

export type ManufacturerFilters = {
  /** Words in the legal name, products or materials, in any order and case. */
  q: string;
  category: "" | ProductCategory;
  family: "" | FamilyCode;
  province: string;
  certificate: CertificateFilter;
  exports: "" | Tri;
  contact: "" | ContactState;
  /** 1-based. */
  page: number;
};

const isCategory = (code: string): code is ProductCategory => Object.hasOwn(PRODUCT_CATEGORIES, code);
const isContactState = (code: string): code is ContactState => Object.hasOwn(CONTACT_STATE_LABELS, code);

export function readManufacturerFilters(params: Record<string, string | string[] | undefined>): ManufacturerFilters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };
  const category = one("category");
  const family = one("family");
  const certificate = one("certificate");
  const exports = one("exports");
  const contact = one("contact");
  const page = Number(one("page"));
  return {
    q: one("q").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY),
    category: isCategory(category) ? category : "",
    family: isFamilyCode(family) ? family : "",
    province: one("province").trim().slice(0, 40),
    certificate: Object.hasOwn(CERTIFICATE_FILTER_LABELS, certificate) ? (certificate as CertificateFilter) : "",
    exports: exports === "yes" || exports === "no" || exports === "unknown" ? exports : "",
    contact: isContactState(contact) ? contact : "",
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** Query string for the list with these filters, defaults left out. */
export function manufacturersQuery(filters: ManufacturerFilters, page = filters.page): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.category) params.set("category", filters.category);
  if (filters.family) params.set("family", filters.family);
  if (filters.province) params.set("province", filters.province);
  if (filters.certificate) params.set("certificate", filters.certificate);
  if (filters.exports) params.set("exports", filters.exports);
  if (filters.contact) params.set("contact", filters.contact);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const isFiltered = (f: ManufacturerFilters) => Boolean(f.q || f.category || f.family || f.province || f.certificate || f.exports || f.contact);

const hasAqap = (m: ManufacturerForMatch) => m.aqap === "2110" || m.aqap === "2120" || m.certifications.some((c) => c.kind === "defense");

function hasCertificate(m: ManufacturerForMatch, filter: CertificateFilter): boolean {
  switch (filter) {
    case "":
      return true;
    case "any":
      return m.certifications.length > 0 || hasAqap(m);
    case "aqap":
      return hasAqap(m);
    case "management":
    case "product":
      return m.certifications.some((c) => c.kind === filter);
    case "none":
      return m.certifications.length === 0 && !hasAqap(m);
  }
}

/** The firms the filters keep, in the pool's order (legal name). */
export function filterManufacturers(list: readonly ManufacturerForMatch[], f: ManufacturerFilters): ManufacturerForMatch[] {
  const words = f.q ? normalizeText(f.q).split(" ").filter(Boolean) : [];
  return list.filter((m) => {
    if (f.category && !m.categories.includes(f.category)) return false;
    if (f.family && !m.families.includes(f.family)) return false;
    if (f.province && m.province !== f.province) return false;
    if (!hasCertificate(m, f.certificate)) return false;
    if (f.exports && m.exports !== f.exports) return false;
    if (f.contact && m.contactState !== f.contact) return false;
    if (words.length) {
      const text = normalizeText([m.legalName, ...m.products, ...m.materials].join(" | "));
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

/** What the selects offer: only values some firm has, in the taxonomy's order (provinces in Turkish order). */
export function filterOptions(list: readonly ManufacturerForMatch[]) {
  const categories = new Set(list.flatMap((m) => m.categories));
  const families = new Set(list.flatMap((m) => m.families));
  const provinces = [...new Set(list.map((m) => m.province).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b, "tr"));
  return {
    categories: PRODUCT_CATEGORY_CODES.filter((c) => categories.has(c)),
    families: FAMILY_CODES.filter((c) => families.has(c)),
    provinces,
  };
}

/** The list's key figures, over the whole pool. */
export function poolFigures(list: readonly ManufacturerForMatch[]) {
  return {
    total: list.length,
    aqap: list.filter(hasAqap).length,
    exports: list.filter((m) => m.exports === "yes").length,
    withContact: list.filter((m) => m.hasContact).length,
  };
}
