import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { extractFacts } from "@/analysis/facts";
import type { LlmClient } from "@/analysis/llm";
import type { AppDb } from "@/db";
import { criteriaProfiles, fxRates, sources, tenders } from "@/db/schema";
import { profileRulesSchema, type ProfileRulesInput } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { databaseNow } from "@/sources/store";
import { fillValueEur } from "@/sources/value-eur";
import { createTenderChanges, matchedThroughAtStart, onceADay } from "./incremental";

const adapter: SourceAdapter = {
  id: "uk_fat",
  async *pages() {
    yield [loadFixture("uk-fat", "uk4-policy-ba-compressor"), loadFixture("uk-fat", "uk4-policy-cafe-furniture")];
  },
  keys: fatNoticeKeys,
  normalize: normalizeFatRelease,
};

const COMPRESSOR = "ocds-h6vhtk-07867f";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let compressorId: string;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "5");
  await testDb.reset();
  const { db } = testDb;
  await syncWindow(db, adapter, { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z") });
  await db.insert(fxRates).values({ date: "2026-10-13", currency: "GBP", ratePerEur: 0.87 });
  await fillValueEur(db);
  // Open whatever the date, and written an hour ago (a raw update, so Drizzle does not stamp updated_at).
  await db.execute(
    sql`update tenders set submission_deadline = now() + interval '30 days', published_at = now() - interval '1 day', updated_at = now() - interval '1 hour'`,
  );
  const [row] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, COMPRESSOR));
  compressorId = row!.id;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.close();
});

/** databaseNow and Date count in milliseconds: lets the clock move past the last write. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Writes the tender again as a sync does, stamped by the database clock. */
async function rewrite(tenderId: string, set = sql`title = title`) {
  await testDb.db.execute(sql`update tenders set ${set}, updated_at = now() where id = ${tenderId}`);
  await tick();
}

async function createProfile(rules: ProfileRulesInput) {
  await testDb.db.insert(criteriaProfiles).values({ name: "Kompresör", active: true, rules: profileRulesSchema.parse(rules) });
}

