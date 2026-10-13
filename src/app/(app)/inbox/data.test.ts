import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../tests/helpers/fixtures";
import { createTestDb } from "../../../../tests/helpers/test-db";
import { criteriaProfiles, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { loadInbox, readFilters, type Filters } from "./data";

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

const all: Filters = { profile: "", source: "", status: "open", decision: "" };

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let wide: string;
let narrow: string;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  const { db } = testDb;
  await syncWindow(
    db,
    fakeAdapter([
      [
        loadFixture("uk-fat", "uk4-tender-defence"),
        loadFixture("uk-fat", "uk4-tender-covered-multilot"),
        loadFixture("uk-fat", "uk4-tender-below-threshold"),
      ],
    ]),
    { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") },
  );
  await db.update(tenders).set({ submissionDeadline: sql`now() + interval '30 days'` });
  const profiles = await db
    .insert(criteriaProfiles)
    .values([
      { name: "Hepsi", rules: profileRulesSchema.parse({}) },
      { name: "Giyim", rules: profileRulesSchema.parse({ categoryIds: ["giyim"] }) },
    ])
    .returning({ id: criteriaProfiles.id });
  [wide, narrow] = profiles.map((p) => p.id) as [string, string];
  await rematch(db);
});
afterAll(async () => {
  await testDb.close();
});

describe("loadInbox", () => {
  it("lists each tender once with every profile it matched, nearest deadline first", async () => {
    await testDb.db.update(tenders).set({ submissionDeadline: sql`now() + interval '5 days'` }).where(eq(tenders.externalId, "096278-2026"));
    await testDb.db.update(tenders).set({ submissionDeadline: null }).where(eq(tenders.externalId, "096253-2026"));
    const { list, total, profiles } = await loadInbox(testDb.db, all);
    expect(total).toBe(3);
    expect(list.map((row) => row.tenderId.length > 0 && row.title.slice(0, 12))).toEqual([
      "Suffolk Coun",
      "715794488 - ",
      "LSL/MED/0222",
    ]);
    expect(profiles.map((p) => p.name)).toEqual(["Giyim", "Hepsi"]);
    const helmet = list.find((row) => row.title.includes("Helmet"));
    expect(helmet?.profiles.sort()).toEqual(["Giyim", "Hepsi"]);
    expect(helmet).toMatchObject({ isNew: true, current: true, decision: null, documentCount: 0 });
  });

  it("applies the limit to tenders, not to match rows", async () => {
    const { list, total } = await loadInbox(testDb.db, all, 2);
    expect(list).toHaveLength(2);
    expect(total).toBe(3);
  });

  it("filters by the latest decision, including a withdrawn one", async () => {
    const { db } = testDb;
    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    await db.insert(tenderReviews).values({ tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" });
    expect((await loadInbox(db, { ...all, decision: "GO" })).total).toBe(1);
    expect((await loadInbox(db, { ...all, decision: "none" })).total).toBe(2);

    await db.insert(tenderReviews).values({
      tenderId: helmet!.id,
      decision: null,
      decidedBy: "a@bozkor.com",
      decidedAt: sql`now() + interval '1 second'`,
    });
    expect((await loadInbox(db, { ...all, decision: "GO" })).total).toBe(0);
    expect((await loadInbox(db, { ...all, decision: "none" })).total).toBe(3);
  });

  it("hides ended matches and paused profiles, but keeps decided tenders findable", async () => {
    const { db } = testDb;
    await db.update(criteriaProfiles).set({ active: false }).where(eq(criteriaProfiles.id, wide));
    expect((await loadInbox(db, all)).total).toBe(1);

    await db.update(profileMatches).set({ unmatchedAt: sql`now()` }).where(eq(profileMatches.profileId, narrow));
    expect((await loadInbox(db, all)).total).toBe(0);

    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    await db.insert(tenderReviews).values({ tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" });
    // Every profile paused, as during a holiday.
    await db.update(criteriaProfiles).set({ active: false });
    const decided = await loadInbox(db, { ...all, decision: "GO" });
    expect(decided.total).toBe(1);
    expect(decided.list[0]?.current).toBe(false);
    // The page still offers the filters: there are profiles, just none active.
    expect(decided).toMatchObject({ hasAnyProfile: true, profiles: [] });
  });

  it("finds a decided tender that never matched any profile", async () => {
    const { db } = testDb;
    const [medical] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096253-2026"));
    await db.delete(profileMatches).where(eq(profileMatches.tenderId, medical!.id));
    await db.insert(tenderReviews).values({ tenderId: medical!.id, decision: "WATCH", decidedBy: "a@bozkor.com" });
    const watched = await loadInbox(db, { ...all, decision: "WATCH" });
    expect(watched.total).toBe(1);
    expect(watched.list[0]).toMatchObject({ profiles: [], current: false, isNew: false, decision: "WATCH" });
  });

  it("separates open from closed tenders", async () => {
    const { db } = testDb;
    await db.update(tenders).set({ status: "cancelled" }).where(eq(tenders.externalId, "096315-2026"));
    expect((await loadInbox(db, all)).total).toBe(2);
    expect((await loadInbox(db, { ...all, status: "closed" })).total).toBe(1);
    expect((await loadInbox(db, { ...all, status: "all" })).total).toBe(3);
  });
});

describe("readFilters", () => {
  it("accepts known values and drops the rest", () => {
    expect(readFilters({ profile: "not-a-uuid", source: "x", status: "weird", decision: "MAYBE" })).toEqual(all);
    expect(readFilters({ source: "uk_fat", status: "closed", decision: "GO" })).toMatchObject({
      source: "uk_fat",
      status: "closed",
      decision: "GO",
    });
  });
});
