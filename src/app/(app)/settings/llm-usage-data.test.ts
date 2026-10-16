import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../../../tests/helpers/test-db";
import { monthlyLlmSpend } from "@/analysis/budget";
import { analyses, tenders } from "@/db/schema";
import { loadLlmUsage } from "./llm-usage-data";

const BUDGET = "LLM_MONTHLY_BUDGET_USD";
const october = new Date("2026-10-14T12:00:00Z");

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  vi.stubEnv(BUDGET, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await testDb.close();
});

type Row = {
  at: string;
  kind?: "triage" | "deep";
  output?: unknown;
  valid?: boolean;
  costUsd?: number;
  error?: string | null;
};

async function seed(rows: Row[]) {
  const [tender] = await testDb.db
    .insert(tenders)
    .values({ source: "uk_fat", externalId: "000001-2026", procedureKey: "ocds-test-1", title: "Generators" })
    .returning({ id: tenders.id });
  await testDb.db.insert(analyses).values(
    rows.map((row) => ({
      tenderId: tender!.id,
      kind: row.kind ?? ("triage" as const),
      model: "claude-haiku-5-5",
      promptVersion: "triage.v1",
      output: row.output ?? null,
      valid: row.valid ?? false,
      costUsd: row.costUsd ?? 0,
      error: row.error ?? null,
      createdAt: new Date(row.at),
    })),
  );
}

const overloaded = `529 Overloaded: ${"the API is busy, retry later. ".repeat(20)}`;

// A month of calls: one valid and one invalid triage answer, a triage call
// that got no answer, a deep analysis, and a September call that must not count.
const month: Row[] = [
  { at: "2026-10-02T09:00:00Z", output: { relevance: 72 }, valid: true, costUsd: 0.002 },
  { at: "2026-10-03T09:00:00Z", output: "not json", valid: false, costUsd: 0.001, error: "Output does not match the schema" },
  { at: "2026-10-04T09:00:00Z", kind: "deep", output: { summaryTr: "Özet" }, valid: true, costUsd: 0.5 },
  { at: "2026-10-05T09:00:00Z", output: null, valid: false, costUsd: 0, error: overloaded },
  // 23:00 on 30 September in Istanbul.
  { at: "2026-09-30T20:00:00Z", output: null, valid: false, costUsd: 1, error: "September" },
];

describe("loadLlmUsage", () => {
  it("separates answered, invalid and failed calls per kind for the Istanbul month", async () => {
    await seed(month);
    const usage = await loadLlmUsage(testDb.db, october);

    expect(usage.monthStart).toEqual(new Date("2026-09-30T21:00:00Z"));
    expect(usage.kinds).toEqual([
      { kind: "triage", calls: 3, answered: 2, invalid: 1, apiErrors: 1, costUsd: 0.003 },
      { kind: "deep", calls: 1, answered: 1, invalid: 0, apiErrors: 0, costUsd: 0.5 },
      { kind: "translation", calls: 0, answered: 0, invalid: 0, apiErrors: 0, costUsd: 0 },
      { kind: "facts", calls: 0, answered: 0, invalid: 0, apiErrors: 0, costUsd: 0 },
    ]);
    // Only answered calls count toward the invalid output rate.
    expect(usage.triageInvalidRate).toBe(0.5);
    expect(usage).toMatchObject({ spentUsd: 0.503, budgetUsd: 100, budgetError: null, exceeded: false });
    expect(usage.spentUsd).toBe((await monthlyLlmSpend(testDb.db, october)).spentUsd);
  });

  it("shows the latest error of the month, shortened", async () => {
    await seed(month);
    const { lastError } = await loadLlmUsage(testDb.db, october);
    expect(lastError?.at).toEqual(new Date("2026-10-05T09:00:00Z"));
    expect(lastError?.kind).toBe("triage");
    expect(lastError?.message.startsWith("529 Overloaded: the API is busy")).toBe(true);
    expect(lastError?.message.endsWith("...")).toBe(true);
    expect(lastError?.message.length).toBeLessThanOrEqual(303);
  });

  it("reports a reached budget", async () => {
    await seed(month);
    vi.stubEnv(BUDGET, "0.5");
    expect(await loadLlmUsage(testDb.db, october)).toMatchObject({ spentUsd: 0.503, budgetUsd: 0.5, exceeded: true });
  });

  it("still shows usage when the budget setting is broken", async () => {
    await seed(month);
    vi.stubEnv(BUDGET, "yüz dolar");
    const usage = await loadLlmUsage(testDb.db, october);
    expect(usage).toMatchObject({ spentUsd: 0.503, budgetUsd: null, exceeded: false });
    expect(usage.budgetError).toMatch(/LLM_MONTHLY_BUDGET_USD geçersiz/);
  });

  it("is empty in a month without calls", async () => {
    const usage = await loadLlmUsage(testDb.db, october);
    expect(usage).toMatchObject({ spentUsd: 0, exceeded: false, triageInvalidRate: null, lastError: null });
    expect(usage.kinds.map((k) => [k.kind, k.calls])).toEqual([
      ["triage", 0],
      ["deep", 0],
      ["translation", 0],
      ["facts", 0],
    ]);
  });
});
