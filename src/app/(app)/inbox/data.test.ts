import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../tests/helpers/fixtures";
import { createTestDb } from "../../../../tests/helpers/test-db";
import { analyses, criteriaProfiles, profileMatches, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { inboxQuery, loadInbox, readFilters, type Filters } from "./data";

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

const all: Filters = { profile: "", source: "", status: "open", decision: "", assessment: "", sort: "deadline", page: 1 };

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
        loadFixture("uk-fat", "uk4-goods-below-threshold"),
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
    await testDb.db.update(tenders).set({ submissionDeadline: sql`now() + interval '5 days'` }).where(eq(tenders.externalId, "096156-2026"));
    await testDb.db.update(tenders).set({ submissionDeadline: null }).where(eq(tenders.externalId, "096253-2026"));
    const { list, total, profiles } = await loadInbox(testDb.db, all);
    expect(total).toBe(3);
    expect(list.map((row) => row.tenderId.length > 0 && row.title.slice(0, 12))).toEqual([
      "High Quality",
      "715794488 - ",
      "LSL/MED/0222",
    ]);
    expect(profiles.map((p) => p.name)).toEqual(["Giyim", "Hepsi"]);
    const helmet = list.find((row) => row.title.includes("Helmet"));
    expect(helmet?.profiles.sort()).toEqual(["Giyim", "Hepsi"]);
    expect(helmet).toMatchObject({ isNew: true, current: true, decision: null, documentCount: 0 });
  });

  it("pages over tenders, not match rows, and counts all of them", async () => {
    const first = await loadInbox(testDb.db, all, 2);
    expect(first.list).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = await loadInbox(testDb.db, { ...all, page: 2 }, 2);
    expect(second.list).toHaveLength(1);
    expect(second.total).toBe(3);
    expect(second.list[0]?.tenderId).not.toBe(first.list[0]?.tenderId);
    expect(second.list[0]?.tenderId).not.toBe(first.list[1]?.tenderId);
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

  it("sorts by the qualification verdict and filters by its group", async () => {
    const { db } = testDb;
    const idOf = async (externalId: string) => (await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, externalId)))[0]!.id;
    const medical = await idOf("096253-2026");
    const helmet = await idOf("096315-2026");
    const verdict = async (tenderId: string, status: "NEEDS_SUPPLIER" | "COMMERCIAL_NO_BID", fit: [number, number]) => {
      const [facts] = await db
        .insert(analyses)
        .values({ tenderId, kind: "facts", model: "claude-haiku-5-5", promptVersion: "facts.v1", output: {}, valid: true })
        .returning({ id: analyses.id });
      await db.insert(tenderAssessments).values({
        tenderId,
        factsAnalysisId: facts!.id,
        policyVersion: "policy.v1",
        status,
        bestLot: "",
        explanation: `${status} gerekçesi`,
        fitLow: fit[0],
        fitHigh: fit[1],
        preliminaryLow: fit[0],
        preliminaryHigh: fit[1],
        confidence: 50,
      });
    };
    await verdict(helmet, "COMMERCIAL_NO_BID", [20, 60]);
    await verdict(medical, "NEEDS_SUPPLIER", [70, 90]);

    const { list, total } = await loadInbox(db, { ...all, sort: "assessment" });
    expect(total).toBe(3);
    expect(list.map((row) => [row.tenderId, row.assessmentStatus])).toEqual([
      [medical, "NEEDS_SUPPLIER"],
      [helmet, "COMMERCIAL_NO_BID"],
      [expect.any(String), null],
    ]);
    expect(list[0]).toMatchObject({ fitLow: 70, fitHigh: 90, assessmentExplanation: "NEEDS_SUPPLIER gerekçesi" });

    expect((await loadInbox(db, { ...all, assessment: "rejected" })).list.map((row) => row.tenderId)).toEqual([helmet]);
    expect((await loadInbox(db, { ...all, assessment: "promising" })).list.map((row) => row.tenderId)).toEqual([medical]);
    expect((await loadInbox(db, { ...all, assessment: "none" })).list.map((row) => row.assessmentStatus)).toEqual([null]);

    // The decision view carries verdicts too.
    await db.insert(tenderReviews).values({ tenderId: helmet, decision: "WATCH", decidedBy: "a@bozkor.com" });
    expect((await loadInbox(db, { ...all, decision: "WATCH" })).list[0]).toMatchObject({ tenderId: helmet, assessmentStatus: "COMMERCIAL_NO_BID" });

    // Out of scope leaves the everyday list but stays findable; a tender the team works on stays.
    await db.update(tenderAssessments).set({ status: "HARD_REJECT" });
    const everyday = (await loadInbox(db, all)).list.map((row) => row.tenderId);
    expect(everyday).not.toContain(medical);
    expect(everyday).toContain(helmet);
    expect((await loadInbox(db, { ...all, assessment: "rejected" })).list.map((row) => row.tenderId).sort()).toEqual([helmet, medical].sort());

    expect(inboxQuery({ ...all, sort: "assessment", assessment: "promising" }, 2)).toBe("?assessment=promising&sort=assessment&page=2");
    expect(readFilters({ assessment: "rejected", sort: "assessment" })).toMatchObject({ assessment: "rejected", sort: "assessment" });
    expect(readFilters({ assessment: "toString", sort: "score" })).toMatchObject({ assessment: "", sort: "deadline" });
  });

  it("reports the total on a page past the end", async () => {
    const page = await loadInbox(testDb.db, { ...all, page: 5 }, 2);
    expect(page).toMatchObject({ list: [], total: 3 });
  });

  it("keeps tenders the team is working on in the default view after their match ended", async () => {
    const { db } = testDb;
    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    const [medical] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096253-2026"));
    await db.insert(tenderReviews).values([
      { tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" },
      { tenderId: medical!.id, decision: "NO_GO", decidedBy: "a@bozkor.com" },
    ]);
    await db.update(profileMatches).set({ unmatchedAt: sql`now()` });

    const { list, total } = await loadInbox(db, all);
    expect(total).toBe(1);
    expect(list[0]).toMatchObject({ tenderId: helmet!.id, decision: "GO", current: false, profiles: [] });
    // A profile filter shows only that profile's current matches.
    expect((await loadInbox(db, { ...all, profile: narrow })).total).toBe(0);
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
    expect(readFilters({ source: "uk_fat", status: "closed", decision: "GO", page: "3" })).toMatchObject({
      source: "uk_fat",
      status: "closed",
      decision: "GO",
      page: 3,
    });
    for (const page of ["0", "-1", "2.5", "abc", "999999"]) expect(readFilters({ page }).page).toBe(1);
  });

  it("builds links that keep the filters and leave out defaults", () => {
    expect(inboxQuery(all)).toBe("");
    expect(inboxQuery({ ...all, source: "eu_ted", decision: "GO" }, 2)).toBe("?source=eu_ted&decision=GO&page=2");
    expect(inboxQuery({ ...all, status: "all", page: 4 }, 1)).toBe("?status=all");
  });
});
