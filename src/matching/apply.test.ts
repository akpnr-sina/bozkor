import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { criteriaProfiles, lots, profileMatches, tenders } from "@/db/schema";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { clearCandidateCaches, PREVIEW_FRESH_MS, PREVIEW_MAX_AGE_MS, previewRules, rematch } from "./apply";
import { profileRulesSchema, type ProfileRulesInput } from "./rules";

const fixture = (name: string) => loadFixture<Record<string, unknown>>("uk-fat", name);

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

const window = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") };
const helmetTender = "ocds-h6vhtk-066c9e";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  const { db } = testDb;
  clearCandidateCaches(db);
  await syncWindow(
    db,
    fakeAdapter([
      [fixture("uk4-tender-defence"), fixture("uk4-tender-covered-multilot"), fixture("uk4-goods-below-threshold")],
    ]),
    window,
  );
  // Keep the tests independent of the date they run on.
  await db.update(tenders).set({
    submissionDeadline: sql`now() + interval '30 days'`,
    publishedAt: sql`now() - interval '1 day'`,
  });
});
afterAll(async () => {
  await testDb.close();
});

async function createProfile(rules: ProfileRulesInput, active = true) {
  const [row] = await testDb.db
    .insert(criteriaProfiles)
    .values({ name: "Test", active, rules: profileRulesSchema.parse(rules) })
    .returning({ id: criteriaProfiles.id });
  if (!row) throw new Error("profile not created");
  return row.id;
}

const matchesOf = (profileId: string) =>
  testDb.db
    .select({
      tenderId: profileMatches.tenderId,
      state: profileMatches.state,
      reasons: profileMatches.filterReasons,
      unmatchedAt: profileMatches.unmatchedAt,
    })
    .from(profileMatches)
    .where(eq(profileMatches.profileId, profileId));

async function tenderId(procedureKey: string) {
  const [row] = await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, procedureKey));
  return row?.id;
}

