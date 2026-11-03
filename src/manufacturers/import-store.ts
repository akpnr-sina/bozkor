import { and, desc, eq, getTableColumns, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AppDb } from "@/db";
import { manufacturerCertifications, manufacturerImports, manufacturers, manufacturerSources } from "@/db/schema";
import type { ImportPlan } from "./import";

// Writes a pool version prepared by import.ts (SPEC 10, 8.1) in one transaction: the import row, the
// firms by their BZ ID, their certificates and field sources. A firm the version no longer has is made
// inactive, never deleted, and keeps its certificates and sources. The same version with the same file
// digests as the last import writes nothing.

type Reader = Pick<AppDb, "select">;
type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

export type StoreOutcome = {
  /** "dry-run": what a real run would do, nothing written. "forced": the same version and files written again. */
  status: "imported" | "unchanged" | "dry-run" | "forced";
  /** The import row written; for "unchanged" the last import; null in a dry run. */
  importId: number | null;
  inserted: number;
  /** Firms whose record changed (the certificates text included) or that were inactive. */
  updated: number;
  deactivated: number;
};

const COLUMNS = getTableColumns(manufacturers);
type ColumnKey = keyof typeof COLUMNS;
const NOT_FROM_POOL = new Set<ColumnKey>(["id", "importId", "active", "createdAt", "updatedAt"]);
/** The columns an import writes from the pool, the ID aside. */
const POOL_KEYS = (Object.keys(COLUMNS) as ColumnKey[]).filter((k) => !NOT_FROM_POOL.has(k));
/** What makes a firm "updated": everything from the pool but the version label. */
const COMPARED_KEYS = POOL_KEYS.filter((k) => k !== "poolVersion");

/** Imports run one at a time (a transaction-level lock; the number is arbitrary but fixed). */
const IMPORT_LOCK = sql.raw("select pg_advisory_xact_lock(80200801)");

const excluded = (column: PgColumn): SQL => sql.raw(`excluded."${column.name}"`);

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Comparison = { unchanged: true; lastImportId: number } | { unchanged: false; inserted: number; updated: number; deactivated: number };

/** How the plan differs from what is stored. Reads the stored firms once (~760 KB for 252). */
async function compare(db: Reader, plan: ImportPlan, force: boolean): Promise<Comparison & { same: boolean }> {
  const [last] = await db
    .select({ id: manufacturerImports.id, version: manufacturerImports.version, pool: manufacturerImports.poolSha256, sources: manufacturerImports.sourcesSha256 })
    .from(manufacturerImports)
    .orderBy(desc(manufacturerImports.id))
    .limit(1);
  const same = !!last && last.version === plan.version && last.pool === plan.poolSha256 && last.sources === plan.sourcesSha256;
  if (same && !force) return { unchanged: true, lastImportId: last.id, same };
  const fields = Object.fromEntries([["id", COLUMNS.id], ["active", COLUMNS.active], ...COMPARED_KEYS.map((k) => [k, COLUMNS[k]])]) as Record<string, PgColumn>;
  const stored = (await db.select(fields).from(manufacturers)) as Record<string, unknown>[];
  const comparable = (row: Record<string, unknown>) => JSON.stringify(COMPARED_KEYS.map((k) => row[k] ?? null));
  const byId = new Map(stored.map((row) => [row.id as string, row]));
  const incoming = new Set(plan.manufacturers.map((m) => m.id));
  let inserted = 0;
  let updated = 0;
  for (const m of plan.manufacturers) {
    const before = byId.get(m.id);
    if (!before) inserted++;
    else if (before.active !== true || comparable(before) !== comparable(m)) updated++;
  }
  const deactivated = stored.filter((row) => row.active === true && !incoming.has(row.id as string)).length;
  return { unchanged: false, inserted, updated, deactivated, same };
}

/**
 * Writes the plan, or with dryRun only says what writing it would do. force writes the same version and
 * files again (after the import's rules changed), as a new import so that the web process reloads.
 */
