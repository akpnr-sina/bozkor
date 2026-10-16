import Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { analyses, criteriaProfiles, profileMatches, tenders } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm";
import { pendingTriage, runTriage, triageMatch, TRIAGE_PROMPT_VERSION } from "./triage";
import type { TriageMetric, TriageOutput } from "./triage-schema";

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
const PROMPT = "Test sistem promptu";
const usage = { inputTokens: 2_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

const metric = (rating: number | null, quote = "", quality?: TriageMetric["quality"]): TriageMetric => ({
  rating,
  quality: quality ?? (rating === null ? "MISSING" : "PROVISIONAL"),
  reason: rating === null ? "İlanda bilgi yok" : "İlanda yazıyor",
  quote,
});

const answer = (overrides: Partial<TriageOutput> = {}): TriageOutput => ({
  relevance: 70,
  productSummary: "Denizcilik için yangın söndürme kaskı ve iletişim sistemi.",
  reasons: [{ text: "Kişisel koruyucu donanım alımı", quote: "Naval Firefighting Helmet" }],
  metrics: {
    A1: metric(4, "Naval Firefighting Helmet"),
    C1: metric(null),
    C2: metric(null),
    C3: metric(null),
    C4: metric(null),
    H2: metric(null),
  },
  conditionFlags: [],
  quantityHint: { text: "", quote: "" },
  missingInfo: ["Teslim yeri belirtilmemiş"],
  ...overrides,
});

const reply = (body: unknown, stopReason = "end_turn", refusalCategory: string | null = null): LlmResponse => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  stopReason,
  refusalCategory,
  model: `${MODEL}-20261001`,
  usage,
});

/** Answers from a script, one per call; records every request. */
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

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let profileId: string;
const helmet = "ocds-h6vhtk-066c9e";

async function tenderIdOf(procedureKey: string) {
  const [row] = await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, procedureKey));
  return row!.id;
}

const matchOf = async (tenderId: string) =>
  (await testDb.db.select().from(profileMatches).where(eq(profileMatches.tenderId, tenderId)))[0];

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
  const [profile] = await db
    .insert(criteriaProfiles)
    .values({ name: "Hepsi", rules: profileRulesSchema.parse({ description: "Kişisel koruyucu donanım" }) })
    .returning({ id: criteriaProfiles.id });
  profileId = profile!.id;
  await rematch(db);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.close();
});

