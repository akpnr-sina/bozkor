import { eq, sql } from "drizzle-orm";
import { APIError } from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { analyses, criteriaProfiles, documents, tenderReviews, tenders } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { readStoredFacts } from "./facts-evidence";
import { extractFacts, FACTS_PROMPT_VERSION, loadFactsNotice, parseFacts, pendingFacts, runFacts } from "./facts";
import type { LlmClient, LlmRequest, LlmResponse } from "./llm";

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
const PROMPT = "Test olgu promptu";
const usage = { inputTokens: 4_000, outputTokens: 1_500, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

const reply = (body: unknown, stopReason = "end_turn"): LlmResponse => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  stopReason,
  refusalCategory: null,
  model: `${MODEL}-20261001`,
  usage,
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

/** What the model should answer for FaT 096535: the specification is in the notice document's description. */
const compressorFacts = facts({
  summaryTr: "Cornwall Havalimanı için yedek solunum havası kompresörü \u2014 devreye alma ve eğitimle.",
  lots: [
    lot({
      lotNumber: "1",
      productTr: "solunum havası kompresörü",
      category: "SAFETY_CRITICAL_MACHINERY",
      categoryQuote: "Procurement of Replacement BA Compressor",
      productNature: "SPECIALISED",
      natureQuote: "Maximum charging pressure of 300 Bar.",
    }),
  ],
  commissioningTraining: { value: "YES", detail: "Devreye alma, test ve eğitim", quote: "Supplier to provide commissioning, testing and operator training." },
  localService: { value: "REQUIRED", detail: "Birleşik Krallık merkezli servis", quote: "UK-based servicing and technical support available." },
  warranty: { years: 1, detail: "En az 12 ay", quote: "Minimum 12-month warranty from commissioning." },
  certifications: [
    { name: "BS EN 12021", level: "PRODUCT", quote: "Breathing air quality compliant with BS EN 12021" },
    { name: "UKCA", level: "PRODUCT", quote: "This quote is not in the notice" },
  ],
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;
const compressor = "ocds-h6vhtk-07867f";
const furniture = "ocds-h6vhtk-0785d5";

async function tenderIdOf(procedureKey: string) {
  const [row] = await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, procedureKey));
  return row!.id;
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
    fakeAdapter([[loadFixture("uk-fat", "uk4-policy-ba-compressor"), loadFixture("uk-fat", "uk4-policy-cafe-furniture")]]),
    { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-14T00:00:00Z") },
  );
  await db.update(tenders).set({ submissionDeadline: sql`now() + interval '30 days'` });
  // Breathing apparatus only: the compressor matches, the furniture does not.
  await db.insert(criteriaProfiles).values({ name: "Solunum", rules: profileRulesSchema.parse({ cpvInclude: ["351111"] }) });
  await rematch(db);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.close();
});

describe("pending facts", () => {
  it("covers open tenders with a current match and every decided tender", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const furnitureId = await tenderIdOf(furniture);
    expect(await pendingFacts(db, 10)).toEqual([compressorId]);

    await db.insert(tenderReviews).values({ tenderId: furnitureId, decision: "GO", decidedBy: "a@bozkor.com" });
    expect((await pendingFacts(db, 10)).sort()).toEqual([compressorId, furnitureId].sort());

    // A closed match is not worth a call; a decided tender is, for calibration.
    await db.update(tenders).set({ submissionDeadline: sql`now() - interval '1 day'` });
    expect(await pendingFacts(db, 10)).toEqual([furnitureId]);
  });
});