describe("rematch", () => {
  it("stores matches with their reasons and is idempotent", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });

    const first = await rematch(testDb.db);
    expect(first).toMatchObject({ profiles: 1, matched: 1, created: 1, unmatched: 0 });
    const [match] = await matchesOf(profileId);
    expect(match?.tenderId).toBe(await tenderId(helmetTender));
    expect(match?.state).toBe("new");
    expect(match?.reasons).toEqual([
      expect.objectContaining({ rule: "noticeType", value: "tender" }),
      expect.objectContaining({ rule: "cpv", prefixes: ["181", "351134"] }),
    ]);

    const second = await rematch(testDb.db);
    expect(second).toMatchObject({ matched: 1, created: 0, unmatched: 0 });
    expect(await matchesOf(profileId)).toHaveLength(1);
  });

  it("keeps a match when the tender closes or is cancelled", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db
      .update(tenders)
      .set({ submissionDeadline: sql`now() - interval '1 day'` })
      .where(eq(tenders.procedureKey, helmetTender));

    expect(await rematch(testDb.db)).toMatchObject({ unmatched: 0 });
    await testDb.db.update(tenders).set({ status: "cancelled" }).where(eq(tenders.procedureKey, helmetTender));
    expect(await rematch(testDb.db, { profileIds: [profileId] })).toMatchObject({ unmatched: 0 });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: null })]);
  });

  it("marks matches the edited profile no longer wants, closed tenders included", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db
      .update(tenders)
      .set({ submissionDeadline: sql`now() - interval '1 day'` })
      .where(eq(tenders.procedureKey, helmetTender));

    await testDb.db
      .update(criteriaProfiles)
      .set({ rules: profileRulesSchema.parse({ categoryIds: ["guc"] }) })
      .where(eq(criteriaProfiles.id, profileId));
    expect(await rematch(testDb.db, { profileIds: [profileId] })).toMatchObject({ unmatched: 1 });
    // The row stays, with its state, so a decision or triage is never lost.
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: expect.any(Date) })]);
  });

  it("restores an ended match when the profile wants the tender again, keeping its state", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db.update(profileMatches).set({ state: "dismissed" });
    const setRules = (rules: ProfileRulesInput) =>
      testDb.db.update(criteriaProfiles).set({ rules: profileRulesSchema.parse(rules) }).where(eq(criteriaProfiles.id, profileId));

    await setRules({ categoryIds: ["guc"] });
    expect(await rematch(testDb.db, { profileIds: [profileId] })).toMatchObject({ unmatched: 1 });
    await setRules({ categoryIds: ["giyim"] });
    expect(await rematch(testDb.db, { profileIds: [profileId] })).toMatchObject({ matched: 1, created: 0 });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: null, state: "dismissed" })]);
  });

  it("ignores inactive profiles and profiles with unreadable rules", async () => {
    await createProfile({ categoryIds: ["giyim"] }, false);
    await testDb.db.insert(criteriaProfiles).values({ name: "Broken", rules: { cpvInclude: ["x"] } });
    const logs: string[] = [];
    expect(await rematch(testDb.db, { log: (m) => logs.push(m) })).toMatchObject({ profiles: 0, matched: 0 });
    expect(logs).toHaveLength(1);
  });

  it("ends the match of an open tender that turns out to be out of scope", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db.update(tenders).set({ contractNature: "services" }).where(eq(tenders.procedureKey, helmetTender));

    expect(await rematch(testDb.db)).toMatchObject({ matched: 0, unmatched: 1 });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: expect.any(Date) })]);
  });

  it("leaves the state of an existing match alone", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db.update(profileMatches).set({ state: "seen" });
    await rematch(testDb.db);
    expect((await matchesOf(profileId))[0]?.state).toBe("seen");
  });

  it("after a sync judges only the tenders written since then", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    await testDb.db.execute(sql`update tenders set updated_at = now() - interval '1 hour'`);
    const before = new Date(Date.now() - 1_000);
    // Drizzle's update stamps updated_at, as the sync's upsert does.
    await testDb.db.update(tenders).set({ contractNature: "services" }).where(eq(tenders.procedureKey, helmetTender));

    const later = new Date(Date.now() + 60_000);
    expect(await rematch(testDb.db, { changedSince: later })).toMatchObject({ tenders: 0, matched: 0, unmatched: 0 });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: null })]);
    expect(await rematch(testDb.db, { changedSince: before })).toMatchObject({ tenders: 1, unmatched: 1 });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: expect.any(Date) })]);
  });

  it("also judges the tenders it is given, whose updated_at did not move", async () => {
    const profileId = await createProfile({ categoryIds: ["giyim"] });
    await rematch(testDb.db);
    // A raw update leaves updated_at alone, like the EUR value fill.
    await testDb.db.execute(sql`update tenders set contract_nature = 'services' where procedure_key = ${helmetTender}`);
    const later = new Date(Date.now() + 60_000);

    expect(await rematch(testDb.db, { tenderIds: [] })).toMatchObject({ tenders: 0, unmatched: 0 });
    expect(await rematch(testDb.db, { changedSince: later, tenderIds: [(await tenderId(helmetTender))!] })).toMatchObject({
      tenders: 1,
      unmatched: 1,
    });
    expect(await matchesOf(profileId)).toEqual([expect.objectContaining({ unmatchedAt: expect.any(Date) })]);
  });
});

describe("a profile's rematch from memory", () => {
  it("keeps the texts in memory, reads again only tenders written since, and shares them with the preview", async () => {
    const { db } = testDb;
    const profileId = await createProfile({ keywordsAny: ["zzqx"] });
    expect(await rematch(db, { profileIds: [profileId] })).toMatchObject({ tenders: 3, matched: 0 });
    // A raw update leaves updated_at alone: the text in memory stays.
    await db.execute(sql`update tenders set title = title || ' zzqx' where procedure_key = ${helmetTender}`);
    expect(await rematch(db, { profileIds: [profileId] })).toMatchObject({ matched: 0 });
    expect(await previewRules(db, profileRulesSchema.parse({ keywordsAny: ["zzqx"] }))).toMatchObject({ scanned: 3, matched: 0 });

    await db.execute(sql`update tenders set updated_at = now() where procedure_key = ${helmetTender}`);
    expect(await rematch(db, { profileIds: [profileId] })).toMatchObject({ matched: 1, created: 1 });
  });

  it("reads the EUR value every time, as it changes without updated_at", async () => {
    const { db } = testDb;
    const profileId = await createProfile({ categoryIds: ["giyim"], valueMinEur: 1_000, includeUnknownValue: false });
    await db.execute(sql`update tenders set value_eur = null`);
    expect(await rematch(db, { profileIds: [profileId] })).toMatchObject({ matched: 0 });
    await db.execute(sql`update tenders set value_eur = 50000 where procedure_key = ${helmetTender}`);
    expect(await rematch(db, { profileIds: [profileId] })).toMatchObject({ matched: 1, created: 1 });
  });
});

