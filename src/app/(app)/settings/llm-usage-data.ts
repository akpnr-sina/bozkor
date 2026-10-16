import { and, desc, gte, isNotNull, lt, sql } from "drizzle-orm";
import { istanbulMonth, llmMonthlyBudgetUsd } from "@/analysis/budget";
import type { AppDb } from "@/db";
import { analyses, analysisKind } from "@/db/schema";

export type AnalysisKind = (typeof analysisKind.enumValues)[number];

export type KindUsage = {
  kind: AnalysisKind;
  /** Every recorded call: answered, invalid or failed. */
  calls: number;
  /** Calls the model answered; their output is stored, valid or not. */
  answered: number;
  /** Answered calls whose output did not pass the schema. */
  invalid: number;
  /** Calls that got no answer (API or network error); no output is stored. */
  apiErrors: number;
  costUsd: number;
};

export type LlmUsageSummary = {
  monthStart: Date;
  /** cost_usd of every call this month, failed and invalid ones included. */
  spentUsd: number;
  /** Null when LLM_MONTHLY_BUDGET_USD is malformed; budgetError says why. */
  budgetUsd: number | null;
  budgetError: string | null;
  exceeded: boolean;
  /** Triage, then deep analysis; both present even without calls. */
  kinds: KindUsage[];
  /** Invalid share of answered triage calls (Faz 4 acceptance); null before the first answer. */
  triageInvalidRate: number | null;
  /** Latest error of the month, from a failed call or an invalid answer. */
  lastError: { at: Date; kind: AnalysisKind; message: string } | null;
};

const ERROR_PREVIEW = 300;

function preview(message: string): string {
  const text = message.trim();
  return text.length > ERROR_PREVIEW ? `${text.slice(0, ERROR_PREVIEW).trimEnd()}...` : text;
}

/** LLM calls and spend in the Istanbul calendar month of `now`, for the settings page. */
export async function loadLlmUsage(db: AppDb, now: Date): Promise<LlmUsageSummary> {
  const { start, end } = istanbulMonth(now);
  const inMonth = and(gte(analyses.createdAt, start), lt(analyses.createdAt, end));

  let budgetUsd: number | null = null;
  let budgetError: string | null = null;
  try {
    budgetUsd = llmMonthlyBudgetUsd();
  } catch (error) {
    budgetError = error instanceof Error ? error.message : String(error);
  }

  const [rows, [latestError]] = await Promise.all([
    db
      .select({
        kind: analyses.kind,
        calls: sql<number>`count(*)::int`,
        answered: sql<number>`(count(*) filter (where ${analyses.output} is not null))::int`,
        invalid: sql<number>`(count(*) filter (where ${analyses.output} is not null and not ${analyses.valid}))::int`,
        apiErrors: sql<number>`(count(*) filter (where ${analyses.output} is null))::int`,
        costUsd: sql<string>`coalesce(sum(${analyses.costUsd}), 0)`,
      })
      .from(analyses)
      .where(inMonth)
      .groupBy(analyses.kind),
    db
      .select({ at: analyses.createdAt, kind: analyses.kind, error: analyses.error })
      .from(analyses)
      .where(and(inMonth, isNotNull(analyses.error)))
      .orderBy(desc(analyses.createdAt))
      .limit(1),
  ]);

  const kinds = analysisKind.enumValues.map((kind): KindUsage => {
    const row = rows.find((r) => r.kind === kind);
    return {
      kind,
      calls: row?.calls ?? 0,
      answered: row?.answered ?? 0,
      invalid: row?.invalid ?? 0,
      apiErrors: row?.apiErrors ?? 0,
      costUsd: Number(row?.costUsd ?? 0),
    };
  });
  // Amounts are whole micro-dollars; rounding drops floating point noise from the sum.
  const spentUsd = Math.round(kinds.reduce((sum, k) => sum + k.costUsd, 0) * 1_000_000) / 1_000_000;
  const triage = kinds.find((k) => k.kind === "triage");

  return {
    monthStart: start,
    spentUsd,
    budgetUsd,
    budgetError,
    exceeded: budgetUsd !== null && spentUsd >= budgetUsd,
    kinds,
    triageInvalidRate: triage?.answered ? triage.invalid / triage.answered : null,
    lastError: latestError?.error
      ? { at: latestError.at, kind: latestError.kind, message: preview(latestError.error) }
      : null,
  };
}
