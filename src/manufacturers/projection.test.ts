import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { manufacturerCertifications, manufacturerImports, manufacturers, type NewManufacturer } from "@/db/schema";
import { loadManufacturerPool, resetManufacturerPoolCache, toProjection } from "./projection";

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

async function addImport(version: string): Promise<number> {
  const [row] = await t.db
    .insert(manufacturerImports)
    .values({ version, poolSha256: "a".repeat(64), sourcesSha256: "b".repeat(64), manufacturers: 2, sources: 0, inserted: 2, updated: 0, deactivated: 0 })
    .returning({ id: manufacturerImports.id });
  return row!.id;
}

function firm(importId: number, fields: Partial<NewManufacturer> & Pick<NewManufacturer, "id" | "legalName">): NewManufacturer {
  return { kind: "producer", poolVersion: "2.3", importId, ...fields };
}

describe("toProjection", () => {
  it("keeps only codes of the taxonomy, attaches certificates and sorts by name in Turkish", () => {
    const base = {
      province: null, products: [], materials: [], standards: [], sizeRange: null, productionMethod: null,
      aqap: "unknown" as const, as9100: "unknown" as const, exports: "unknown" as const, fitLevel: null, hasEvidenceQuote: false, hasContact: false, contactState: "not_contacted" as const,
    };
    const out = toProjection(
      [
        { ...base, id: "BZ-000000000002", legalName: "Çelik A.Ş.", categories: ["METAL_HARDWARE", "NOT_A_CODE"], families: ["F01", "F99"] },
        { ...base, id: "BZ-000000000001", legalName: "Cıvata Ltd. Şti.", categories: [], families: [] },
      ],
      [{ manufacturerId: "BZ-000000000002", name: "ISO 9001", kind: "management", validUntil: null }],
    );
    expect(out.map((m) => m.legalName)).toEqual(["Cıvata Ltd. Şti.", "Çelik A.Ş."]);
    expect(out[1]).toMatchObject({ categories: ["METAL_HARDWARE"], families: ["F01"], certifications: [{ name: "ISO 9001", kind: "management", validUntil: null }] });
    expect(out[0]!.certifications).toEqual([]);
  });
});

describe("loadManufacturerPool", () => {
  it("is null before the first import", async () => {
    expect(await loadManufacturerPool(t.db)).toBeNull();
  });

  it("reads active firms with contact and evidence flags, and leaves inactive ones out", async () => {
    const id = await addImport("2.3");
    await t.db.insert(manufacturers).values([
      firm(id, { id: "BZ-00000000000A", legalName: "Aktif A.Ş.", families: ["F16"], phones: ["+903123944375"], evidenceQuote: "Jeneratör üretiyoruz." }),
      firm(id, { id: "BZ-00000000000B", legalName: "Pasif A.Ş.", active: false }),
    ]);
    await t.db.insert(manufacturerCertifications).values([
      { manufacturerId: "BZ-00000000000A", name: "ISO 9001", kind: "management" },
      { manufacturerId: "BZ-00000000000B", name: "ISO 14001", kind: "management" },
    ]);
    const pool = await loadManufacturerPool(t.db);
    expect(pool?.poolVersion).toBe("2.3");
    expect(pool?.manufacturers).toHaveLength(1);
    expect(pool?.manufacturers[0]).toMatchObject({ id: "BZ-00000000000A", families: ["F16"], hasContact: true, hasEvidenceQuote: true });
    expect(pool?.manufacturers[0]!.certifications.map((c) => c.name)).toEqual(["ISO 9001"]);
  });

  it("asks only for the latest import while it is unchanged, and reloads after a new import", async () => {
    const first = await addImport("2.3");
    await t.db.insert(manufacturers).values(firm(first, { id: "BZ-00000000000A", legalName: "Bir A.Ş." }));
    const before = await loadManufacturerPool(t.db);

    const select = vi.spyOn(t.db, "select");
    const again = await loadManufacturerPool(t.db);
    expect(again).toBe(before);
    expect(select).toHaveBeenCalledTimes(1);
    select.mockRestore();

    const second = await addImport("2.4");
    await t.db.insert(manufacturers).values(firm(second, { id: "BZ-00000000000C", legalName: "İki A.Ş.", poolVersion: "2.4" }));
    const after = await loadManufacturerPool(t.db);
    expect(after?.poolVersion).toBe("2.4");
    expect(after?.manufacturers.map((m) => m.id)).toEqual(["BZ-00000000000A", "BZ-00000000000C"]);
  });
});

describe("manufacturers table", () => {
  it("refuses an id outside the pool's format and a sole proprietor with a tax number", async () => {
    const id = await addImport("2.3");
    await expect(t.db.insert(manufacturers).values(firm(id, { id: "BZ-abc", legalName: "X" }))).rejects.toThrow();
    await expect(t.db.insert(manufacturers).values(firm(id, { id: "BZ-00000000000D", legalName: "X", soleProprietor: true, vkn: "1234567890" }))).rejects.toThrow();
    await expect(t.db.insert(manufacturers).values(firm(id, { id: "BZ-00000000000E", legalName: "X", vkn: "12345" }))).rejects.toThrow();
  });
});
