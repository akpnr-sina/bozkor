import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { loadFixture } from "../../tests/helpers/fixtures";
import { createTestDb } from "../../tests/helpers/test-db";
import { extractFacts } from "@/analysis/facts";
import type { FactsOutput } from "@/analysis/facts-schema";
import type { LlmClient } from "@/analysis/llm";
import { analyses, assessmentHistory, fxRates, tenderAssessments, tenders } from "@/db/schema";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { fillValueEur } from "@/sources/value-eur";
import { assessOne, assessTenders } from "./assess";
import { POLICY } from "./policy";

const adapter: SourceAdapter = {
  id: "uk_fat",
  async *pages() {
    yield [loadFixture("uk-fat", "uk4-policy-ba-compressor"), loadFixture("uk-fat", "uk4-policy-cafe-furniture")];
  },
  keys: fatNoticeKeys,
  normalize: normalizeFatRelease,
};

/** The day the team reviewed FaT 096535; its deadline was three working days later. */
const REVIEWED = new Date("2026-10-15T09:00:00+03:00");

const compressorLot = lot({
  lotNumber: "1",
  productTr: "solunum havası kompresörü",
  category: "SAFETY_CRITICAL_MACHINERY",
  categoryQuote: "Procurement of Replacement BA Compressor",
  productNature: "SPECIALISED",
  natureQuote: "Maximum charging pressure of 300 Bar.",
});

const compressorFacts = facts({
  lots: [compressorLot],
  commissioningTraining: { value: "YES", detail: "Devreye alma, test ve eğitim", quote: "Supplier to provide commissioning, testing and operator training." },
  localService: { value: "REQUIRED", detail: "Birleşik Krallık merkezli servis", quote: "UK-based servicing and technical support available." },
});

let testDb: Awaited<ReturnType<typeof createTestDb>>;

async function tenderIdOf(procedureKey: string) {
  const [row] = await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.procedureKey, procedureKey));
  return row!.id;
}

/** Stores facts as a valid facts analysis, through the real extraction with a model that answers `answer`. */
async function storeFacts(tenderId: string, answer: FactsOutput) {
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
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await testDb.close();
});

