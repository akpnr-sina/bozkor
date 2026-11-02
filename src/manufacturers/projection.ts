import { desc, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { manufacturerCertifications, manufacturerImports, manufacturers } from "@/db/schema";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/policy/categories";
import { isFamilyCode } from "./families";
import type { CertificationKind, ManufacturerForMatch } from "./types";

// The active manufacturers in the shape the list page and the matcher read, kept in the web process
// (SPEC 10, 8.2). An import runs in another process, so the cache cannot be told; every read asks for the
// latest import id (a few bytes) and reloads only when it changed. The projection is ~250 KB for 252 firms
// (63's measurement); contacts and long texts stay out of it.

type Executor = Pick<AppDb, "select">;

const isProductCategory = (code: string): code is ProductCategory => Object.hasOwn(PRODUCT_CATEGORIES, code);

export type ManufacturerPool = {
  importId: number;
  poolVersion: string;
  manufacturers: ManufacturerForMatch[];
};

type Row = {
  id: string;
  legalName: string;
  province: string | null;
  categories: string[];
  families: string[];
  products: string[];
  materials: string[];
  standards: string[];
  sizeRange: string | null;
  productionMethod: string | null;
  aqap: ManufacturerForMatch["aqap"];
  as9100: ManufacturerForMatch["as9100"];
  exports: ManufacturerForMatch["exports"];
  fitLevel: ManufacturerForMatch["fitLevel"];
  hasEvidenceQuote: boolean;
  hasContact: boolean;
  contactState: ManufacturerForMatch["contactState"];
};

type CertRow = { manufacturerId: string; name: string; kind: CertificationKind; validUntil: string | null };

/** Rows to the matcher's shape; codes outside the taxonomy are dropped, not trusted. */
export function toProjection(rows: readonly Row[], certs: readonly CertRow[]): ManufacturerForMatch[] {
  const byFirm = new Map<string, ManufacturerForMatch["certifications"]>();
  for (const c of certs) byFirm.set(c.manufacturerId, [...(byFirm.get(c.manufacturerId) ?? []), { name: c.name, kind: c.kind, validUntil: c.validUntil }]);
  return rows
    .map((r) => ({
      ...r,
      categories: r.categories.filter(isProductCategory),
      families: r.families.filter(isFamilyCode),
      certifications: byFirm.get(r.id) ?? [],
    }))
    .sort((a, b) => a.legalName.localeCompare(b.legalName, "tr"));
}

let cached: ManufacturerPool | null = null;

/** The active pool, or null before the first import. */
export async function loadManufacturerPool(db: Executor): Promise<ManufacturerPool | null> {
  const [latest] = await db
    .select({ id: manufacturerImports.id, version: manufacturerImports.version })
    .from(manufacturerImports)
    .orderBy(desc(manufacturerImports.id))
    .limit(1);
  if (!latest) return null;
  if (cached?.importId === latest.id) return cached;
  const [rows, certs] = await Promise.all([
    db
      .select({
        id: manufacturers.id,
        legalName: manufacturers.legalName,
        province: manufacturers.province,
        categories: manufacturers.categories,
        families: manufacturers.families,
        products: manufacturers.products,
        materials: manufacturers.materials,
        standards: manufacturers.standards,
        sizeRange: manufacturers.sizeRange,
        productionMethod: manufacturers.productionMethod,
        aqap: manufacturers.aqap,
        as9100: manufacturers.as9100,
        exports: manufacturers.exports,
        fitLevel: manufacturers.fitLevel,
        hasEvidenceQuote: sql<boolean>`${manufacturers.evidenceQuote} is not null`,
        hasContact: sql<boolean>`cardinality(${manufacturers.emails}) > 0 or cardinality(${manufacturers.phones}) > 0`,
        contactState: manufacturers.contactState,
      })
      .from(manufacturers)
      .where(eq(manufacturers.active, true)),
    db
      .select({
        manufacturerId: manufacturerCertifications.manufacturerId,
        name: manufacturerCertifications.name,
        kind: manufacturerCertifications.kind,
        validUntil: manufacturerCertifications.validUntil,
      })
      .from(manufacturerCertifications)
      .innerJoin(manufacturers, eq(manufacturers.id, manufacturerCertifications.manufacturerId))
      .where(eq(manufacturers.active, true)),
  ]);
  cached = { importId: latest.id, poolVersion: latest.version, manufacturers: toProjection(rows, certs) };
  return cached;
}

/** For tests: forget the cached pool. */
export function resetManufacturerPoolCache(): void {
  cached = null;
}
