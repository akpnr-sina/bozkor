import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import { createTestDb } from "../../../tests/helpers/test-db";
import { documents, lots, rawNotices, sources, tenders } from "@/db/schema";
import { storeRates } from "@/fx/rates";
import { backfill, syncWindow } from "../sync";
import type { SourceAdapter } from "../types";
import { fillValueEur } from "../value-eur";
import { normalizeTedNotice, tedNoticeKeys } from "./normalize";

const fixture = (name: string) => loadFixture<Record<string, unknown>>("eu-ted", name);

/** Adapter that serves recorded notices instead of calling the API. */
function fakeAdapter(serve: () => unknown[][]): SourceAdapter {
  return {
    id: "eu_ted",
    async *pages() {
      for (const page of serve()) yield page;
    },
    keys: tedNoticeKeys,
    normalize: normalizeTedNotice,
  };
}

const window = { from: new Date("2026-10-13T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z") };

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

const tenderOf = async (procedureKey: string) =>
  (await testDb.db.select().from(tenders).where(eq(tenders.procedureKey, procedureKey)))[0];

describe("TED sync", () => {
  it("creates no duplicates when the same backfill runs twice, and skips software", async () => {
    const { db } = testDb;
    const adapter = fakeAdapter(() => [
      [fixture("ted-cn-original"), fixture("ted-cn-change"), fixture("ted-cn-cancel-original"), fixture("ted-cn-cancel-intent")],
      [fixture("ted-cn-supplies-multi-lot"), fixture("ted-pin-planning-supplies"), fixture("ted-cn-software-cpv48")],
    ]);

    const first = await backfill(db, adapter, 1);
    expect(first).toMatchObject({ rawInserted: 7, inserted: 4, outOfScope: 1, skipped: 0, normalizeErrors: 0 });
    const counts = async () => ({
      tenders: await db.$count(tenders),
      raw: await db.$count(rawNotices),
      lots: await db.$count(lots),
      documents: await db.$count(documents),
    });
    // Original and change form one tender, as do the cancellation pair.
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ tenders: 4, raw: 7, lots: 8, documents: 3 });

    const second = await backfill(db, adapter, 1);
    expect(second).toMatchObject({ rawInserted: 0, inserted: 0, updated: 0 });
    expect(await counts()).toEqual(afterFirst);

    expect(await tenderOf("162d72b8-7c2f-4e07-9dd1-966f7a19fb54")).toMatchObject({ status: "cancelled", externalId: "704307-2026" });
    expect(await tenderOf("b6941c41-100b-45d6-8d48-593708651a9f")).toMatchObject({ noticeType: "planning", buyerCountry: "LV" });
    expect(await tenderOf("173da224-aed7-425f-89f7-e09a1b70b750")).toBeUndefined();

    const [source] = await db.select().from(sources).where(eq(sources.id, "eu_ted"));
    expect(source?.lastSyncedAt).toBeInstanceOf(Date);
    expect(source?.lastError).toBeNull();
  });

  it("applies a change notice from a later run to the same tender and marks it as changed", async () => {
    const { db } = testDb;
    const procedureKey = "ee66f3ac-3344-4d4e-8247-d5982508bf96";
    await syncWindow(db, fakeAdapter(() => [[fixture("ted-cn-original")]]), window);
    const before = await tenderOf(procedureKey);
    expect(before?.submissionDeadline?.toISOString()).toBe("2026-10-19T07:00:00.000Z");
    expect(before?.changedAt).toBeNull();

    const stats = await syncWindow(db, fakeAdapter(() => [[fixture("ted-cn-change")]]), window);
    expect(stats).toMatchObject({ inserted: 0, updated: 1, changed: 1 });
    expect(await db.$count(tenders)).toBe(1);
    const after = await tenderOf(procedureKey);
    expect(after).toMatchObject({ id: before?.id, externalId: "704935-2026", contractNature: "goods" });
    expect(after?.submissionDeadline?.toISOString()).toBe("2026-10-28T07:00:00.000Z");
    expect(after?.changedAt).toBeInstanceOf(Date);
  });

  it("follows a chain of changes over several runs", async () => {
    const { db } = testDb;
    for (const name of ["ted-chain-1", "ted-chain-2", "ted-chain-3", "ted-chain-4"]) {
      await syncWindow(db, fakeAdapter(() => [[fixture(name)]]), window);
    }
    expect(await db.$count(tenders)).toBe(1);
    const tender = await tenderOf("5ded06d7-b73d-4b1d-b15c-ca5d65896235");
    expect(tender).toMatchObject({ externalId: "706847-2026", valueCurrency: "PLN" });
    expect(tender?.submissionDeadline?.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(tender?.changedAt).toBeInstanceOf(Date);
  });

  it("converts the value at the rate of the Brussels publication day", async () => {
    const { db } = testDb;
    await syncWindow(db, fakeAdapter(() => [[fixture("ted-cn-non-eur-currency")]]), window);
    await storeRates(db, [
      { date: "2026-10-12", currency: "DKK", ratePerEur: 7.5 },
      { date: "2026-10-13", currency: "DKK", ratePerEur: 8 },
    ]);
    await fillValueEur(db);
    // Published on 13 October (22:00 UTC on the 12th): 4,000,000 DKK / 8.
    expect((await tenderOf("269d42cd-7083-45a1-a7c7-95d6a0894987"))?.valueEur).toBe(500_000);
  });
});
