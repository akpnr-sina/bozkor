import { and, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { analyses, deepRequests, documents, tenders } from "@/db/schema";
import { latestDeepRequests, type DeepRequest } from "./deep-requests";
import { readStoredDeep, type StoredDeep } from "./deep-schema";
import { inputChangedAt } from "./facts";
import { monthlyLlmSpend } from "./budget";

// What the tender page shows of the deep analysis: the latest result, the
// request in flight or the last one that failed, and the month's spend (a
// manual analysis past the budget runs, with a warning: CLAUDE.md rule 7).

export type DeepResult = StoredDeep & {
  analysisId: string;
  createdAt: Date;
  model: string;
  /** All the calls of the analysis that gave this result, their parts and the merge. */
  costUsd: number;
  /** The files the analysis read, by their number in its input ("file:<n>" in quoteChecks). */
  files: { n: number; documentId: string; name: string }[];
  /** The notice or the files changed after the analysis read them. */
  stale: boolean;
};

export type DeepView = {
  /** What stands now: never asked, waiting, being read, read (result), or the last request failed (result may be an older one). */
  state: "none" | "queued" | "running" | "done" | "failed";
  request: Pick<DeepRequest, "status" | "requestedBy" | "requestedAt" | "startedAt" | "finishedAt" | "error"> | null;
  result: DeepResult | null;
  budget: { spentUsd: number; budgetUsd: number };
};

export async function loadDeepView(db: AppDb, tenderId: string): Promise<DeepView> {
  const [requests, [latest], [tender], budget] = await Promise.all([
    latestDeepRequests(db, [tenderId]),
    // The parts of an analysis read in parts are recorded as deep analyses too; the result is the one with quote checks.
    db
      .select()
      .from(analyses)
      .where(and(eq(analyses.tenderId, tenderId), eq(analyses.kind, "deep"), eq(analyses.valid, true), resultOutput))
      .orderBy(desc(analyses.createdAt))
      .limit(1),
    db.select({ updatedAt: tenders.updatedAt, documentsChangedAt: tenders.documentsChangedAt }).from(tenders).where(eq(tenders.id, tenderId)),
    monthlyLlmSpend(db),
  ]);
  const request = requests.get(tenderId) ?? null;
  const stored = latest ? readStoredDeep(latest.output) : null;
  let result: DeepResult | null = null;
  if (latest && stored) {
    const ids = latest.documentIds;
    const names = ids.length
      ? await db.select({ id: documents.id, filename: documents.filename, title: documents.title }).from(documents).where(inArray(documents.id, ids))
      : [];
    const nameOf = new Map(names.map((d) => [d.id, d.filename ?? d.title ?? "dosya"]));
    result = {
      ...stored,
      analysisId: latest.id,
      createdAt: latest.createdAt,
      model: latest.model,
      costUsd: await deepCost(db, tenderId, latest),
      // The files read, by the number the analysis gave them: a file left out (a part with no valid answer) is no file
      // read, a deleted one keeps its number without its name.
      files: ids
        .map((documentId, i) => ({ n: i + 1, documentId, name: nameOf.get(documentId) ?? "silinmiş dosya" }))
        .filter((f) => !stored.skipped.some((s) => s.documentId === f.documentId)),
      stale: tender ? inputChangedAt(tender).getTime() > new Date(stored.inputUpdatedAt).getTime() : false,
    };
  }
  const state: DeepView["state"] = request?.status ?? (result ? "done" : "none");
  return {
    state: state === "done" && !result ? "none" : state,
    request: request && { status: request.status, requestedBy: request.requestedBy, requestedAt: request.requestedAt, startedAt: request.startedAt, finishedAt: request.finishedAt, error: request.error },
    result,
    budget: { spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd },
  };
}

/** A stored result (StoredDeep), not a part's answer. */
const resultOutput = sql`${analyses.output} -> 'quoteChecks' is not null`;

/**
 * The cost of the analysis that gave a result: the calls of the request that
 * asked for it (its parts, the merge, their retries), from when it started
 * to the result. A result made by hand (pnpm deep) has no request: then the
 * calls since the previous result.
 */
async function deepCost(db: AppDb, tenderId: string, result: { id: string; createdAt: Date }): Promise<number> {
  const [request] = await db.select({ startedAt: deepRequests.startedAt }).from(deepRequests).where(eq(deepRequests.analysisId, result.id)).limit(1);
  let from: Date | null = request?.startedAt ?? null;
  if (!from) {
    const [previous] = await db
      .select({ createdAt: analyses.createdAt })
      .from(analyses)
      .where(and(eq(analyses.tenderId, tenderId), eq(analyses.kind, "deep"), eq(analyses.valid, true), resultOutput, lt(analyses.createdAt, result.createdAt)))
      .orderBy(desc(analyses.createdAt))
      .limit(1);
    from = previous?.createdAt ?? null;
  }
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${analyses.costUsd}), 0)` })
    .from(analyses)
    .where(
      and(
        eq(analyses.tenderId, tenderId),
        eq(analyses.kind, "deep"),
        lte(analyses.createdAt, result.createdAt),
        from ? (request?.startedAt ? gte(analyses.createdAt, from) : gt(analyses.createdAt, from)) : undefined,
      ),
    );
  return Math.round(Number(row?.total ?? 0) * 1_000_000) / 1_000_000;
}
