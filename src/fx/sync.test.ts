import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { fxRates } from "@/db/schema";
import type { FetchLike } from "@/sources/http";
import { ECB_DAILY_URL, ECB_HIST_90D_URL, parseEcbXml } from "./ecb";
import { storeRates } from "./rates";
import { syncEcbRates } from "./sync";

/** Recorded on 2026-10-13; the 90-day file is cut to 2026-10-07 .. 2026-10-13. */
const ecbFixture = (name: string) =>
  readFileSync(new URL(`../../tests/fixtures/ecb/${name}.xml`, import.meta.url), "utf8");

const files: Record<string, string> = {
  [ECB_DAILY_URL]: ecbFixture("eurofxref-daily"),
  [ECB_HIST_90D_URL]: ecbFixture("eurofxref-hist-90d"),
};

/** Serves the recorded files instead of calling the ECB. */
function fakeEcb() {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const body = files[url];
    if (body === undefined) throw new Error(`unexpected request ${url}`);
    return new Response(body, { status: 200, headers: { "content-type": "text/xml" } });
  };
  return { fetch, urls };
}

const now = () => Date.parse("2026-10-13T15:00:00Z");
const history = parseEcbXml(files[ECB_HIST_90D_URL] ?? "");
const ratesOn = (date: string) => history.filter((r) => r.date === date);

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

describe("syncEcbRates", () => {
  it("loads the 90-day history into an empty table", async () => {
    const { db } = testDb;
    const ecb = fakeEcb();
    const stats = await syncEcbRates(db, { fetch: ecb.fetch, now });
    expect(ecb.urls).toEqual([ECB_HIST_90D_URL]);
    expect(stats).toEqual({
      source: "hist-90d",
      dates: 5,
      rows: 145,
      inserted: 145,
      updated: 0,
      latestDate: "2026-10-13",
    });
    expect(await db.$count(fxRates)).toBe(145);
  });

  it("fetches only the daily file while the newest rate is at most five days old", async () => {
    const { db } = testDb;
    await storeRates(db, ratesOn("2026-10-08"));
    const ecb = fakeEcb();
    const stats = await syncEcbRates(db, { fetch: ecb.fetch, now });
    expect(ecb.urls).toEqual([ECB_DAILY_URL]);
    expect(stats).toEqual({ source: "daily", dates: 1, rows: 29, inserted: 29, updated: 0, latestDate: "2026-10-13" });
  });

  it("catches up from the history when the newest rate is older than five days", async () => {
    const { db } = testDb;
    await storeRates(db, ratesOn("2026-10-07"));
    const ecb = fakeEcb();
    const stats = await syncEcbRates(db, { fetch: ecb.fetch, now });
    expect(ecb.urls).toEqual([ECB_HIST_90D_URL]);
    expect(stats).toMatchObject({ source: "hist-90d", inserted: 4 * 29, updated: 0 });
    expect(await db.$count(fxRates)).toBe(145);
  });

  it("stores nothing new when run again", async () => {
    const { db } = testDb;
    const ecb = fakeEcb();
    await syncEcbRates(db, { fetch: ecb.fetch, now });
    const again = await syncEcbRates(db, { fetch: ecb.fetch, now });
    expect(again).toEqual({ source: "daily", dates: 1, rows: 29, inserted: 0, updated: 0, latestDate: "2026-10-13" });
    expect(ecb.urls).toEqual([ECB_HIST_90D_URL, ECB_DAILY_URL]);
    expect(await db.$count(fxRates)).toBe(145);
  });

  it("reports the stored date when the daily file is older", async () => {
    const { db } = testDb;
    await storeRates(db, [{ date: "2026-10-14", currency: "GBP", ratePerEur: 0.845 }]);
    const ecb = fakeEcb();
    const stats = await syncEcbRates(db, { fetch: ecb.fetch, now });
    expect(stats).toMatchObject({ source: "daily", latestDate: "2026-10-14" });
  });

  it("stores nothing when the ECB answers with something other than rates", async () => {
    const { db } = testDb;
    const fetch: FetchLike = async () => new Response("<html>Maintenance</html>", { status: 200 });
    await expect(syncEcbRates(db, { fetch, now })).rejects.toThrow(
      `${ECB_HIST_90D_URL}: ECB response is not a complete eurofxref document`,
    );
    expect(await db.$count(fxRates)).toBe(0);
  });
});