describe("extracting facts", () => {
  it("reads the notice with its document descriptions and stores checked quotes", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const { client, requests } = fakeLlm(() => reply(compressorFacts));

    const outcome = await extractFacts(db, client, compressorId, MODEL, PROMPT);
    expect(outcome.status).toBe("valid");
    expect(requests).toHaveLength(1);
    // The schema is too large for the API's output grammar: the prompt carries it.
    expect(requests[0]!.schema).toBeUndefined();
    expect(requests[0]!.system.startsWith(PROMPT)).toBe(true);
    expect(requests[0]!.system).toContain('"commissioningTraining"');
    expect(requests[0]!.system).toContain("SAFETY_CRITICAL_MACHINERY");
    expect(requests[0]!.effort).toBe("medium");
    expect(requests[0]!.maxTokens).toBe(16_000);
    expect(requests[0]!.user).toContain("<dokumanlar");
    expect(requests[0]!.user).toContain("Supplier to provide commissioning, testing and operator training.");

    const [row] = await db.select().from(analyses).where(eq(analyses.tenderId, compressorId));
    expect(row).toMatchObject({ kind: "facts", profileId: null, promptVersion: FACTS_PROMPT_VERSION, valid: true, model: `${MODEL}-20261001` });
    const stored = readStoredFacts(row!.output)!;
    expect(stored.facts.summaryTr).not.toContain("\u2014");
    expect(stored.quoteChecks?.facts.commissioningTraining).toBe("document:1");
    expect(stored.quoteChecks?.facts.localService).toBe("document:1");
    expect(stored.quoteChecks?.facts.installation).toBeNull();
    expect(stored.quoteChecks?.certifications).toEqual(["document:1", null]);
    expect(stored.quoteChecks?.lots[0]).toEqual({ category: "title", nature: "document:1", quantity: null });
    expect(stored.sourcesHash).toMatch(/^[0-9a-f]{64}$/);

    // Answered: not pending until the tender is written again, by a new
    // notice or by re-normalising or enrichment that set no changed_at.
    expect(stored.facts && (row!.output as { inputUpdatedAt?: string }).inputUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await pendingFacts(db, 10)).toEqual([]);
    // Past the one-hour wait between attempts and still not written since it was read.
    await db.update(analyses).set({ createdAt: sql`now() - interval '2 hours'` });
    expect(await pendingFacts(db, 10)).toEqual([]);
    // Written again, with no new notice (changed_at untouched).
    await db.update(tenders).set({ updatedAt: sql`now() + interval '1 minute'` }).where(eq(tenders.id, compressorId));
    expect(await pendingFacts(db, 10)).toEqual([compressorId]);
  });

  it("reads the text of the tender's files with the notice and records which it read", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const [spec] = await db
      .insert(documents)
      .values({
        tenderId: compressorId,
        origin: "manual",
        filename: "BA Compressor Specification.pdf",
        mime: "application/pdf",
        sizeBytes: 1_000,
        sha256: "a".repeat(64),
        storagePath: `${compressorId}/spec.pdf`,
        fetchStatus: "fetched",
        pageCount: 2,
        textContent: "1. Scope\fThe compressor shall be delivered with a 24-month warranty from commissioning.",
        processedAt: new Date(),
      })
      .returning({ id: documents.id });
    const fromFile = { ...compressorFacts, warranty: { years: 2, detail: "Devreye almadan itibaren 24 ay", quote: "delivered with a 24-month warranty from commissioning" } };
    const { client, requests } = fakeLlm(() => reply(fromFile));

    expect((await extractFacts(db, client, compressorId, MODEL, PROMPT)).status).toBe("valid");

    expect(requests[0]!.user).toContain('<dosya sira="1" ad="BA Compressor Specification.pdf" tur="pdf">');
    const [row] = await db.select().from(analyses).where(eq(analyses.tenderId, compressorId));
    expect(row!.documentIds).toEqual([spec!.id]);
    expect(readStoredFacts(row!.output)!.quoteChecks?.facts.warranty).toBe("file:1:p2");
  });

  it("reads a tender again once its files change, without waiting out the hour", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const { client } = fakeLlm(() => reply(compressorFacts));
    expect((await extractFacts(db, client, compressorId, MODEL, PROMPT)).status).toBe("valid");
    expect(await pendingFacts(db, 10)).toEqual([]);

    // A file was read after the facts call; its notice did not change.
    await db.update(tenders).set({ documentsChangedAt: sql`now()`, updatedAt: sql`${tenders.updatedAt}` }).where(eq(tenders.id, compressorId));
    expect(await pendingFacts(db, 10, { settleMinutes: 0 })).toEqual([compressorId]);

    // Read again with the files: answered until they change once more.
    expect((await extractFacts(db, client, compressorId, MODEL, PROMPT)).status).toBe("valid");
    expect(await pendingFacts(db, 10, { settleMinutes: 0 })).toEqual([]);
  });

  it("waits while a tender's files are being read, and a few minutes after they changed", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const [unread] = await db
      .insert(documents)
      .values({ tenderId: compressorId, origin: "manual", filename: "spec.pdf", storagePath: `${compressorId}/s.pdf`, fetchStatus: "fetched" })
      .returning({ id: documents.id });
    // Being read: another call would follow at once.
    expect(await pendingFacts(db, 10, { settleMinutes: 0 })).toEqual([]);

    await db.update(documents).set({ processedAt: sql`now()` }).where(eq(documents.id, unread!.id));
    await db.update(tenders).set({ documentsChangedAt: sql`now() - interval '2 minutes'`, updatedAt: sql`${tenders.updatedAt}` }).where(eq(tenders.id, compressorId));
    expect(await pendingFacts(db, 10)).toEqual([]);
    await db.update(tenders).set({ documentsChangedAt: sql`now() - interval '6 minutes'`, updatedAt: sql`${tenders.updatedAt}` }).where(eq(tenders.id, compressorId));
    expect(await pendingFacts(db, 10)).toEqual([compressorId]);
  });

  it("reads only the documents the notice gave, not uploaded files or ZIP members", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const before = await loadFactsNotice(db, compressorId);
    const [zip] = await db
      .insert(documents)
      .values({ tenderId: compressorId, origin: "manual", filename: "ihale.zip", storagePath: `${compressorId}/a.zip`, fetchStatus: "fetched" })
      .returning({ id: documents.id });
    await db.insert(documents).values([
      { tenderId: compressorId, origin: "manual", filename: "Şartname.pdf", parentDocumentId: zip!.id, fetchStatus: "fetched" },
      { tenderId: compressorId, origin: "auto", filename: "spec.pdf", parentDocumentId: zip!.id, fetchStatus: "fetched" },
    ]);

    const after = await loadFactsNotice(db, compressorId);
    expect(after!.notice.documents).toEqual(before!.notice.documents);
    expect(after!.notice.documents!.length).toBeGreaterThan(0);
  });

  it("leaves a tender pending when it is written while the model answers", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const { client } = fakeLlm(async () => {
      // Enrichment or a sync writes the tender meanwhile.
      await db.update(tenders).set({ updatedAt: sql`now() + interval '1 second'` }).where(eq(tenders.id, compressorId));
      return reply(compressorFacts);
    });
    expect((await extractFacts(db, client, compressorId, MODEL, PROMPT)).status).toBe("valid");
    // Past the one-hour wait between attempts, the answer counts as older than the tender.
    await db.update(analyses).set({ createdAt: sql`now() - interval '2 hours'` });
    expect(await pendingFacts(db, 10)).toEqual([compressorId]);
  });

  it("reads an answer wrapped in a code fence", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const { client } = fakeLlm(() => reply("```json\n" + JSON.stringify(compressorFacts) + "\n```"));
    expect((await extractFacts(db, client, compressorId, MODEL, PROMPT)).status).toBe("valid");
  });

  it("retries an answer with the wrong lots once, then records it as invalid", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf(compressor);
    const wrongLots = { ...compressorFacts, lots: [{ ...compressorFacts.lots[0]!, lotNumber: "2" }] };
    const { client, requests } = fakeLlm(() => reply(wrongLots));

    const outcome = await extractFacts(db, client, compressorId, MODEL, PROMPT);
    expect(outcome.status).toBe("invalid");
    expect(requests).toHaveLength(2);
    const rows = await db.select().from(analyses).where(eq(analyses.tenderId, compressorId));
    expect(rows.map((r) => r.valid)).toEqual([false, false]);
    expect(rows[1]!.error).toContain("Lotlar girdiyle eşleşmiyor");
  });

  it("stops at once when the Anthropic account is out of credit", async () => {
    const { db } = testDb;
    await db.update(tenders).set({ submissionDeadline: sql`now() + interval '30 days'` });
    const { client, requests } = fakeLlm(() => {
      throw new APIError(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "400 Your credit balance is too low to access the Anthropic API.", new Headers());
    });
    const stats = await runFacts(db, client, { model: MODEL, prompt: PROMPT, concurrency: 1, log: () => {} });
    expect(stats).toMatchObject({ attempted: 1, apiErrors: 1, stoppedBy: "credit" });
    expect(requests).toHaveLength(1);
  });

  it("runs the pending tenders within the budget", async () => {
    const { db } = testDb;
    const { client } = fakeLlm(() => reply(compressorFacts));
    const stats = await runFacts(db, client, { model: MODEL, prompt: PROMPT, concurrency: 1 });
    expect(stats).toMatchObject({ attempted: 1, valid: 1, invalid: 0, apiErrors: 0, stoppedBy: null });
  });
});

