import { and, gte, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { analyses } from "@/db/schema";
import { toZonedLocal, zonedLocalToUtc } from "@/lib/time";

const BUDGET_ENV = "LLM_MONTHLY_BUDGET_USD";
const DEFAULT_BUDGET_USD = 100;

/** The budget month is the Istanbul calendar month. */
export const BUDGET_TIMEZONE = "Europe/Istanbul";

/**
 * Monthly LLM budget in USD from LLM_MONTHLY_BUDGET_USD, 100 when unset.
 * 0 is allowed and stops automatic analyses. Throws a Turkish message, meant
 * for the operator, when the value is not a plain non-negative amount.
 */
export function llmMonthlyBudgetUsd(): number {
  const raw = process.env[BUDGET_ENV]?.trim();
  if (!raw) return DEFAULT_BUDGET_USD;
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${BUDGET_ENV} geçersiz: "${raw}". 100 ya da 25.50 gibi, sıfır ya da pozitif bir USD tutarı olmalı.`);
  }
  return Number(raw);
}

const pad = (n: number) => String(n).padStart(2, "0");

function istanbulMidnight(year: number, month: number): Date {
  const date = zonedLocalToUtc(`${year}-${pad(month)}-01T00:00:00`, BUDGET_TIMEZONE);
  if (!date) throw new Error(`Cannot compute the start of ${year}-${pad(month)} in ${BUDGET_TIMEZONE}`);
  return date;
}

/** The Istanbul calendar month that `now` falls in, as [start, end) instants. */
export function istanbulMonth(now: Date): { start: Date; end: Date } {
  const local = toZonedLocal(now, BUDGET_TIMEZONE);
  const year = Number(local.slice(0, 4));
  const month = Number(local.slice(5, 7));
  return {
    start: istanbulMidnight(year, month),
    end: month === 12 ? istanbulMidnight(year + 1, 1) : istanbulMidnight(year, month + 1),
  };
}

export type MonthlySpend = {
  /** cost_usd of every analysis this month, invalid and failed calls included: the money was spent. */
  spentUsd: number;
  budgetUsd: number;
  /** Reaching the budget stops automatic analyses (CLAUDE.md rule 7). */
  exceeded: boolean;
  monthStart: Date;
};

/** LLM spend in the Istanbul calendar month of `now`, against the monthly budget. */
export async function monthlyLlmSpend(db: AppDb, now = new Date()): Promise<MonthlySpend> {
  const budgetUsd = llmMonthlyBudgetUsd();
  const { start, end } = istanbulMonth(now);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${analyses.costUsd}), 0)` })
    .from(analyses)
    .where(and(gte(analyses.createdAt, start), lt(analyses.createdAt, end)));
  const spentUsd = Number(row?.spent ?? 0);
  return { spentUsd, budgetUsd, exceeded: spentUsd >= budgetUsd, monthStart: start };
}