describe("assessTenders", () => {
  it("stores the verdict of the most promising lot, with its blocking gates and a history row", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(id, compressorFacts);

    const stats = await assessTenders(db, { now: REVIEWED });
    expect(stats).toMatchObject({ assessed: 1, changed: 1, statusChanged: 1, byStatus: { COMMERCIAL_NO_BID: 1 } });
    const [row] = await db.select().from(tenderAssessments).where(eq(tenderAssessments.tenderId, id));
    expect(row).toMatchObject({ status: "COMMERCIAL_NO_BID", bestLot: "1", policyVersion: POLICY.version });
    expect(row!.blocking).toEqual(expect.arrayContaining(["H05", "C02"]));
    expect(row!.explanation).toContain("ürün teslimine ek olarak yerinde servis ve sahada devreye alma ya da eğitim istiyor");
    expect(row!.fitLow).toBeLessThanOrEqual(row!.fitHigh);
    expect(await db.select().from(assessmentHistory)).toHaveLength(1);
  });

  it("writes nothing when nothing changed, and records a change of status", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(id, compressorFacts);
    await assessTenders(db, { now: REVIEWED });

    expect(await assessTenders(db, { now: REVIEWED })).toMatchObject({ assessed: 1, changed: 0, statusChanged: 0 });

    const later = new Date("2026-10-21T09:00:00+03:00");
    expect(await assessTenders(db, { now: later })).toMatchObject({ changed: 1, statusChanged: 1, byStatus: { EXPIRED: 1 } });
    const [row] = await db.select().from(tenderAssessments).where(eq(tenderAssessments.tenderId, id));
    expect(row).toMatchObject({ status: "EXPIRED", statusChangedAt: later, assessedAt: later });
    const history = await db.select().from(assessmentHistory).orderBy(assessmentHistory.createdAt);
    expect(history.map((h) => h.status)).toEqual(["COMMERCIAL_NO_BID", "EXPIRED"]);
  });

  it("does not act on a fact whose quote is not in the notice", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(
      id,
      facts({
        ...compressorFacts,
        commissioningTraining: { value: "YES", detail: "", quote: "The supplier shall commission the unit on site." },
        localService: { value: "REQUIRED", detail: "", quote: "A local service engineer must attend within 4 hours." },
      }),
    );
    await assessTenders(db, { now: REVIEWED });
    const [row] = await db.select().from(tenderAssessments).where(eq(tenderAssessments.tenderId, id));
    expect(row!.status).toBe("NEEDS_DOCUMENTS");
  });

  it("assesses again under a new policy version and keeps the earlier verdict in the history", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(id, compressorFacts);
    await assessTenders(db, { now: REVIEWED });
    // On-site work allowed again and a UK service partner signed up: the tender reopens.
    const withPartner = { ...POLICY, version: "policy.test", supplyOnly: false, servicePartnerCountries: ["GB"] };
    expect(await assessTenders(db, { now: REVIEWED, policy: withPartner })).toMatchObject({ changed: 1, statusChanged: 1 });
    const history = await db.select().from(assessmentHistory).orderBy(assessmentHistory.createdAt);
    expect(history.map((h) => [h.policyVersion, h.status])).toEqual([
      [POLICY.version, "COMMERCIAL_NO_BID"],
      ["policy.test", "NEEDS_DOCUMENTS"],
    ]);
  });

  it("assesses only tenders with valid facts, and writes nothing on a dry run", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    expect(await assessTenders(db, { now: REVIEWED })).toMatchObject({ assessed: 0 });
    await storeFacts(id, compressorFacts);
    expect(await assessTenders(db, { now: REVIEWED, dryRun: true })).toMatchObject({ assessed: 1, changed: 1 });
    expect(await db.select().from(tenderAssessments)).toEqual([]);
    expect(await assessTenders(db, { now: REVIEWED, tenderIds: [id] })).toMatchObject({ assessed: 1, changed: 1 });
  });

  it("assesses only what changed since: new facts or a notice written again, and the tenders it is given", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(id, compressorFacts);
    const age = () => db.execute(sql`update analyses set created_at = now() - interval '1 hour'`);
    await age();
    await db.execute(sql`update tenders set updated_at = now() - interval '1 hour'`);
    const before = new Date(Date.now() - 1_000);
    expect(await assessTenders(db, { now: REVIEWED, changedSince: before })).toMatchObject({ assessed: 0 });

    await storeFacts(id, compressorFacts);
    expect(await assessTenders(db, { now: REVIEWED, changedSince: before })).toMatchObject({ assessed: 1 });
    await age();
    // Drizzle's update stamps updated_at, as the sync's upsert does.
    await db.update(tenders).set({ title: "Replacement BA Compressor" }).where(eq(tenders.id, id));
    expect(await assessTenders(db, { now: REVIEWED, changedSince: before })).toMatchObject({ assessed: 1 });
    const later = new Date(Date.now() + 60_000);
    expect(await assessTenders(db, { now: REVIEWED, changedSince: later })).toMatchObject({ assessed: 0 });
    expect(await assessTenders(db, { now: REVIEWED, changedSince: later, tenderIds: [id] })).toMatchObject({ assessed: 1 });
  });

  it("writes one history row when two runs overlap", async () => {
    const { db } = testDb;
    await storeFacts(await tenderIdOf("ocds-h6vhtk-07867f"), compressorFacts);
    await Promise.all([assessTenders(db, { now: REVIEWED }), assessTenders(db, { now: REVIEWED })]);
    expect(await db.select().from(tenderAssessments)).toHaveLength(1);
    expect(await db.select().from(assessmentHistory)).toHaveLength(1);
  });

  it("goes on past a tender whose data breaks the assessment, and logs it", async () => {
    const { db } = testDb;
    const compressorId = await tenderIdOf("ocds-h6vhtk-07867f");
    const furnitureId = await tenderIdOf("ocds-h6vhtk-0785d5");
    await storeFacts(compressorId, compressorFacts);
    await storeFacts(furnitureId, facts({ lots: [lot({ lotNumber: "1", productTr: "kafe mobilyası", category: "FURNITURE_STORAGE" })] }));
    await db.execute(sql`update tenders set details = '{"awardCriteria": "bozuk"}'::jsonb where id = ${furnitureId}`);
    const logged: string[] = [];
    const stats = await assessTenders(db, { now: REVIEWED, log: (m) => logged.push(m) });
    expect(stats).toMatchObject({ assessed: 1, errors: 1, byStatus: { COMMERCIAL_NO_BID: 1 } });
    expect(logged.join("\n")).toContain(furnitureId);
  });

  it("removes a verdict whose latest facts can no longer be read", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-07867f");
    await storeFacts(id, compressorFacts);
    await assessTenders(db, { now: REVIEWED });
    await db.insert(analyses).values({ tenderId: id, kind: "facts", model: "m", promptVersion: "facts.v0", output: { summaryTr: "eski biçim" }, valid: true });
    expect(await assessTenders(db, { now: REVIEWED, dryRun: true })).toMatchObject({ assessed: 0, removed: 1 });
    expect(await db.select().from(tenderAssessments)).toHaveLength(1);
    expect(await assessTenders(db, { now: REVIEWED })).toMatchObject({ assessed: 0, removed: 1 });
    expect(await db.select().from(tenderAssessments)).toEqual([]);
    expect(await db.select().from(assessmentHistory)).toHaveLength(1);
  });

  it("uses lot values in EUR and the tender's structured details", async () => {
    const { db } = testDb;
    const id = await tenderIdOf("ocds-h6vhtk-0785d5");
    const [tender] = await db.select().from(tenders).where(eq(tenders.id, id));
    expect(tender!.details?.durationMonths).toBe(1.9);
    await storeFacts(
      id,
      facts({
        lots: [lot({ lotNumber: "1", productTr: "dış mekân kafe mobilyası", category: "FURNITURE_STORAGE", categoryQuote: "High quality contemporary external cafe furniture" })],
      }),
    );
    await assessTenders(db, { now: REVIEWED });
    const [row] = await db.select().from(tenderAssessments).where(eq(tenderAssessments.tenderId, id));
    expect(row!.status).toBe("NEEDS_DOCUMENTS");

    const one = await assessOne(db, id, { now: REVIEWED });
    // 12,500 GBP at 0.87 GBP per EUR.
    expect(one!.assessment.best.valueEur).toBeCloseTo(14_367.8, 0);
    expect(one!.assessment.best.segment).toBe("B");
    // The runs read only the columns the policy needs, and come to the same verdict as the whole rows.
    const best = one!.assessment.best;
    expect(row).toMatchObject({
      explanation: best.explanation,
      fitLow: best.scores.fit.low,
      fitHigh: best.scores.fit.high,
      preliminaryLow: best.scores.preliminary.low,
      preliminaryHigh: best.scores.preliminary.high,
      confidence: best.confidence,
    });
    expect(one!.assessment.best.dimensions.H.notes[0]).toBe("Fiyat ve kalite birlikte değerlendiriliyor: Price %60, Quality %40.");
    expect(one!.latest.stored.quoteChecks?.lots[0]?.category).toBe("description");
    expect(await assessOne(db, await tenderIdOf("ocds-h6vhtk-07867f"))).toBeNull();
  });
});
