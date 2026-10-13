import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadFixture } from "../../tests/helpers/fixtures";
import { documents, lots, rawNotices, sources, tenders } from "@/db/schema";
import { storeRawNotices } from "./store";
import { backfill, syncIncremental, syncWindow } from "./sync";
import type { SourceAdapter } from "./types";
import { fatNoticeKeys, normalizeFatRelease } from "./uk-fat/normalize";

const fixture = (name: string) => loadFixture<Record<string, unknown>>("uk-fat", name);

/** Adapter that serves recorded releases instead of calling the API. */
function fakeAdapter(serve: () => unknown[][]): SourceAdapter {
  return {
    id: "uk_fat",
    async *pages() {
      for (const page of serve()) yield page;
    },
    keys: fatNoticeKeys,
    normalize: normalizeFatRelease,
  };
}

const window = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") };

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

describe("sync", () => {
  it("creates no duplicates when the same backfill runs twice", async () => {
    const { db } = testDb;
    const adapter = fakeAdapter(() => [
      [fixture("uk4-tender-covered-multilot"), fixture("uk4-tender-below-threshold"), fixture("uk6-award")],
      [fixture("uk4-tender-before-change"), fixture("uk4-tender-change"), fixture("uk2-planning-market-engagement")],
    ]);

    const first = await backfill(db, adapter, 2);
    // The award notice belongs to a procedure without a tender notice here.
    expect(first).toMatchObject({ inserted: 4, skipped: 1, normalizeErrors: 0 });

    const counts = async () => ({
      tenders: await db.$count(tenders),
      raw: await db.$count(rawNotices),
      lots: await db.$count(lots),
      documents: await db.$count(documents),
    });
    // Every raw payload is stored, the award included; the two Historic
    // England notices form one tender.
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ tenders: 4, raw: 6, lots: 5, documents: 1 });

    const second = await backfill(db, adapter, 2);
    expect(second).toMatchObject({ rawInserted: 0, inserted: 0, updated: 0, skipped: 0 });
    expect(await counts()).toEqual(afterFirst);

    const [source] = await db.select().from(sources).where(eq(sources.id, "uk_fat"));
    expect(source?.lastSyncedAt).toBeInstanceOf(Date);
    expect(source?.lastError).toBeNull();
    expect(source?.cursor).toBeTruthy();
  });

  it("applies a correction from a later run and marks the tender as changed", async () => {
    const { db } = testDb;
    await syncWindow(db, fakeAdapter(() => [[fixture("uk4-tender-before-change")]]), window);
    const [before] = await db.select().from(tenders);
    expect(before?.submissionDeadline?.toISOString()).toBe("2026-11-30T09:30:00.000Z");
    expect(before?.changedAt).toBeNull();

    const stats = await syncWindow(db, fakeAdapter(() => [[fixture("uk4-tender-change")]]), window);
    expect(stats).toMatchObject({ inserted: 0, updated: 1, changed: 1 });
    const [after] = await db.select().from(tenders);
    expect(after?.id).toBe(before?.id);
    expect(after?.externalId).toBe("096284-2026");
    expect(after?.submissionDeadline?.toISOString()).toBe("2026-11-13T09:30:00.000Z");
    expect(after?.changedAt).toBeInstanceOf(Date);
  });

  it("does not mark a tender as changed when all its notices arrive in one run", async () => {
    const { db } = testDb;
    await syncWindow(
      db,
      fakeAdapter(() => [[fixture("uk4-tender-before-change")], [fixture("uk4-tender-change")]]),
      window,
    );
    const [tender] = await db.select().from(tenders);
    expect(tender?.externalId).toBe("096284-2026");
    expect(tender?.changedAt).toBeNull();
  });

  it("stores the tender's lots and document links", async () => {
    const { db } = testDb;
    await syncWindow(db, fakeAdapter(() => [[fixture("uk4-tender-below-threshold")]]), window);
    const [tender] = await db.select().from(tenders);
    expect(tender).toMatchObject({ regime: "below_threshold", valueAmount: 185_000, valueCurrency: "GBP" });
    const docs = await db.select().from(documents);
    expect(docs).toEqual([
      expect.objectContaining({
        origin: "auto",
        fetchStatus: "pending",
        documentType: "biddingDocuments",
        sourceUrl: "https://www.find-tender.service.gov.uk/Notice/Attachment/A-23996",
      }),
    ]);
  });

  it("completes procedures whose raw rows were stored by a run that was interrupted", async () => {
    const { db } = testDb;
    // Simulates Control+C between storing a page and applying it.
    await storeRawNotices(db, "uk_fat", [
      { keys: { externalId: "096253-2026", procedureKey: "ocds-h6vhtk-060198" }, payload: fixture("uk4-tender-covered-multilot") },
    ]);
    expect(await db.$count(tenders)).toBe(0);

    const adapter = fakeAdapter(() => [[fixture("uk4-tender-covered-multilot")]]);
    const stats = await backfill(db, adapter, 1);
    expect(stats).toMatchObject({ rawInserted: 0, inserted: 1 });
    expect(await db.$count(tenders)).toBe(1);
    expect(await db.$count(rawNotices, isNull(rawNotices.appliedAt))).toBe(0);
  });

  it("marks an existing tender as awarded without flagging it as changed", async () => {
    const { db } = testDb;
    const tender = fixture("uk4-tender-before-change");
    await syncWindow(db, fakeAdapter(() => [[tender]]), window);
    const award = { ...fixture("uk6-award"), ocid: tender.ocid, date: "2027-01-15T10:00:00Z" };

    const stats = await syncWindow(db, fakeAdapter(() => [[award]]), window);
    expect(stats).toMatchObject({ updated: 1, changed: 0 });
    const [row] = await db.select().from(tenders);
    expect(row).toMatchObject({ status: "awarded", externalId: "096277-2026", changedAt: null });
  });

  it("does not create a tender from an award notice or an old-regime correction alone", async () => {
    const { db } = testDb;
    const stats = await syncWindow(
      db,
      fakeAdapter(() => [[fixture("uk6-award"), fixture("celex-tender-update")]]),
      window,
    );
    expect(stats).toMatchObject({ inserted: 0, skipped: 2 });
    expect(await db.$count(tenders)).toBe(0);
    // Marked as applied so they are not retried on every run.
    expect(await db.$count(rawNotices, isNull(rawNotices.appliedAt))).toBe(0);
  });

  it("reports unreadable notices on the source after a successful sync", async () => {
    const { db } = testDb;
    const adapter: SourceAdapter = {
      ...fakeAdapter(() => [[fixture("uk4-tender-below-threshold"), fixture("uk4-tender-defence")]]),
      normalize: (raw) => {
        if ((raw as { id?: string }).id === "096315-2026") throw new Error("broken payload");
        return normalizeFatRelease(raw);
      },
    };
    await syncIncremental(db, adapter, { log: () => {} });
    const [source] = await db.select().from(sources).where(eq(sources.id, "uk_fat"));
    expect(source?.lastError).toBe("Son senkronda 1 ilan okunamadı.");
    expect(source?.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("records the error and keeps the cursor when a sync fails", async () => {
    const { db } = testDb;
    const failing: SourceAdapter = {
      ...fakeAdapter(() => []),
      async *pages() {
        throw new Error("HTTP 503 for https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages");
      },
    };
    await expect(syncIncremental(db, failing)).rejects.toThrow(/503/);
    const [source] = await db.select().from(sources).where(eq(sources.id, "uk_fat"));
    expect(source?.lastError).toMatch(/HTTP 503/);
    expect(source?.cursor).toBeNull();
    expect(source?.lastSyncedAt).toBeNull();
  });

  it("starts the next incremental run one hour before the cursor", async () => {
    const { db } = testDb;
    await db.update(sources).set({ cursor: "2026-10-13T10:00:00.000Z" }).where(eq(sources.id, "uk_fat"));
    const requested: { from: Date; to: Date }[] = [];
    const adapter: SourceAdapter = {
      ...fakeAdapter(() => []),
      async *pages(w) {
        requested.push(w);
      },
    };
    await syncIncremental(db, adapter);
    expect(requested[0]?.from.toISOString()).toBe("2026-10-13T09:00:00.000Z");
    const [source] = await db.select().from(sources).where(eq(sources.id, "uk_fat"));
    expect(source?.lastError).toBeNull();
    expect(new Date(source?.cursor ?? 0).getTime()).toBeGreaterThan(Date.parse("2026-10-13T10:00:00Z"));
  });
});
