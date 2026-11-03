import { readFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { manufacturerCertifications, manufacturerImports, manufacturers, manufacturerSources } from "@/db/schema";
import { parseCsv } from "@/matching/cpv/source";
import { prepareImport, sha256Hex, type ImportPlan } from "./import";
import { outcomeText, storeImport } from "./import-store";
import { loadManufacturerPool, resetManufacturerPoolCache } from "./projection";
import { loadManufacturer } from "./queries";

// The fixture package (tests/fixtures/manufacturers, 8 firms of pool v2.3) written to PGlite, then later
// "versions" made from it by changing a few rows.

const DIR = "tests/fixtures/manufacturers";
const fixtureRows = readFileSync(`${DIR}/BOZKOR_Havuz_v2.3_2026-11-02.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const fixtureSources = parseCsv(readFileSync(`${DIR}/BOZKOR_Alan_Kaynaklari_v2.3.csv`, "utf8").replace(/^\uFEFF/, "")).filter((r) => r.length > 1);

const GENSET = "BZ-09082A7038E3";
const TSE = "BZ-4E21F4C301FA";
const PPE = "BZ-DC76763A5D77";
const TWO_PROVINCES = "BZ-B5782896F16B";

const csvCell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

/** A pool version of these rows and source rows (header first), prepared as the command would. */
function version(v: string, rows = fixtureRows, sources = fixtureSources): ImportPlan {
  const poolName = `BOZKOR_Havuz_v${v}_2026-11-02.jsonl`;
  const sourcesName = `BOZKOR_Alan_Kaynaklari_v${v}.csv`;
  const pool = Buffer.from(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const csv = Buffer.from(`\uFEFF${sources.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`);
  const result = prepareImport({
    version: v,
    pool: { name: poolName, bytes: pool },
    sources: { name: sourcesName, bytes: csv },
    sha256Sums: `${sha256Hex(csv)}  ${sourcesName}\n${sha256Hex(pool)}  ${poolName}\n`,
  });
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.plan;
}

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
  resetManufacturerPoolCache();
});

async function counts() {
  return {
    imports: await t.db.$count(manufacturerImports),
    firms: await t.db.$count(manufacturers),
    active: await t.db.$count(manufacturers, eq(manufacturers.active, true)),
    certifications: await t.db.$count(manufacturerCertifications),
    sources: await t.db.$count(manufacturerSources),
  };
}

describe("storeImport", () => {
  it("writes a version with its certificates and field sources, as prepared", async () => {
    const plan = version("2.3");
    expect(await storeImport(t.db, plan)).toEqual({ status: "imported", importId: 1, inserted: 8, updated: 0, deactivated: 0 });
    expect(await counts()).toEqual({ imports: 1, firms: 8, active: 8, certifications: 7, sources: 237 });
    const [imported] = await t.db.select().from(manufacturerImports);
    expect(imported).toMatchObject({ version: "2.3", poolSha256: plan.poolSha256, sourcesSha256: plan.sourcesSha256, manufacturers: 8, sources: 237, inserted: 8, updated: 0, deactivated: 0 });

    // What was prepared is what is stored.
    const stored = await t.db.select().from(manufacturers).orderBy(asc(manufacturers.id));
    for (const m of plan.manufacturers) {
      const row = stored.find((r) => r.id === m.id)!;
      expect(row).toMatchObject({ ...m, importId: 1, active: true });
    }
    const certs = await t.db.select().from(manufacturerCertifications).where(eq(manufacturerCertifications.manufacturerId, TSE));
    expect(certs).toEqual([expect.objectContaining({ name: "TSE", kind: "product", validUntil: "2026-11-12", note: "TS ISO 8528-5:2022 / TS EN ISO 8528-13:2018" })]);
    const sources = await t.db.select().from(manufacturerSources).where(eq(manufacturerSources.manufacturerId, TSE));
    expect(sources).toHaveLength(plan.sources.filter((s) => s.manufacturerId === TSE).length);
    expect(sources).toEqual(expect.arrayContaining(plan.sources.filter((s) => s.manufacturerId === TSE)));
  });

  it("writes nothing for the same version and files a second time", async () => {
    await storeImport(t.db, version("2.3"));
    const [before] = await t.db.select({ updatedAt: manufacturers.updatedAt }).from(manufacturers).where(eq(manufacturers.id, GENSET));
    expect(await storeImport(t.db, version("2.3"))).toEqual({ status: "unchanged", importId: 1, inserted: 0, updated: 0, deactivated: 0 });
    expect(await counts()).toEqual({ imports: 1, firms: 8, active: 8, certifications: 7, sources: 237 });
    const [after] = await t.db.select({ updatedAt: manufacturers.updatedAt }).from(manufacturers).where(eq(manufacturers.id, GENSET));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });

  it("updates changed firms, retires missing ones and their old fields, and counts each", async () => {
    await storeImport(t.db, version("2.3"));
    const rows = fixtureRows
      .filter((r) => r["Firma ID"] !== TWO_PROVINCES)
      .map((r) =>
        r["Firma ID"] === GENSET
          ? { ...r, "Kendi üretimi ürünler": "Dizel jeneratör setleri;Mobil şelterler" }
          : r["Firma ID"] === PPE
            ? { ...r, Sertifikalar: "ISO 9001:2015 (2028-01-31)" }
            : r,
      );
    const droppedField = fixtureSources.find((r) => r[0] === TSE && r[1] === "Notlar") ?? fixtureSources.find((r) => r[0] === TSE)!;
    const sources = fixtureSources.filter((r) => r !== droppedField && r[0] !== TWO_PROVINCES);
    const plan = version("2.4", rows, sources);

    expect(await storeImport(t.db, plan, { dryRun: true })).toEqual({ status: "dry-run", importId: null, inserted: 0, updated: 2, deactivated: 1 });
    expect(await counts()).toMatchObject({ imports: 1, active: 8 });

    expect(await storeImport(t.db, plan)).toEqual({ status: "imported", importId: 2, inserted: 0, updated: 2, deactivated: 1 });
    // The retired firm stays, inactive, with its certificates and sources; one field of TSE is gone.
    expect(await counts()).toEqual({ imports: 2, firms: 8, active: 7, certifications: 6, sources: 236 });
    const byId = new Map((await t.db.select().from(manufacturers)).map((m) => [m.id, m]));
    expect(byId.get(TWO_PROVINCES)).toMatchObject({ active: false, poolVersion: "2.3", importId: 1 });
    expect(byId.get(GENSET)).toMatchObject({ active: true, poolVersion: "2.4", importId: 2, products: ["Dizel jeneratör setleri", "Mobil şelterler"] });
    const ppeCerts = await t.db.select().from(manufacturerCertifications).where(eq(manufacturerCertifications.manufacturerId, PPE));
    expect(ppeCerts).toEqual([expect.objectContaining({ name: "ISO 9001:2015", validUntil: "2028-01-31", note: null })]);
    const tseFields = (await t.db.select({ field: manufacturerSources.field }).from(manufacturerSources).where(eq(manufacturerSources.manufacturerId, TSE))).map((r) => r.field);
    expect(tseFields).not.toContain(droppedField[1]);
    expect(await t.db.$count(manufacturerSources, eq(manufacturerSources.manufacturerId, TWO_PROVINCES))).toBe(fixtureSources.filter((r) => r[0] === TWO_PROVINCES).length);
  });

  it("brings a retired firm back and changes a source's value in place", async () => {
    await storeImport(t.db, version("2.3"));
    await storeImport(t.db, version("2.4", fixtureRows.filter((r) => r["Firma ID"] !== TWO_PROVINCES), fixtureSources.filter((r) => r[0] !== TWO_PROVINCES)));
    const firstTse = fixtureSources.find((r) => r[0] === TSE)!;
    const sources = fixtureSources.map((r) => (r === firstTse ? [r[0]!, r[1]!, "Yeni değer", ...r.slice(3)] : r));
    // The comeback counts as an update; a changed source alone does not (the record is the same).
    expect(await storeImport(t.db, version("2.5", fixtureRows, sources))).toEqual({ status: "imported", importId: 3, inserted: 0, updated: 1, deactivated: 0 });
    expect(await counts()).toEqual({ imports: 3, firms: 8, active: 8, certifications: 7, sources: 237 });
    const [back] = await t.db.select().from(manufacturers).where(eq(manufacturers.id, TWO_PROVINCES));
    expect(back).toMatchObject({ active: true, poolVersion: "2.5", importId: 3 });
    const tse = await t.db.select({ field: manufacturerSources.field, value: manufacturerSources.value }).from(manufacturerSources).where(eq(manufacturerSources.manufacturerId, TSE));
    expect(tse).toContainEqual({ field: firstTse[1], value: "Yeni değer" });
  });

  it("writes the same version again when forced, as a new import", async () => {
    await storeImport(t.db, version("2.3"));
    expect(await storeImport(t.db, version("2.3"), { force: true, dryRun: true })).toEqual({ status: "dry-run", importId: null, inserted: 0, updated: 0, deactivated: 0 });
    expect(await storeImport(t.db, version("2.3"), { force: true })).toEqual({ status: "forced", importId: 2, inserted: 0, updated: 0, deactivated: 0 });
    expect(await counts()).toEqual({ imports: 2, firms: 8, active: 8, certifications: 7, sources: 237 });
    expect(await t.db.$count(manufacturers, eq(manufacturers.importId, 2))).toBe(8);
    // The web process sees a new import and reloads the pool.
    expect((await loadManufacturerPool(t.db))!.importId).toBe(2);
  });

  it("says what a dry run would do on an empty database, and writes nothing", async () => {
    expect(await storeImport(t.db, version("2.3"), { dryRun: true })).toEqual({ status: "dry-run", importId: null, inserted: 8, updated: 0, deactivated: 0 });
    expect(await counts()).toEqual({ imports: 0, firms: 0, active: 0, certifications: 0, sources: 0 });
    await storeImport(t.db, version("2.3"));
    expect(await storeImport(t.db, version("2.3"), { dryRun: true })).toEqual({ status: "unchanged", importId: 1, inserted: 0, updated: 0, deactivated: 0 });
  });

  it("leaves nothing behind when a write fails half way", async () => {
    const plan = version("2.3");
    const broken: ImportPlan = { ...plan, certifications: [...plan.certifications, { ...plan.certifications[0]!, manufacturerId: "BZ-000000000000" }] };
    await expect(storeImport(t.db, broken)).rejects.toThrow();
    expect(await counts()).toEqual({ imports: 0, firms: 0, active: 0, certifications: 0, sources: 0 });
  });

  it("refuses an empty version, which would retire every firm", async () => {
    await expect(storeImport(t.db, { ...version("2.3"), manufacturers: [] })).rejects.toThrow("İçe aktarılacak firma yok.");
  });

  it("feeds the projection the pages and the matcher read", async () => {
    expect(await loadManufacturerPool(t.db)).toBeNull();
    await storeImport(t.db, version("2.3"));
    const pool = await loadManufacturerPool(t.db);
    expect(pool).toMatchObject({ importId: 1, poolVersion: "2.3" });
    expect(pool!.manufacturers).toHaveLength(8);
    expect(pool!.manufacturers.find((m) => m.id === GENSET)).toMatchObject({
      families: ["F15", "F16"],
      aqap: "2110",
      certifications: [expect.objectContaining({ name: "AQAP 2110", kind: "defense" }), expect.objectContaining({ name: "AQAP 2310" })],
    });
  });
});

describe("loadManufacturer", () => {
  it("reads one firm whole, with its certificates and its sources in the pool's column order", async () => {
    const plan = version("2.3");
    await storeImport(t.db, plan);
    const detail = await loadManufacturer(t.db, TSE);
    expect(detail!.manufacturer).toMatchObject({ id: TSE, active: true, provinceBasis: "factory" });
    expect(detail!.certifications.map((c) => c.name)).toEqual(["TSE"]);
    const fields = detail!.sources.map((s) => s.field);
    expect(fields).toHaveLength(plan.sources.filter((s) => s.manufacturerId === TSE).length);
    expect(fields[0]).toBe("Firma ID");
    expect(fields.indexOf("Tüzel kişi unvanı")).toBeLessThan(fields.indexOf("Genel telefon"));
  });

  it("finds an inactive firm, and nothing for an unknown or malformed ID", async () => {
    await storeImport(t.db, version("2.3"));
    await storeImport(t.db, version("2.4", fixtureRows.filter((r) => r["Firma ID"] !== TWO_PROVINCES), fixtureSources.filter((r) => r[0] !== TWO_PROVINCES)));
    expect((await loadManufacturer(t.db, TWO_PROVINCES))!.manufacturer.active).toBe(false);
    expect(await loadManufacturer(t.db, "BZ-000000000000")).toBeNull();
    expect(await loadManufacturer(t.db, "bz-09082a7038e3")).toBeNull();
    expect(await loadManufacturer(t.db, "' or 1=1 --")).toBeNull();
  });
});

describe("outcomeText", () => {
  it("says what happened in the command's words", () => {
    const counts = { inserted: 2, updated: 3, deactivated: 1 };
    expect(outcomeText({ status: "imported", importId: 4, ...counts })).toBe("Yazıldı (içe aktarma 4): yeni 2, güncellenen 3, pasifleşen 1 firma.");
    expect(outcomeText({ status: "forced", importId: 5, ...counts })).toBe("Zorla yeniden yazıldı (içe aktarma 5): yeni 2, güncellenen 3, pasifleşen 1 firma.");
    expect(outcomeText({ status: "dry-run", importId: null, ...counts })).toBe("Deneme, hiçbir şey yazılmadı. Yazılsaydı: yeni 2, güncellenen 3, pasifleşen 1 firma.");
    expect(outcomeText({ status: "unchanged", importId: 4, inserted: 0, updated: 0, deactivated: 0 })).toBe(
      "Değişiklik yok: sürüm ve dosya özetleri son içe aktarmayla (4) aynı; hiçbir şey yazılmadı. Yine de yazmak için --force.",
    );
  });
});
