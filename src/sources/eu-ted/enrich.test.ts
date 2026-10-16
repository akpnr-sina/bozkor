import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import { createTestDb } from "../../../tests/helpers/test-db";
import { criteriaProfiles, profileMatches, rawNotices, tenderReviews, tenders } from "@/db/schema";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "../sync";
import type { SourceAdapter } from "../types";
import { enrichTedNotices, type TedNoticeSource } from "./enrich";
import { normalizeTedNotice, tedNoticeKeys } from "./normalize";

const fixture = (name: string) => loadFixture<Record<string, unknown>>("eu-ted", name);

/** The fields added to TED_FIELDS for the contract details. */
const DETAIL_FIELDS = [
  "duration-period-value-lot",
  "duration-period-unit-lot",
  "contract-duration-start-date-lot",
  "contract-duration-end-date-lot",
  "framework-agreement-lot",
  "electronic-ordering-lot",
  "gpa-lot",
  "award-criterion-type-lot",
  "award-criterion-name-lot",
  "award-criterion-description-lot",
  "award-criterion-number-lot",
  "award-criterion-number-weight-lot",
  "selection-criterion-lot",
  "selection-criterion-name-lot",
  "selection-criterion-description-lot",
  "guarantee-required-lot",
  "term-performance-lot",
  "submission-language",
];

/** The notice as a sync stored it before those fields were requested. */
function storedBefore(notice: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...notice };
  for (const field of DETAIL_FIELDS) delete copy[field];
  return copy;
}

/** Adapter that serves recorded notices instead of calling the API. */
function fakeAdapter(notices: unknown[]): SourceAdapter {
  return {
    id: "eu_ted",
    async *pages() {
      yield notices;
    },
    keys: tedNoticeKeys,
    normalize: normalizeTedNotice,
  };
}

/** Serves the full recorded notices by publication number, as the API does, and records each request. */
function fakeTed(notices: Record<string, unknown>[]) {
  const requests: string[][] = [];
  const client: TedNoticeSource = {
    async *noticesByNumber(numbers) {
      requests.push([...numbers]);
      const page = notices.filter((n) => numbers.includes(String(n["publication-number"])));
      if (page.length) yield page;
    },
  };
  return { client, requests };
}

const window = { from: new Date("2026-10-13T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z") };

// 634842-2026: spare parts for 24 months. 705429-2026: a framework with a
// guarantee. 704298-2026: brake parts, whose match the profile no longer offers.
const matched = fixture("ted-policy-spare-parts-24-months");
const decided = fixture("ted-details-framework-guarantee");
const unmatched = fixture("ted-details-years");
const full = [matched, decided, unmatched];

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

const tenderOf = async (notice: Record<string, unknown>) =>
  (await testDb.db.select().from(tenders).where(eq(tenders.externalId, String(notice["publication-number"]))))[0];

/** Tenders stored before the detail fields existed: one matched, one decided, one no longer matched. */
async function storeOldTenders() {
  const { db } = testDb;
  await syncWindow(db, fakeAdapter(full.map(storedBefore)), window);
  const [profile] = await db
    .insert(criteriaProfiles)
    .values({ name: "Hepsi", rules: profileRulesSchema.parse({}) })
    .returning({ id: criteriaProfiles.id });
  await db.insert(profileMatches).values([
    { profileId: profile!.id, tenderId: (await tenderOf(matched))!.id, filterReasons: [] },
    { profileId: profile!.id, tenderId: (await tenderOf(unmatched))!.id, filterReasons: [], unmatchedAt: new Date() },
  ]);
  await db.insert(tenderReviews).values({ tenderId: (await tenderOf(decided))!.id, decision: "WATCH", decidedBy: "a@bozkor.com" });
}

describe("enrichTedNotices", () => {
  it("refetches the notices of matched and decided tenders and fills in their details", async () => {
    const { db } = testDb;
    await storeOldTenders();
    expect((await tenderOf(matched))?.details).toBeNull();

    const { client, requests } = fakeTed(full);
    const stats = await enrichTedNotices(db, client, { log: () => {} });

    expect(requests).toEqual([["634842-2026", "705429-2026"]]);
    expect(stats).toMatchObject({ tenders: 2, requested: 2, fetched: 2, rawInserted: 2, inserted: 0, updated: 2, changed: 0 });
    // The payloads stored first stay next to the refetched ones.
    expect(await db.$count(rawNotices)).toBe(5);

    const spareParts = await tenderOf(matched);
    expect(spareParts?.details).toEqual(normalizeTedNotice(matched)?.details);
    expect(spareParts?.details).toMatchObject({ durationMonths: 24, electronicOrdering: true });
    // A refetch is not a new notice: no "değişti" badge.
    expect(spareParts?.changedAt).toBeNull();
    expect((await tenderOf(decided))?.details).toMatchObject({ framework: true, guaranteeRequired: true, durationMonths: 12 });
    expect((await tenderOf(unmatched))?.details).toBeNull();
  });

  it("stores and updates nothing when run again", async () => {
    const { db } = testDb;
    await storeOldTenders();
    const { client, requests } = fakeTed(full);
    await enrichTedNotices(db, client, { log: () => {} });
    const before = await tenderOf(matched);

    const again = await enrichTedNotices(db, client, { log: () => {} });
    expect(requests).toHaveLength(2);
    expect(again).toMatchObject({ tenders: 2, fetched: 2, rawInserted: 0, procedures: 0, updated: 0 });
    expect(await db.$count(rawNotices)).toBe(5);
    expect((await tenderOf(matched))?.updatedAt).toEqual(before?.updatedAt);
  });

  it("asks in batches and keeps notices the API no longer returns as they were", async () => {
    const { db } = testDb;
    await storeOldTenders();
    const { client, requests } = fakeTed([matched]);
    const stats = await enrichTedNotices(db, client, { log: () => {}, batchSize: 1 });

    expect(requests).toEqual([["634842-2026"], ["705429-2026"]]);
    expect(stats).toMatchObject({ requested: 2, fetched: 1, rawInserted: 1, updated: 1 });
    expect((await tenderOf(decided))?.details).toBeNull();
  });

  it("asks only for tenders still without details when told to", async () => {
    const { db } = testDb;
    await storeOldTenders();
    const { client, requests } = fakeTed(full);
    await enrichTedNotices(db, client, { log: () => {} });
    // The profile offers the brake parts again: an old tender matched after the first run.
    await db.update(profileMatches).set({ unmatchedAt: null });

    const stats = await enrichTedNotices(db, client, { log: () => {}, onlyMissingDetails: true });
    expect(requests).toEqual([["634842-2026", "705429-2026"], ["704298-2026"]]);
    expect(stats).toMatchObject({ tenders: 1, requested: 1, fetched: 1, rawInserted: 1, updated: 1, changed: 0 });
    expect((await tenderOf(unmatched))?.details).toEqual(normalizeTedNotice(unmatched)?.details);
    expect((await tenderOf(unmatched))?.details).not.toBeNull();
  });

  it("asks for nothing when no TED tender has a match or a decision", async () => {
    const { db } = testDb;
    await syncWindow(db, fakeAdapter(full.map(storedBefore)), window);
    const { client, requests } = fakeTed(full);
    expect(await enrichTedNotices(db, client, { log: () => {} })).toMatchObject({ tenders: 0, requested: 0, fetched: 0 });
    expect(requests).toEqual([]);
  });
});