describe("previewRules", () => {
  it("counts matches over recent tenders and explains the rest", async () => {
    const rules = profileRulesSchema.parse({ categoryIds: ["giyim"] });
    const result = await previewRules(testDb.db, rules);
    expect(result).toMatchObject({ scanned: 3, matched: 1, openNow: 1 });
    expect(result.examples[0]?.title).toContain("Naval Firefighting Helmet");
    expect(result.rejections).toEqual({ topic: 2 });
  });

  it("counts out-of-scope tenders as their own rejection", async () => {
    await testDb.db.update(tenders).set({ contractNature: "services" }).where(eq(tenders.procedureKey, helmetTender));
    const result = await previewRules(testDb.db, profileRulesSchema.parse({ categoryIds: ["giyim"] }));
    expect(result).toMatchObject({ scanned: 3, matched: 0 });
    expect(result.rejections).toEqual({ scope: 1, topic: 2 });
  });

  it("judges lots too: a tender matches by its lot's code alone", async () => {
    const { db } = testDb;
    const [lot] = await db
      .select({ tenderId: lots.tenderId, cpv: lots.cpv })
      .from(lots)
      .where(sql`cardinality(${lots.cpv}) > 0`)
      .limit(1);
    const code = lot?.cpv?.[0];
    if (!lot || !code) throw new Error("fixture has no lot with a CPV code");
    // The tender itself carries an unrelated code, so only its lot can match.
    await db.update(tenders).set({ cpvMain: "03000000", cpvAdditional: [] }).where(eq(tenders.id, lot.tenderId));
    const result = await previewRules(db, profileRulesSchema.parse({ cpvInclude: [code.slice(0, 5)] }));
    expect(result.examples.map((example) => example.id)).toContain(lot.tenderId);
  });

  it("answers from memory while fresh, from the old tenders while they reload, and waits once they are too old", async () => {
    const { db } = testDb;
    const rules = profileRulesSchema.parse({});
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      expect((await previewRules(db, rules)).scanned).toBe(3);
      // One tender leaves the 30 days in the database.
      await db.update(tenders).set({ publishedAt: sql`now() - interval '90 days'` }).where(eq(tenders.procedureKey, helmetTender));
      vi.setSystemTime(start + 5 * 60_000);
      expect((await previewRules(db, rules)).scanned).toBe(3);
      // Stale: the old tenders answer at once, the reload runs behind.
      vi.setSystemTime(start + PREVIEW_FRESH_MS + 1);
      expect((await previewRules(db, rules)).scanned).toBe(3);
      await vi.waitFor(async () => expect((await previewRules(db, rules)).scanned).toBe(2));
      // Too old: the preview waits for the reload.
      await db.update(tenders).set({ publishedAt: sql`now() - interval '1 day'` });
      vi.setSystemTime(start + PREVIEW_FRESH_MS + PREVIEW_MAX_AGE_MS + 2);
      expect((await previewRules(db, rules)).scanned).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("judges tenders as on their publication day, when they were open", async () => {
    await testDb.db.update(tenders).set({ status: "cancelled" }).where(eq(tenders.procedureKey, helmetTender));
    const result = await previewRules(testDb.db, profileRulesSchema.parse({ categoryIds: ["giyim"] }), 30);
    // Counted as a would-have-matched, but not as open today.
    expect(result).toMatchObject({ matched: 1, openNow: 0 });
  });
});
