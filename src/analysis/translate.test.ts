import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { analyses, criteriaProfiles, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm";
import { pendingTranslations, runTranslation, translateTender, TRANSLATION_PROMPT_VERSION } from "./translate";
import { latestTranslations } from "./translations";

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

const MODEL = "claude-haiku-5-5";
const PROMPT = "Test çeviri promptu";
const usage = { inputTokens: 1_500, outputTokens: 1_200, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

const reply = (body: unknown, stopReason = "end_turn"): LlmResponse => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  stopReason,
  refusalCategory: null,
  model: `${MODEL}-20261001`,
  usage,
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
const helmet = "ocds-h6vhtk-066c9e";
const medical = "ocds-h6vhtk-060198";

async function tenderIdOf(procedureKey: string) {
  const [row] = await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, procedureKey));
  return row!.id;
}

async function lotNumbersOf(tenderId: string) {
  const rows = await testDb.db.select({ lotNumber: lots.lotNumber }).from(lots).where(eq(lots.tenderId, tenderId));
  return rows.map((r) => r.lotNumber).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** A Turkish version of the tender with the given lots, as the model would answer. */
const translation = (lotNumbers: string[], title = "Deniz itfaiye kaskı ve iletişim sistemi tedariki") => ({
  title,
  description: "Savunma Bakanlığı adına yangın söndürme kaskı ve iletişim sistemi alınacaktır.",
  lots: lotNumbers.map((lotNumber) => ({ lotNumber, title: `Lot ${lotNumber}`, description: "" })),
});

function fakeLlm(script: (request: LlmRequest, call: number) => LlmResponse | Promise<LlmResponse>) {
  const requests: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(request) {
      requests.push(request);
      return script(request, requests.length);
    },
  };
  return { client, requests };
}

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "5");
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
  // Clothing only: the helmet matches, the medical devices and planters do not.
  await db.insert(criteriaProfiles).values({ name: "Giyim", rules: profileRulesSchema.parse({ categoryIds: ["giyim"] }) });
  await rematch(db);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.close();
});

describe("translations", () => {
  it("translates the tenders the team sees: current matches and decided ones", async () => {
    const { db } = testDb;
    const helmetId = await tenderIdOf(helmet);
    const medicalId = await tenderIdOf(medical);
    expect(await pendingTranslations(db, 10)).toEqual([helmetId]);

    await db.insert(tenderReviews).values({ tenderId: medicalId, decision: "WATCH", decidedBy: "a@bozkor.com" });
    expect((await pendingTranslations(db, 10)).sort()).toEqual([helmetId, medicalId].sort());

    // A withdrawn decision no longer counts.
    await db.insert(tenderReviews).values({ tenderId: medicalId, decision: null, decidedBy: "a@bozkor.com", decidedAt: sql`now() + interval '1 second'` });
    expect(await pendingTranslations(db, 10)).toEqual([helmetId]);

    // An ended match does not count either.
    await db.update(profileMatches).set({ unmatchedAt: sql`now()` });
    expect(await pendingTranslations(db, 10)).toEqual([]);
  });

  it("stores a validated translation, and does it again after the tender changes", async () => {
    const { db } = testDb;
    const helmetId = await tenderIdOf(helmet);
    const lotNumbers = await lotNumbersOf(helmetId);
    const { client, requests } = fakeLlm(() => reply(translation(lotNumbers, "Deniz itfaiye kaskı \u2014 iletişim sistemi")));

    const stats = await runTranslation(db, client, { model: MODEL, prompt: PROMPT });
    expect(stats).toMatchObject({ attempted: 1, valid: 1, invalid: 0 });
    expect(requests[0]).toMatchObject({ model: MODEL, system: PROMPT, effort: "medium" });
    expect(requests[0]!.thinking).toBeUndefined();

    const [row] = await db.select().from(analyses);
    expect(row).toMatchObject({ kind: "translation", profileId: null, promptVersion: TRANSLATION_PROMPT_VERSION, valid: true });
    const stored = (await latestTranslations(db, [helmetId])).get(helmetId);
    expect(stored).toMatchObject({ title: "Deniz itfaiye kaskı, iletişim sistemi", lots: lotNumbers.map((n) => ({ lotNumber: n })) });
    expect(stored?.sourcesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await pendingTranslations(db, 10)).toEqual([]);

    await db.update(analyses).set({ createdAt: sql`now() - interval '2 hours'` });
    await db.update(tenders).set({ changedAt: sql`now() - interval '1 hour'` }).where(eq(tenders.id, helmetId));
    expect(await pendingTranslations(db, 10)).toEqual([helmetId]);
  });

  it("rejects an answer whose lots differ from the ones sent, then accepts a correct retry", async () => {
    const { db } = testDb;
    const helmetId = await tenderIdOf(helmet);
    const lotNumbers = await lotNumbersOf(helmetId);
    const { client } = fakeLlm((_request, call) => (call === 1 ? reply(translation([...lotNumbers, "99"])) : reply(translation(lotNumbers))));
    expect(await translateTender(db, client, helmetId, MODEL, PROMPT)).toMatchObject({ status: "valid" });
    const rows = await db.select().from(analyses).orderBy(analyses.createdAt);
    expect(rows.map((r) => r.valid)).toEqual([false, true]);
    expect(rows[0]?.error).toMatch(/^Lotlar girdiyle eşleşmiyor/);
  });

  it("keeps the latest valid translation when a newer attempt fails", async () => {
    const { db } = testDb;
    const helmetId = await tenderIdOf(helmet);
    const lotNumbers = await lotNumbersOf(helmetId);
    await translateTender(db, fakeLlm(() => reply(translation(lotNumbers))).client, helmetId, MODEL, PROMPT);
    await translateTender(db, fakeLlm(() => reply({ title: "" })).client, helmetId, MODEL, PROMPT);
    expect((await latestTranslations(db, [helmetId])).get(helmetId)?.title).toBe("Deniz itfaiye kaskı ve iletişim sistemi tedariki");
  });
});