describe("parseFacts", () => {
  it("wants every lot that was sent, in order, each with a product", () => {
    expect(parseFacts(compressorFacts, ["1"])).toMatchObject({ ok: true });
    expect(parseFacts(compressorFacts, ["1", "2"])).toMatchObject({ ok: false });
    const blank = { ...compressorFacts, lots: [{ ...compressorFacts.lots[0]!, productTr: " " }] };
    expect(parseFacts(blank, ["1"])).toMatchObject({ ok: false, error: "Bir lotun ürün açıklaması boş." });
    expect(parseFacts({ summaryTr: "eksik" }, ["1"])).toMatchObject({ ok: false });
  });

  it("wants obligations to name lots that were sent, compared as labels", () => {
    const twoLots = (installationLots: string[]) => ({
      ...compressorFacts,
      lots: [
        { ...compressorFacts.lots[0]!, lotNumber: "LOT-0001" },
        { ...compressorFacts.lots[0]!, lotNumber: "LOT-0002" },
      ],
      installation: { value: "REQUIRED", detail: "", quote: "", lots: installationLots },
    });
    expect(parseFacts(twoLots(["LOT-0002"]), ["LOT-0001", "LOT-0002"])).toMatchObject({ ok: true });
    expect(parseFacts(twoLots(["2"]), ["LOT-0001", "LOT-0002"])).toMatchObject({ ok: true });
    expect(parseFacts(twoLots(["Lot 2"]), ["LOT-0001", "LOT-0002"])).toMatchObject({
      ok: false,
      error: "installation girdide olmayan lotları anıyor: Lot 2.",
    });
  });
});