describe("runTriage", () => {
  it("triages every pending match and records each call with its model, prompt version, usage and cost", async () => {
    const { db } = testDb;
    const { client, requests } = fakeLlm(() => reply(answer()));
    const stats = await runTriage(db, client, { model: MODEL, prompt: PROMPT });
    expect(stats).toMatchObject({ attempted: 3, valid: 3, invalid: 0, apiErrors: 0, stoppedBy: null });
    expect(stats.costUsd).toBeGreaterThan(0);

    expect(requests[0]).toMatchObject({ model: MODEL, system: PROMPT, effort: "medium" });
    expect(requests[0]?.user).toContain("Kişisel koruyucu donanım");
    const rows = await db.select().from(analyses);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      kind: "triage",
      profileId,
      model: `${MODEL}-20261001`,
      promptVersion: TRIAGE_PROMPT_VERSION,
      valid: true,
      inputTokens: 2_000,
      outputTokens: 300,
      error: null,
    });
    expect(rows[0]?.costUsd).toBeGreaterThan(0);

    const match = await matchOf(await tenderIdOf(helmet));
    expect(match).toMatchObject({ triageScore: 70, triageAnalysisId: expect.any(String) });
    expect(await pendingTriage(db, 10)).toEqual([]);

    // Rule 5 is checked against the texts the model read, and stored with the answer.
    const stored = rows.find((r) => r.id === match?.triageAnalysisId)?.output as Record<string, unknown>;
    expect(stored).toMatchObject({
      quoteChecks: { reasons: ["title"], quantityHint: null, conditionFlags: [], metrics: { A1: "title", C1: null, H2: null } },
    });
    expect(stored.sourcesHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("makes each rubric rating agree with its evidence state", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    const output = answer({
      metrics: {
        A1: metric(4, "Naval Firefighting Helmet", "MISSING"),
        C1: metric(null, "", "PROVISIONAL"),
        C2: metric(null, "", "CONFLICT"),
        C3: metric(null),
        C4: metric(null),
        H2: metric(null),
      },
      conditionFlags: [{ code: "LONG_WARRANTY", text: "Uzun garanti \u2014 10 yıl", quote: "" }],
    });
    await triageMatch(db, fakeLlm(() => reply(output)).client, { profileId, tenderId }, MODEL, PROMPT);
    const [row] = await db.select().from(analyses);
    expect(row?.output).toMatchObject({
      metrics: { A1: { rating: 4, quality: "PROVISIONAL" }, C1: { quality: "MISSING" }, C2: { quality: "CONFLICT" } },
      conditionFlags: [{ code: "LONG_WARRANTY", text: "Uzun garanti, 10 yıl" }],
    });
  });

  it("does not retry a refusal and records why the model refused", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    const { client, requests } = fakeLlm(() => reply("", "refusal", "general_harms"));
    expect(await triageMatch(db, client, { profileId, tenderId }, MODEL, PROMPT)).toMatchObject({ status: "invalid" });
    expect(requests).toHaveLength(1);
    const [row] = await db.select().from(analyses);
    expect(row).toMatchObject({ valid: false, error: "Model yanıt vermeyi reddetti (general_harms)." });
  });

  it("keeps the last valid triage when a new one fails, and redoes it after the profile changes", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    await triageMatch(db, fakeLlm(() => reply(answer({ relevance: 70 }))).client, { profileId, tenderId }, MODEL, PROMPT);
    const before = await matchOf(tenderId);

    // Timeline: profile saved 6 h ago, triage 5 h ago, tender changed 4 h ago.
    await db.update(criteriaProfiles).set({ triageInputsChangedAt: sql`now() - interval '6 hours'` });
    await db.update(analyses).set({ createdAt: sql`now() - interval '5 hours'` });
    await db.update(tenders).set({ changedAt: sql`now() - interval '4 hours'` }).where(eq(tenders.id, tenderId));
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).toContain(tenderId);

    // Both new answers are malformed: the match keeps its last valid triage.
    await triageMatch(db, fakeLlm(() => reply("{broken")).client, { profileId, tenderId }, MODEL, PROMPT);
    expect(await matchOf(tenderId)).toMatchObject({ triageScore: 70, triageAnalysisId: before?.triageAnalysisId });

    // Those answers (now 3 h old) came after the change, so nothing is pending...
    await db.update(analyses).set({ createdAt: sql`now() - interval '3 hours'` }).where(sql`${analyses.createdAt} > now() - interval '1 hour'`);
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).not.toContain(tenderId);
    // ...until what triage reads from the profile changes, or the prompt version does.
    await db.update(analyses).set({ promptVersion: "triage.v0" }).where(sql`${analyses.createdAt} > now() - interval '4 hours'`);
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).toContain(tenderId);
    await db.update(analyses).set({ promptVersion: TRIAGE_PROMPT_VERSION });
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).not.toContain(tenderId);
    await db.update(criteriaProfiles).set({ triageInputsChangedAt: sql`now() - interval '2 hours'` });
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).toContain(tenderId);
  });

  it("retries an invalid answer once and keeps the valid retry", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    const { client } = fakeLlm((_request, call) => (call === 1 ? reply(answer({ relevance: 150 })) : reply(answer({ relevance: 40 }))));
    expect(await triageMatch(db, client, { profileId, tenderId }, MODEL, PROMPT)).toMatchObject({ status: "valid" });
    const rows = await db.select().from(analyses).orderBy(analyses.createdAt);
    expect(rows.map((r) => r.valid)).toEqual([false, true]);
    expect(rows[0]?.error).toMatch(/relevance/);
    expect((await matchOf(tenderId))?.triageScore).toBe(40);
  });

  it("records a second invalid answer as the match's result and does not retry it until the tender changes", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    const { client, requests } = fakeLlm(() => reply("{not json", "max_tokens"));
    expect(await triageMatch(db, client, { profileId, tenderId }, MODEL, PROMPT)).toMatchObject({ status: "invalid" });
    // A cut-off answer gets twice the room on the retry.
    expect(requests.map((r) => r.maxTokens)).toEqual([8_000, 16_000]);
    const failed = await db.select().from(analyses);
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => !r.valid && r.error === "Yanıt token sınırında kesildi.")).toBe(true);
    expect(failed[0]?.costUsd).toBeGreaterThan(0);
    // No valid triage yet, so none to point to.
    expect(await matchOf(tenderId)).toMatchObject({ triageScore: null, triageAnalysisId: null });

    // Out of the last hour's window, it still waits for a change of the tender.
    await db.update(criteriaProfiles).set({ triageInputsChangedAt: sql`now() - interval '3 hours'` });
    await db.update(analyses).set({ createdAt: sql`now() - interval '2 hours'` });
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).not.toContain(tenderId);
    await db.update(tenders).set({ changedAt: sql`now()` }).where(eq(tenders.id, tenderId));
    expect((await pendingTriage(db, 10)).map((k) => k.tenderId)).toContain(tenderId);
  });

  it("records API errors without cost, keeps the match pending and stops on a rejected key", async () => {
    const { db } = testDb;
    const { client, requests } = fakeLlm(() => {
      throw new Anthropic.APIError(401, undefined, "invalid x-api-key", new Headers());
    });
    const logs: string[] = [];
    const stats = await runTriage(db, client, { model: MODEL, prompt: PROMPT, concurrency: 1, log: (m) => logs.push(m) });
    expect(stats).toMatchObject({ attempted: 1, apiErrors: 1, stoppedBy: "auth" });
    expect(requests).toHaveLength(1);
    const [row] = await db.select().from(analyses);
    expect(row).toMatchObject({ valid: false, output: null, costUsd: 0, inputTokens: 0 });
    expect(row?.error).toMatch(/^API hatası \(401\)/);
    expect(logs[0]).toMatch(/401/);
    // Waits an hour, then is tried again.
    expect(await pendingTriage(db, 10)).toHaveLength(2);
    await db.update(analyses).set({ createdAt: sql`now() - interval '2 hours'` });
    expect(await pendingTriage(db, 10)).toHaveLength(3);
  });

  it("stops after repeated server errors", async () => {
    const { client } = fakeLlm(() => {
      throw new Anthropic.APIError(529, undefined, "overloaded", new Headers());
    });
    // Three pending matches: fewer than the limit, so the run just ends.
    const stats = await runTriage(testDb.db, client, { model: MODEL, prompt: PROMPT, concurrency: 1, log: () => {} });
    expect(stats).toMatchObject({ attempted: 3, apiErrors: 3, stoppedBy: null });
  });

  it("stops automatic runs at the monthly budget and lets manual runs go on with a warning", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    // An earlier call of this month; it also keeps this match out for an hour.
    await db.insert(analyses).values({ tenderId, profileId, kind: "triage", model: MODEL, promptVersion: "triage.v1", costUsd: 5 });
    const { client, requests } = fakeLlm(() => reply(answer()));

    const automatic = await runTriage(db, client, { model: MODEL, prompt: PROMPT });
    expect(automatic).toMatchObject({ attempted: 0, stoppedBy: "budget", spentBeforeUsd: 5, budgetUsd: 5 });
    expect(requests).toHaveLength(0);

    const logs: string[] = [];
    const manual = await runTriage(db, client, { model: MODEL, prompt: PROMPT, manual: true, log: (m) => logs.push(m) });
    expect(manual).toMatchObject({ valid: 2, stoppedBy: null });
    expect(logs[0]).toMatch(/bütçe/);
  });

  it("refuses a model without a known price before calling it", async () => {
    const { client, requests } = fakeLlm(() => reply(answer()));
    await expect(runTriage(testDb.db, client, { model: "claude-unknown-1", prompt: PROMPT })).rejects.toThrow(/fiyatı tanımlı değil/);
    expect(requests).toHaveLength(0);
  });

  it("removes em dashes from the AI's text but keeps quotes as the notice wrote them", async () => {
    const { db } = testDb;
    const tenderId = await tenderIdOf(helmet);
    const output = answer({
      productSummary: "Kask \u2014 iletişim sistemi",
      reasons: [{ text: "Uygun \u2014 kişisel koruyucu", quote: "Helmet \u2014 Communication" }],
    });
    const { client } = fakeLlm(() => reply(output));
    await triageMatch(db, client, { profileId, tenderId }, MODEL, PROMPT);
    const [row] = await db.select().from(analyses);
    expect(row?.output).toMatchObject({
      productSummary: "Kask, iletişim sistemi",
      reasons: [{ text: "Uygun, kişisel koruyucu", quote: "Helmet \u2014 Communication" }],
    });
  });

  it("tells the model the profile's categories and keywords when it has no description", async () => {
    const { db } = testDb;
    await db
      .update(criteriaProfiles)
      .set({ rules: profileRulesSchema.parse({ categoryIds: ["giyim"], keywordsAny: ["helmet"], keywordsNone: ["hire"] }) });
    const { client, requests } = fakeLlm(() => reply(answer()));
    await triageMatch(db, client, { profileId, tenderId: await tenderIdOf(helmet) }, MODEL, PROMPT);
    expect(requests[0]?.user).toContain("Giyim ve teçhizat: Giyim, üniforma, kişisel koruyucu donanım");
    expect(requests[0]?.user).toContain("helmet");
    expect(requests[0]?.user).toContain("hire");
  });

  it("leaves out ended matches, paused profiles and closed tenders", async () => {
    const { db } = testDb;
    await db.update(tenders).set({ submissionDeadline: sql`now() - interval '1 day'` }).where(eq(tenders.procedureKey, helmet));
    await db.update(profileMatches).set({ unmatchedAt: sql`now()` }).where(eq(profileMatches.tenderId, await tenderIdOf("ocds-h6vhtk-060198")));
    expect(await pendingTriage(db, 10)).toHaveLength(1);
    await db.update(criteriaProfiles).set({ active: false });
    expect(await pendingTriage(db, 10)).toEqual([]);
  });
});