/** The database, with every transaction failing: a run that breaks half way. */
function failingTransactions(db: AppDb): AppDb {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") return () => Promise.reject(new Error("boom"));
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Stores valid facts for the tender, through the real extraction with a model that answers them. */
async function storeFacts(tenderId: string) {
  const answer = facts({
    lots: [
      lot({
        lotNumber: "1",
        productTr: "solunum havası kompresörü",
        category: "SAFETY_CRITICAL_MACHINERY",
        categoryQuote: "Procurement of Replacement BA Compressor",
      }),
    ],
  });
  const client: LlmClient = {
    async complete() {
      return {
        text: JSON.stringify(answer),
        stopReason: "end_turn",
        refusalCategory: null,
        model: "claude-haiku-5-5",
        usage: { inputTokens: 4_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 },
      };
    },
  };
  expect((await extractFacts(testDb.db, client, tenderId, "claude-haiku-5-5", "prompt")).status).toBe("valid");
}

describe("createTenderChanges", () => {
  it("judges every open tender on its first run, then only the tenders written since the last run", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"] });
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });

    expect(await afterTenderChanges(db)).toMatchObject({ full: true, match: { tenders: 2, matched: 1, created: 1 } });
    expect(await afterTenderChanges(db)).toMatchObject({ full: false, match: { tenders: 0, matched: 0 } });
    await rewrite(compressorId);
    expect(await afterTenderChanges(db)).toMatchObject({ full: false, match: { tenders: 1, matched: 1, created: 0 } });
    expect(await afterTenderChanges(db)).toMatchObject({ match: { tenders: 0 } });
  });

  it("starts from the time it is given instead of judging every open tender", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"] });
    const floor = await databaseNow(db);
    await tick();
    await rewrite(compressorId);
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0, handledThrough: floor });
    expect(await afterTenderChanges(db)).toMatchObject({ full: false, match: { tenders: 1, matched: 1, created: 1 } });
  });

  it("runs one at a time, so two runs at the start do not both judge every tender", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"] });
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });
    const runs = await Promise.all([afterTenderChanges(db), afterTenderChanges(db)]);
    expect(runs.map((r) => r.full)).toEqual([true, false]);
  });

  it("keeps the window of a run that failed, so the next run judges its tenders", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"] });
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });
    await afterTenderChanges(db);
    await rewrite(compressorId, sql`contract_nature = 'services'`);

    await expect(afterTenderChanges(failingTransactions(db))).rejects.toThrow("boom");
    expect(await afterTenderChanges(db)).toMatchObject({ match: { tenders: 1, unmatched: 1 } });
  });

  it("judges the tenders whose EUR value changed, although their updated_at did not move", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"], valueMinEur: 1_000, includeUnknownValue: false });
    await db.execute(sql`update tenders set value_amount = null, value_eur = null where id = ${compressorId}`);
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });
    expect(await afterTenderChanges(db)).toMatchObject({ match: { matched: 0 } });

    // A raw update leaves updated_at alone, like the EUR value fill.
    await db.execute(sql`update tenders set value_amount = 50000, value_currency = 'GBP' where id = ${compressorId}`);
    const second = await afterTenderChanges(db);
    expect(second.value.changedIds).toEqual([compressorId]);
    expect(second).toMatchObject({ full: false, match: { tenders: 1, created: 1 } });
  });

  it("rechecks every EUR value when asked (new rates), not only those of recent writes", async () => {
    const { db } = testDb;
    await createProfile({ keywordsAny: ["compressor"], valueMaxEur: 60_000 });
    await db.execute(sql`update tenders set value_amount = 50000, value_currency = 'GBP' where id = ${compressorId}`);
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });
    // 50,000 GBP at 0.87 is 57,471 EUR.
    expect(await afterTenderChanges(db)).toMatchObject({ match: { matched: 1 } });

    // A rate closer to the publication day: 50,000 GBP at 0.80 is 62,500 EUR, over the maximum.
    await db.execute(sql`insert into fx_rates (date, currency, rate_per_eur) values ((now() - interval '2 days')::date, 'GBP', 0.8)`);
    expect(await afterTenderChanges(db)).toMatchObject({ value: { updated: 0 }, match: { tenders: 0 } });
    // Both tenders are in GBP.
    expect(await afterTenderChanges(db, { recheckValues: true })).toMatchObject({ value: { updated: 2 }, match: { tenders: 2, unmatched: 1 } });
  });

  it("assesses the tenders with facts that changed after the process started", async () => {
    const { db } = testDb;
    const afterTenderChanges = createTenderChanges({ log: () => {}, marginMs: 0 });
    await tick();
    await storeFacts(compressorId);
    await tick();

    expect(await afterTenderChanges(db)).toMatchObject({ assess: { assessed: 1 } });
    expect(await afterTenderChanges(db)).toMatchObject({ assess: { assessed: 0 } });
    await rewrite(compressorId);
    expect(await afterTenderChanges(db)).toMatchObject({ assess: { assessed: 1 } });
    // A new EUR value leaves updated_at alone.
    await db.execute(sql`update tenders set value_amount = 50000, value_currency = 'GBP', value_eur = null where id = ${compressorId}`);
    expect(await afterTenderChanges(db)).toMatchObject({ value: { changedIds: [compressorId] }, assess: { assessed: 1 } });
  });
});

describe("matchedThroughAtStart", () => {
  it("is the oldest last sync, and null while a source has never synced", async () => {
    const { db } = testDb;
    expect(await matchedThroughAtStart(db)).toBeNull();
    await db.update(sources).set({ lastSyncedAt: new Date("2026-10-27T08:00:00Z") }).where(eq(sources.id, "uk_fat"));
    expect(await matchedThroughAtStart(db)).toBeNull();
    await db.update(sources).set({ lastSyncedAt: new Date("2026-10-26T17:30:00Z") }).where(eq(sources.id, "eu_ted"));
    expect(await matchedThroughAtStart(db)).toEqual(new Date("2026-10-26T17:30:00Z"));
  });
});

describe("onceADay", () => {
  it("runs on the first call and then on the first call of each Istanbul day, and again after a failure", async () => {
    // Istanbul is UTC+3.
    let now = new Date("2026-10-26T20:00:00Z");
    const work = vi.fn(async () => {});
    const run = onceADay(work, () => now);

    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
    now = new Date("2026-10-26T20:59:00Z");
    expect(await run()).toBe(false);
    now = new Date("2026-10-26T21:01:00Z");
    expect(await run()).toBe(true);
    expect(work).toHaveBeenCalledTimes(2);

    now = new Date("2026-10-27T21:30:00Z");
    work.mockRejectedValueOnce(new Error("down"));
    await expect(run()).rejects.toThrow("down");
    expect(await run()).toBe(true);
    expect(await run()).toBe(false);
  });
});
