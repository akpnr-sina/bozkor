import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { tenders } from "@/db/schema";
import { buildRateTable, storeRates } from "@/fx/rates";
import { syncWindow } from "./sync";
import type { SourceAdapter } from "./types";
import { fatNoticeKeys, normalizeFatRelease } from "./uk-fat/normalize";
import { fillValueEur, valueInEur } from "./value-eur";

const rates = [
  { date: "2026-10-09", currency: "GBP", ratePerEur: 0.86 },
  { date: "2026-10-12", currency: "GBP", ratePerEur: 0.85 },
  { date: "2026-10-12", currency: "USD", ratePerEur: 1.1 },
];
const table = buildRateTable(rates);

describe("valueInEur", () => {
  it("converts at the rate of the publication day", () => {
    expect(valueInEur(85, "GBP", new Date("2026-10-12T15:00:00Z"), table)).toBe(100);
  });

  it("uses the previous working day over a weekend", () => {
    // Sunday 11 October borrows Friday 9 October.
    expect(valueInEur(86, "GBP", new Date("2026-10-11T10:00:00Z"), table)).toBe(100);
  });

  it("falls back to the oldest stored rate for tenders older than the stored range", () => {
    expect(valueInEur(86, "GBP", new Date("2026-03-01T10:00:00Z"), table)).toBe(100);
  });

  it("uses the newest rate for tenders newer than the stored range", () => {
    expect(valueInEur(85, "GBP", new Date("2026-12-01T10:00:00Z"), table)).toBe(100);
  });

  it("returns EUR amounts unchanged and leaves unknown currencies empty", () => {
    expect(valueInEur(1234.5, "EUR", null, table)).toBe(1234.5);
    expect(valueInEur(500, "AED", new Date("2026-10-12T10:00:00Z"), table)).toBeNull();
    expect(valueInEur(null, "GBP", null, table)).toBeNull();
  });
});

function fakeAdapter(pages: unknown[][]): SourceAdapter {
  return {
    id: "uk_fat",
    async *pages() {
      for (const page of pages) yield page;
    },
    keys: fatNoticeKeys,
    normalize: normalizeFatRelease,
  };
}

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  await syncWindow(
    testDb.db,
    fakeAdapter([[loadFixture("uk-fat", "uk4-tender-covered-multilot"), loadFixture("uk-fat", "uk4-goods-below-threshold")]]),
    { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") },
  );
  await storeRates(testDb.db, rates);
});
afterAll(async () => {
  await testDb.close();
});

const valueOf = async (externalId: string) =>
  (await testDb.db.select({ v: tenders.valueEur }).from(tenders).where(eq(tenders.externalId, externalId)))[0]?.v;

describe("fillValueEur", () => {
  it("fills every tender with a value and writes nothing on a second run", async () => {
    const first = await fillValueEur(testDb.db);
    expect(first).toMatchObject({ checked: 2, updated: 2, unconverted: 0 });
    // 6,000,000 GBP / 0.85 and 58,000 GBP / 0.85, published on 12 October.
    expect(await valueOf("096253-2026")).toBe(7_058_823.53);
    expect(await valueOf("096156-2026")).toBe(68_235.29);

    expect(await fillValueEur(testDb.db)).toMatchObject({ updated: 0 });
  });

  it("only rechecks recently upserted tenders and those still missing a value", async () => {
    await fillValueEur(testDb.db);
    const since = new Date(Date.now() + 60_000);
    expect(await fillValueEur(testDb.db, { since })).toMatchObject({ checked: 0 });
    await testDb.db.update(tenders).set({ valueEur: null }).where(eq(tenders.externalId, "096156-2026"));
    expect(await fillValueEur(testDb.db, { since })).toMatchObject({ checked: 1, updated: 1 });
  });

  it("clears the EUR value when the amount disappears and counts unknown currencies", async () => {
    await fillValueEur(testDb.db);
    const before = await testDb.db.select({ id: tenders.id, updatedAt: tenders.updatedAt }).from(tenders);
    await testDb.db.execute(sql`update tenders set value_amount = null where external_id = '096253-2026'`);
    await testDb.db.execute(sql`update tenders set value_currency = 'AED' where external_id = '096156-2026'`);
    const stats = await fillValueEur(testDb.db);
    expect(stats).toMatchObject({ updated: 2, unconverted: 1 });
    expect(await valueOf("096253-2026")).toBeNull();
    expect(await valueOf("096156-2026")).toBeNull();
    // The fill itself leaves updated_at alone (the raw updates above avoid Drizzle's $onUpdate too).
    const after = await testDb.db.select({ id: tenders.id, updatedAt: tenders.updatedAt }).from(tenders);
    expect(after.map((r) => [r.id, r.updatedAt.getTime()]).sort()).toEqual(before.map((r) => [r.id, r.updatedAt.getTime()]).sort());
  });
});