export async function storeImport(db: AppDb, plan: ImportPlan, options: { dryRun?: boolean; force?: boolean } = {}): Promise<StoreOutcome> {
  const force = options.force ?? false;
  // An empty version would make every stored firm inactive; prepareImport never returns one.
  if (!plan.manufacturers.length) throw new Error("İçe aktarılacak firma yok.");
  if (options.dryRun) {
    const c = await compare(db, plan, force);
    return c.unchanged
      ? { status: "unchanged", importId: c.lastImportId, inserted: 0, updated: 0, deactivated: 0 }
      : { status: "dry-run", importId: null, inserted: c.inserted, updated: c.updated, deactivated: c.deactivated };
  }
  return db.transaction(async (tx) => {
    await tx.execute(IMPORT_LOCK);
    const c = await compare(tx, plan, force);
    if (c.unchanged) return { status: "unchanged", importId: c.lastImportId, inserted: 0, updated: 0, deactivated: 0 };
    const [row] = await tx
      .insert(manufacturerImports)
      .values({
        version: plan.version,
        poolSha256: plan.poolSha256,
        sourcesSha256: plan.sourcesSha256,
        manufacturers: plan.manufacturers.length,
        sources: plan.sources.length,
        inserted: c.inserted,
        updated: c.updated,
        deactivated: c.deactivated,
      })
      .returning({ id: manufacturerImports.id });
    const importId = row!.id;
    await writeFirms(tx, plan, importId);
    return { status: c.same ? "forced" : "imported", importId, inserted: c.inserted, updated: c.updated, deactivated: c.deactivated };
  });
}

async function writeFirms(tx: Tx, plan: ImportPlan, importId: number): Promise<void> {
  const ids = plan.manufacturers.map((m) => m.id);
  const set = {
    ...Object.fromEntries(POOL_KEYS.map((k) => [k, excluded(COLUMNS[k])])),
    importId: sql`${importId}`,
    active: sql`true`,
    updatedAt: sql`now()`,
  } as PgUpdateSetSource<typeof manufacturers>;
  for (const batch of chunks(plan.manufacturers, 100)) {
    await tx
      .insert(manufacturers)
      .values(batch.map((m) => ({ ...m, importId, active: true })))
      .onConflictDoUpdate({ target: manufacturers.id, set });
  }
  await tx
    .update(manufacturers)
    .set({ active: false, updatedAt: sql`now()` })
    .where(and(eq(manufacturers.active, true), notInArray(manufacturers.id, ids)));

  // Certificates follow the pool's "Sertifikalar" text, so the imported firms' are written anew.
  await tx.delete(manufacturerCertifications).where(inArray(manufacturerCertifications.manufacturerId, ids));
  for (const batch of chunks(plan.certifications, 500)) await tx.insert(manufacturerCertifications).values(batch);

  // Field sources: a field the version no longer sources is removed, the rest upserted.
  const pairs = plan.sources.map((s) => sql`(${s.manufacturerId}, ${s.field})`);
  await tx
    .delete(manufacturerSources)
    .where(
      and(
        inArray(manufacturerSources.manufacturerId, ids),
        pairs.length ? sql`(${manufacturerSources.manufacturerId}, ${manufacturerSources.field}) not in (${sql.join(pairs, sql`, `)})` : undefined,
      ),
    );
  for (const batch of chunks(plan.sources, 500)) {
    await tx
      .insert(manufacturerSources)
      .values(batch)
      .onConflictDoUpdate({
        target: [manufacturerSources.manufacturerId, manufacturerSources.field],
        set: {
          value: excluded(manufacturerSources.value),
          sourceUrl: excluded(manufacturerSources.sourceUrl),
          verification: excluded(manufacturerSources.verification),
          note: excluded(manufacturerSources.note),
          previousSources: excluded(manufacturerSources.previousSources),
          checkedOn: excluded(manufacturerSources.checkedOn),
        },
      });
  }
}

/** The command's last line for an outcome. */
export function outcomeText(o: StoreOutcome): string {
  const counts = `yeni ${o.inserted}, güncellenen ${o.updated}, pasifleşen ${o.deactivated} firma`;
  switch (o.status) {
    case "imported":
      return `Yazıldı (içe aktarma ${o.importId}): ${counts}.`;
    case "forced":
      return `Zorla yeniden yazıldı (içe aktarma ${o.importId}): ${counts}.`;
    case "unchanged":
      return `Değişiklik yok: sürüm ve dosya özetleri son içe aktarmayla (${o.importId}) aynı; hiçbir şey yazılmadı. Yine de yazmak için --force.`;
    case "dry-run":
      return `Deneme, hiçbir şey yazılmadı. Yazılsaydı: ${counts}.`;
  }
}
