import { eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadFixture } from "../../tests/helpers/fixtures";
import { criteriaProfiles, documents, lots, profileMatches, rawNotices, sources, tenderReviews, tenders } from "@/db/schema";
import { profileRulesSchema } from "@/matching/rules";
import { foldNotices } from "./fold";
import { applyProcedures, planProcedures, scopeReport, storeRawNotices, upsertTender } from "./store";
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
      [
        fixture("uk4-tender-covered-multilot"),
        fixture("uk4-goods-below-threshold"),
        fixture("uk6-award"),
        // Concert tour organisation: a services tender, out of scope.
        fixture("uk4-tender-below-threshold"),
      ],
      [fixture("uk4-goods-before-change"), fixture("uk4-goods-change"), fixture("uk2-goods-planning")],
    ]);

    const first = await backfill(db, adapter, 2);
    // The award notice belongs to a procedure without a tender notice here.
    expect(first).toMatchObject({ inserted: 4, skipped: 1, outOfScope: 1, normalizeErrors: 0 });

    const counts = async () => ({
      tenders: await db.$count(tenders),
      raw: await db.$count(rawNotices),
      lots: await db.$count(lots),
      documents: await db.$count(documents),
    });
    // Every raw payload is stored, the award and the services tender included;
    // the original and its correction form one tender.
    const afterFirst = await counts();
    expect(afterFirst).toEqual({ tenders: 4, raw: 7, lots: 5, documents: 3 });

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
    await syncWindow(db, fakeAdapter(() => [[fixture("uk4-goods-before-change")]]), window);
    const [before] = await db.select().from(tenders);
    expect(before?.submissionDeadline?.toISOString()).toBe("2026-10-12T14:00:00.000Z");
    expect(before?.changedAt).toBeNull();

    const stats = await syncWindow(db, fakeAdapter(() => [[fixture("uk4-goods-change")]]), window);
    expect(stats).toMatchObject({ inserted: 0, updated: 1, changed: 1 });
    const [after] = await db.select().from(tenders);
    expect(after?.id).toBe(before?.id);
    expect(after?.externalId).toBe("096007-2026");
    // The correction extended the deadline by two days.
    expect(after?.submissionDeadline?.toISOString()).toBe("2026-10-14T14:00:00.000Z");
    expect(after?.changedAt).toBeInstanceOf(Date);
  });

  it("does not mark a tender as changed when all its notices arrive in one run", async () => {
    const { db } = testDb;
    await syncWindow(
      db,
      fakeAdapter(() => [[fixture("uk4-goods-before-change")], [fixture("uk4-goods-change")]]),
      window,
    );
    const [tender] = await db.select().from(tenders);
    expect(tender?.externalId).toBe("096007-2026");
    expect(tender?.changedAt).toBeNull();
  });

  it("stores the tender's lots and document links", async () => {
    const { db } = testDb;
    await syncWindow(db, fakeAdapter(() => [[fixture("uk4-goods-below-threshold")]]), window);
    const [tender] = await db.select().from(tenders);
    expect(tender).toMatchObject({ regime: "below_threshold", valueAmount: 58_000, valueCurrency: "GBP" });
    expect(await db.$count(lots)).toBe(1);
    const docs = await db.select().from(documents);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ origin: "auto", fetchStatus: "pending", documentType: "biddingDocuments" });
    expect(docs.map((d) => d.sourceUrl).sort()).toEqual([
      "https://www.sell2wales.gov.wales/Assets/NoticeBuilder_FileDownload.aspx?id=382855",
      "https://www.sell2wales.gov.wales/Assets/NoticeBuilder_FileDownload.aspx?id=382856",
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
    const tender = fixture("uk4-goods-before-change");
    await syncWindow(db, fakeAdapter(() => [[tender]]), window);
    const award = { ...fixture("uk6-award"), ocid: tender.ocid, date: "2027-01-15T10:00:00Z" };

    const stats = await syncWindow(db, fakeAdapter(() => [[award]]), window);
    expect(stats).toMatchObject({ updated: 1, changed: 0 });
    const [row] = await db.select().from(tenders);
    expect(row).toMatchObject({ status: "awarded", externalId: "093069-2026", changedAt: null });
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

describe("planProcedures", () => {
  it("takes the rows a run has just stored from memory and reads only the procedure's earlier rows", async () => {
    const { db } = testDb;
    const before = fixture("uk4-goods-before-change");
    const change = fixture("uk4-goods-change");
    const keys = (payload: unknown) => fatNoticeKeys(payload)!;
    expect(keys(change).procedureKey).toBe(keys(before).procedureKey);
    const first = await storeRawNotices(db, "uk_fat", [{ keys: keys(before), payload: before }]);
    const second = await storeRawNotices(db, "uk_fat", [{ keys: keys(change), payload: change }]);
    expect(second.fresh).toEqual([{ id: expect.any(String), procedureKey: keys(change).procedureKey, externalId: keys(change).externalId, payload: change }]);

    // A title only memory has: had the row been read back, the stored one would be folded.
    const edited = structuredClone(change) as { tender: { title: string } };
    edited.tender.title = "Edited in memory";
    const { plans } = await planProcedures(db, "uk_fat", [keys(change).procedureKey!], normalizeFatRelease, () => {}, [
      { ...second.fresh[0]!, payload: edited },
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.rawIds).toEqual([first.fresh[0]!.id, second.fresh[0]!.id]);
    expect(plans[0]!.folded?.title).toBe("Edited in memory");
  });
});

describe("out-of-scope procedures", () => {
  // Concert tour organisation: a services tender with one lot and one document link.
  const services = () => fixture("uk4-tender-below-threshold");
  const procedureKey = "ocds-h6vhtk-078604";
  const rerun = () => applyProcedures(testDb.db, "uk_fat", [procedureKey], normalizeFatRelease, new Date(0));
  const report = () => scopeReport(testDb.db, "uk_fat", [procedureKey], normalizeFatRelease);

  /** A tender stored before the scope rule existed, with a current profile match. */
  async function storeLeftover() {
    const { db } = testDb;
    await storeRawNotices(db, "uk_fat", [{ keys: { externalId: "096278-2026", procedureKey }, payload: services() }]);
    const notice = normalizeFatRelease(services());
    const { tenderId } = await upsertTender(db, foldNotices([notice!]), new Date(0));
    const [profile] = await db
      .insert(criteriaProfiles)
      .values({ name: "Hepsi", rules: profileRulesSchema.parse({}) })
      .returning({ id: criteriaProfiles.id });
    await db.insert(profileMatches).values({ profileId: profile!.id, tenderId, filterReasons: [] });
    return tenderId;
  }

  it("creates no tender for a services procedure", async () => {
    const stats = await syncWindow(testDb.db, fakeAdapter(() => [[services()]]), window);
    expect(stats).toMatchObject({ inserted: 0, outOfScope: 1, removed: 0 });
    expect(await testDb.db.$count(tenders)).toBe(0);
    expect(await testDb.db.$count(rawNotices, isNull(rawNotices.appliedAt))).toBe(0);
  });

  it("reports, then deletes a stored services tender with its lots, links and matches", async () => {
    const { db } = testDb;
    await storeLeftover();
    expect(await db.$count(lots)).toBe(1);
    expect(await db.$count(documents)).toBe(1);

    expect(await report()).toMatchObject({ wouldRemove: 1, wouldRemoveMatched: 1, wouldKeep: 0 });
    // The report writes nothing.
    expect(await db.$count(tenders)).toBe(1);

    expect(await rerun()).toMatchObject({ outOfScope: 1, removed: 1, outOfScopeKept: 0 });
    expect(await db.$count(tenders)).toBe(0);
    expect(await db.$count(lots)).toBe(0);
    expect(await db.$count(documents)).toBe(0);
    expect(await db.$count(profileMatches)).toBe(0);
  });

  it("keeps a services tender someone decided on, and keeps it up to date", async () => {
    const { db } = testDb;
    const tenderId = await storeLeftover();
    await db.insert(tenderReviews).values({ tenderId, decision: "GO", decidedBy: "a@bozkor.com" });
    expect(await report()).toMatchObject({ wouldRemove: 0, wouldKeep: 1, wouldKeepMatched: 1 });

    // The buyer later extends the deadline.
    const raw = services() as { tender: Record<string, unknown> };
    const extended = {
      ...raw,
      id: "099999-2026",
      date: "2026-10-20T10:00:00+01:00",
      tender: { ...raw.tender, tenderPeriod: { endDate: "2026-11-24T10:00:00+00:00" } },
    };
    const stats = await syncWindow(db, fakeAdapter(() => [[extended]]), window);
    expect(stats).toMatchObject({ outOfScope: 1, removed: 0, outOfScopeKept: 1, updated: 1, changed: 1 });
    const [row] = await db.select().from(tenders);
    expect(row).toMatchObject({ id: tenderId, externalId: "099999-2026", contractNature: "services" });
    expect(row?.submissionDeadline?.toISOString()).toBe("2026-11-24T10:00:00.000Z");
    // No profile offers it any more; the inbox still lists it for its decision.
    expect(await db.select({ unmatchedAt: profileMatches.unmatchedAt }).from(profileMatches)).toEqual([
      { unmatchedAt: expect.any(Date) },
    ]);
  });

  it("never deletes a tender when one of its notices cannot be read", async () => {
    const { db } = testDb;
    await storeLeftover();
    const broken = { ...services(), id: "099998-2026" };
    await storeRawNotices(db, "uk_fat", [{ keys: { externalId: "099998-2026", procedureKey }, payload: broken }]);
    const failing = (raw: unknown) => {
      if ((raw as { id?: string }).id === "099998-2026") throw new Error("broken payload");
      return normalizeFatRelease(raw);
    };

    expect(await scopeReport(db, "uk_fat", [procedureKey], failing, () => {})).toMatchObject({ wouldRemove: 0 });
    const stats = await applyProcedures(db, "uk_fat", [procedureKey], failing, new Date(0), () => {});
    expect(stats).toMatchObject({ outOfScope: 1, removed: 0, normalizeErrors: 1 });
    expect(await db.$count(tenders)).toBe(1);
  });
});

