import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { fxRates } from "@/db/schema";
import { parseEcbXml } from "./ecb";
import { buildRateTable, loadRateTable, MAX_LOOKBACK_DAYS, storeRates, toEur } from "./rates";

/** Recorded on 2026-10-13; the 90-day file is cut to 2026-10-07 .. 2026-10-13. */
const ecbFixture = (name: string) =>
  readFileSync(new URL(`../../tests/fixtures/ecb/${name}.xml`, import.meta.url), "utf8");

const history = parseEcbXml(ecbFixture("eurofxref-hist-90d"));
const daily = parseEcbXml(ecbFixture("eurofxref-daily"));
const table = buildRateTable(history);

// GBP per EUR in the fixture: Wed 07 0.84645, Thu 08 0.84698, Fri 09 0.84763,
// Mon 12 0.84478, Tue 13 0.8446.
const at = (iso: string) => new Date(iso);

describe("toEur", () => {
  it("returns EUR amounts unchanged, rates or not", () => {
    expect(toEur(1_234.56, "EUR", at("2026-10-09T10:00:00Z"), table)).toBe(1_234.56);
    expect(toEur(1_234.56, "EUR", null, new Map())).toBe(1_234.56);
  });

  it("converts GBP at that day's rate, rounded to cents", () => {
    expect(toEur(185_000, "GBP", at("2026-10-09T10:00:00Z"), table)).toBe(218_255.61);
    expect(toEur(185_000, "GBP", at("2026-10-12T10:00:00Z"), table)).toBe(218_991.93);
  });

  it("uses Friday's rate on the weekend", () => {
    expect(toEur(185_000, "GBP", at("2026-10-10T12:00:00Z"), table)).toBe(218_255.61);
    expect(toEur(185_000, "GBP", at("2026-10-11T12:00:00Z"), table)).toBe(218_255.61);
  });

  it("reads the date on the Frankfurt calendar", () => {
    // Sunday 22:30 UTC is already Monday 00:30 in Frankfurt.
    expect(toEur(185_000, "GBP", at("2026-10-11T22:30:00Z"), table)).toBe(218_991.93);
  });

  it("uses the newest rate when the date is unknown", () => {
    expect(toEur(185_000, "GBP", null, table)).toBe(219_038.6);
  });

  it(`looks back at most ${MAX_LOOKBACK_DAYS} days`, () => {
    // Newest rate is 2026-10-13.
    expect(toEur(185_000, "GBP", at("2026-10-23T12:00:00Z"), table)).toBe(219_038.6);
    expect(toEur(185_000, "GBP", at("2026-10-24T12:00:00Z"), table)).toBeNull();
  });

  it("returns null before the first stored rate", () => {
    expect(toEur(185_000, "GBP", at("2026-10-06T12:00:00Z"), table)).toBeNull();
  });

  it("returns null for currencies the ECB does not publish", () => {
    expect(toEur(185_000, "AED", at("2026-10-09T10:00:00Z"), table)).toBeNull();
    expect(toEur(185_000, "AED", null, table)).toBeNull();
  });

  it("returns null when the amount or the currency is missing", () => {
    expect(toEur(null, "GBP", at("2026-10-09T10:00:00Z"), table)).toBeNull();
    expect(toEur(185_000, null, at("2026-10-09T10:00:00Z"), table)).toBeNull();
    expect(toEur(185_000, "", at("2026-10-09T10:00:00Z"), table)).toBeNull();
    expect(toEur(Number.NaN, "GBP", at("2026-10-09T10:00:00Z"), table)).toBeNull();
    expect(toEur(185_000, "GBP", new Date(Number.NaN), table)).toBeNull();
  });

  it("accepts lower case codes", () => {
    expect(toEur(185_000, " gbp ", at("2026-10-09T10:00:00Z"), table)).toBe(218_255.61);
  });

  it("returns null with an empty table", () => {
    expect(toEur(185_000, "GBP", null, new Map())).toBeNull();
  });
});

describe("rate storage", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    await testDb.reset();
  });
  afterAll(async () => {
    await testDb.close();
  });

  it("creates no duplicates when the same rates are stored twice", async () => {
    const { db } = testDb;
    expect(await storeRates(db, history)).toEqual({ inserted: 145, updated: 0 });
    expect(await storeRates(db, history)).toEqual({ inserted: 0, updated: 0 });
    // The daily file repeats 2026-10-13, written 0.84460 where the history has 0.8446.
    expect(await storeRates(db, daily)).toEqual({ inserted: 0, updated: 0 });
    expect(await db.$count(fxRates)).toBe(145);
  });

  it("replaces a corrected rate", async () => {
    const { db } = testDb;
    await storeRates(db, history);
    const corrected = { date: "2026-10-09", currency: "GBP", ratePerEur: 0.8477 };
    expect(await storeRates(db, [corrected])).toEqual({ inserted: 0, updated: 1 });

    const loaded = await loadRateTable(db);
    expect(loaded.get("GBP")).toContainEqual({ date: "2026-10-09", ratePerEur: 0.8477 });
    expect(await db.$count(fxRates)).toBe(145);
  });

  it("keeps the last of repeated rates in one call", async () => {
    const { db } = testDb;
    const first = { date: "2026-10-09", currency: "GBP", ratePerEur: 0.84763 };
    const second = { ...first, ratePerEur: 0.8477 };
    expect(await storeRates(db, [first, second])).toEqual({ inserted: 1, updated: 0 });
    expect((await loadRateTable(db)).get("GBP")).toEqual([{ date: "2026-10-09", ratePerEur: 0.8477 }]);
  });

  it("loads the table sorted oldest first and converts like the fixture table", async () => {
    const { db } = testDb;
    await storeRates(db, history);
    const loaded = await loadRateTable(db);
    expect(loaded.size).toBe(29);
    expect(loaded.get("GBP")).toEqual([
      { date: "2026-10-07", ratePerEur: 0.84645 },
      { date: "2026-10-08", ratePerEur: 0.84698 },
      { date: "2026-10-09", ratePerEur: 0.84763 },
      { date: "2026-10-12", ratePerEur: 0.84478 },
      { date: "2026-10-13", ratePerEur: 0.8446 },
    ]);
    expect(toEur(185_000, "GBP", at("2026-10-10T12:00:00Z"), loaded)).toBe(218_255.61);
  });

  it(`loads from ${MAX_LOOKBACK_DAYS} days before 'since' so lookback still works`, async () => {
    const { db } = testDb;
    await storeRates(db, history);
    const loaded = await loadRateTable(db, "2026-10-18");
    expect(loaded.get("GBP")?.map((r) => r.date)).toEqual(["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]);
    await expect(loadRateTable(db, "18.10.2026")).rejects.toThrow(/YYYY-MM-DD/);
  });
});
