import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { analyses, tenders } from "@/db/schema";
import { istanbulMonth, llmMonthlyBudgetUsd, monthlyLlmSpend } from "./budget";

const BUDGET = "LLM_MONTHLY_BUDGET_USD";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("llmMonthlyBudgetUsd", () => {
  it("defaults to 100 USD", () => {
    vi.stubEnv(BUDGET, undefined);
    expect(llmMonthlyBudgetUsd()).toBe(100);
    vi.stubEnv(BUDGET, "  ");
    expect(llmMonthlyBudgetUsd()).toBe(100);
  });

  it("reads plain amounts, zero included", () => {
    for (const [raw, expected] of [["250", 250], ["25.50", 25.5], [" 40 ", 40], ["0", 0]] as const) {
      vi.stubEnv(BUDGET, raw);
      expect(llmMonthlyBudgetUsd()).toBe(expected);
    }
  });

  it("rejects anything else with a message naming the variable", () => {
    for (const raw of ["abc", "-5", "1e3", "100 USD", "25,50"]) {
      vi.stubEnv(BUDGET, raw);
      expect(() => llmMonthlyBudgetUsd(), raw).toThrow(`${BUDGET} geçersiz: "${raw.trim()}"`);
    }
  });
});

describe("istanbulMonth", () => {
  it("starts and ends months at midnight in Istanbul", () => {
    // 21:30 UTC on 30 September is 00:30 on 1 October in Istanbul.
    expect(istanbulMonth(new Date("2026-09-30T21:30:00Z"))).toEqual({
      start: new Date("2026-09-30T21:00:00Z"),
      end: new Date("2026-10-31T21:00:00Z"),
    });
    expect(istanbulMonth(new Date("2026-09-30T20:59:59Z")).start).toEqual(new Date("2026-08-31T21:00:00Z"));
    expect(istanbulMonth(new Date("2026-12-15T12:00:00Z")).end).toEqual(new Date("2026-12-31T21:00:00Z"));
  });
});

describe("monthlyLlmSpend", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    await testDb.reset();
  });
  afterAll(async () => {
    await testDb.close();
  });

  async function seed(rows: { at: string; costUsd: number; valid?: boolean }[]) {
    const [tender] = await testDb.db
      .insert(tenders)
      .values({ source: "uk_fat", externalId: "000001-2026", procedureKey: "ocds-test-1", title: "Generators" })
      .returning({ id: tenders.id });
    await testDb.db.insert(analyses).values(
      rows.map((row) => ({
        tenderId: tender!.id,
        kind: "triage" as const,
        model: "claude-haiku-5-5",
        promptVersion: "triage.v1",
        valid: row.valid ?? true,
        costUsd: row.costUsd,
        createdAt: new Date(row.at),
      })),
    );
  }

  const october = new Date("2026-10-14T12:00:00Z");

  it("adds up every analysis of the Istanbul month, invalid ones included", async () => {
    vi.stubEnv(BUDGET, undefined);
    await seed([
      { at: "2026-09-30T20:59:59Z", costUsd: 1 }, // 23:59:59 on 30 September in Istanbul
      { at: "2026-09-30T21:30:00Z", costUsd: 2 }, // 00:30 on 1 October
      { at: "2026-10-14T10:00:00Z", costUsd: 0.25, valid: false },
      { at: "2026-10-31T21:00:00Z", costUsd: 4 }, // midnight starting 1 November
    ]);
    expect(await monthlyLlmSpend(testDb.db, october)).toEqual({
      spentUsd: 2.25,
      budgetUsd: 100,
      exceeded: false,
      monthStart: new Date("2026-09-30T21:00:00Z"),
    });
  });

  it("counts the budget as exceeded once spend reaches it", async () => {
    await seed([{ at: "2026-10-02T09:00:00Z", costUsd: 2.25 }]);
    vi.stubEnv(BUDGET, "2.25");
    expect(await monthlyLlmSpend(testDb.db, october)).toMatchObject({ spentUsd: 2.25, budgetUsd: 2.25, exceeded: true });
    vi.stubEnv(BUDGET, "2.26");
    expect(await monthlyLlmSpend(testDb.db, october)).toMatchObject({ exceeded: false });
  });

  it("is zero in a month without analyses and fails on a broken budget setting", async () => {
    vi.stubEnv(BUDGET, undefined);
    expect(await monthlyLlmSpend(testDb.db, october)).toMatchObject({ spentUsd: 0, exceeded: false });
    vi.stubEnv(BUDGET, "lots");
    await expect(monthlyLlmSpend(testDb.db, october)).rejects.toThrow(/LLM_MONTHLY_BUDGET_USD geçersiz/);
  });
});
