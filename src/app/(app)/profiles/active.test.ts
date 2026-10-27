import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../tests/helpers/fixtures";
import { createTestDb } from "../../../../tests/helpers/test-db";
import { criteriaProfiles, profileMatches, tenders } from "@/db/schema";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { setProfileActive } from "./active";

const fixture = (name: string) => loadFixture<Record<string, unknown>>("uk-fat", name);
const adapter: SourceAdapter = {
  id: "uk_fat",
  async *pages() {
    yield [fixture("uk4-tender-defence"), fixture("uk4-tender-covered-multilot"), fixture("uk4-goods-below-threshold")];
  },
  keys: fatNoticeKeys,
  normalize: normalizeFatRelease,
};

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  await syncWindow(testDb.db, adapter, { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") });
  // Open whatever the day the tests run.
  await testDb.db.update(tenders).set({ submissionDeadline: sql`now() + interval '30 days'`, publishedAt: sql`now() - interval '1 day'` });
});
afterAll(async () => {
  await testDb.close();
});

/** A profile that wants the helmet tender of the fixtures (category giyim), on or off. */
async function createProfile(active: boolean, rules: Record<string, unknown> = profileRulesSchema.parse({ categoryIds: ["giyim"] })) {
  const [row] = await testDb.db
    .insert(criteriaProfiles)
    .values({ name: "Giyim", active, rules, updatedAt: new Date("2026-10-01T00:00:00Z") })
    .returning({ id: criteriaProfiles.id, triageInputsChangedAt: criteriaProfiles.triageInputsChangedAt });
  if (!row) throw new Error("profile not created");
  return row;
}

const profileOf = async (id: string) => (await testDb.db.select().from(criteriaProfiles).where(eq(criteriaProfiles.id, id)))[0]!;
const matchesOf = (id: string) =>
  testDb.db.select({ unmatchedAt: profileMatches.unmatchedAt }).from(profileMatches).where(eq(profileMatches.profileId, id));

describe("setProfileActive", () => {
  it("turns a profile on and matches the open tenders it wants, as saving its form does", async () => {
    const { id, triageInputsChangedAt } = await createProfile(false);
    expect(await matchesOf(id)).toHaveLength(0);

    expect(await setProfileActive(testDb.db, id, true)).toEqual({
      status: "saved",
      active: true,
      message: "Aktif yapıldı. Teklif verilebilir 1 ihale eşleşiyor (1 yeni).",
    });
    const profile = await profileOf(id);
    expect(profile.active).toBe(true);
    expect(profile.updatedAt.getTime()).toBeGreaterThan(new Date("2026-10-01T00:00:00Z").getTime());
    // Name and rules are the same: triage is not asked for again.
    expect(profile.triageInputsChangedAt).toEqual(triageInputsChangedAt);
    expect(await matchesOf(id)).toEqual([{ unmatchedAt: null }]);

    // Again: nothing new.
    expect(await setProfileActive(testDb.db, id, true)).toMatchObject({ message: "Aktif yapıldı. Teklif verilebilir 1 ihale eşleşiyor (0 yeni)." });
  });

  it("turns a profile off, matching nothing new and keeping what it matched", async () => {
    const { id } = await createProfile(false);
    await setProfileActive(testDb.db, id, true);

    expect(await setProfileActive(testDb.db, id, false)).toEqual({ status: "saved", active: false, message: "Pasif yapıldı; yeni eşleşme aranmıyor." });
    expect((await profileOf(id)).active).toBe(false);
    expect(await matchesOf(id)).toEqual([{ unmatchedAt: null }]);

    // Off, a tender it would want is not matched.
    await testDb.db.delete(profileMatches);
    await setProfileActive(testDb.db, id, false);
    expect(await matchesOf(id)).toHaveLength(0);
  });

  it("says so when a profile turned on has rules matching cannot use", async () => {
    const { id } = await createProfile(false, { categoryIds: "giyim" });
    expect(await setProfileActive(testDb.db, id, true)).toEqual({
      status: "saved",
      active: true,
      message: "Aktif yapıldı, ama kuralları geçersiz olduğu için eşleştirmede kullanılmıyor. Profili düzeltin.",
    });
    expect((await profileOf(id)).active).toBe(true);
    expect(await matchesOf(id)).toHaveLength(0);
  });

  it("fails for a profile that is not there", async () => {
    expect(await setProfileActive(testDb.db, "6d704a5e-cc06-4537-9d4f-fefa68fba7b4", true)).toEqual({ status: "error", message: "Profil bulunamadı." });
  });
});
