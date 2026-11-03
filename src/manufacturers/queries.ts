import { asc, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  manufacturerCertifications,
  manufacturers,
  manufacturerSources,
  type Manufacturer,
  type ManufacturerCertification,
  type ManufacturerSource,
} from "@/db/schema";
import { POOL_COLUMNS } from "./import";

// What /manufacturers/[id] shows (SPEC 10, 8.1): the firm's whole record, its certificates and where each
// value came from. One firm is ~3 KB and its sources ~11 KB, so the page reads them whole.

export type ManufacturerDetail = {
  manufacturer: Manufacturer;
  certifications: ManufacturerCertification[];
  /** In the pool's column order, as the team's files have them. */
  sources: ManufacturerSource[];
};

const COLUMN_ORDER = new Map<string, number>(POOL_COLUMNS.map((column, i) => [column, i]));

export const isManufacturerId = (id: string) => /^BZ-[0-9A-F]{12}$/.test(id);

/** The firm, active or not; null when the pool has never had it. */
export async function loadManufacturer(db: Pick<AppDb, "select">, id: string): Promise<ManufacturerDetail | null> {
  if (!isManufacturerId(id)) return null;
  const [manufacturer] = await db.select().from(manufacturers).where(eq(manufacturers.id, id)).limit(1);
  if (!manufacturer) return null;
  const [certifications, sources] = await Promise.all([
    db.select().from(manufacturerCertifications).where(eq(manufacturerCertifications.manufacturerId, id)).orderBy(asc(manufacturerCertifications.name)),
    db.select().from(manufacturerSources).where(eq(manufacturerSources.manufacturerId, id)),
  ]);
  const order = (field: string) => COLUMN_ORDER.get(field) ?? POOL_COLUMNS.length;
  return { manufacturer, certifications, sources: sources.sort((a, b) => order(a.field) - order(b.field)) };
}
