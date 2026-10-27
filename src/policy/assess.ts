import { and, asc, eq, gt, gte, inArray, or, sql } from "drizzle-orm";
import { evidencedFacts, readStoredFacts, type ReadFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import type { AppDb } from "@/db";
import { analyses, assessmentHistory, lots, tenderAssessments, tenders, type Lot, type Tender, type TenderAssessmentRow } from "@/db/schema";
import { loadRateTable, type RateTable } from "@/fx/rates";
import { valueInEur } from "@/sources/value-eur";
import { assessTender, type GateId, type PolicyInput, type Status, type TenderAssessment } from "./engine";
import { POLICY, type Policy } from "./policy";

// Applies the qualification policy to tenders with facts and keeps the verdict
// in tender_assessments. Pure apart from the reads. The worker assesses the
// tenders a facts run or a sync changed right after it, and every tender once
// an Istanbul day: the time left changes statuses by the day (working days to
// the deadline), and a new policy version reassesses everything on the first
// run after the worker restarts.

/** The tender and lot columns the policy reads; the runs select only these (long texts are most of a row). */
type PolicyTender = Pick<Tender, "valueEur" | "submissionDeadline" | "buyerCountry" | "noticeLanguage" | "details" | "publishedAt">;
type PolicyLot = Pick<Lot, "lotNumber" | "valueAmount" | "valueCurrency">;

/** The engine's input from stored rows; lot values in EUR at the ECB rate of the publication day. */
export function policyInputOf(tender: PolicyTender, lotRows: readonly PolicyLot[], facts: FactsOutput, rates: RateTable, now: Date): PolicyInput {
  return {
    tender: {
      valueEur: tender.valueEur,
      submissionDeadline: tender.submissionDeadline,
      buyerCountry: tender.buyerCountry,
      noticeLanguage: tender.noticeLanguage,
      details: tender.details ?? null,
    },
    lots: lotRows.map((l) => ({ lotNumber: l.lotNumber, valueEur: valueInEur(l.valueAmount, l.valueCurrency, tender.publishedAt, rates) })),
    facts,
    now,
  };
}

export type LatestFacts = {
  analysisId: string;
  createdAt: Date;
  /** The files the facts call read, in the order of its "file:<n>" quote sources. */
  documentIds: string[];
  /** The answer as stored, with its quote checks. */
  stored: ReadFacts;
  /** What the policy acts on (see evidencedFacts). */
  facts: FactsOutput;
};

/** The latest valid facts of each tender. */
export async function latestFacts(db: AppDb, tenderIds: readonly string[]): Promise<Map<string, LatestFacts>> {
  if (!tenderIds.length) return new Map();
  const rows = await db
    .selectDistinctOn([analyses.tenderId], {
      id: analyses.id,
      tenderId: analyses.tenderId,
      output: analyses.output,
      createdAt: analyses.createdAt,
      documentIds: analyses.documentIds,
    })
    .from(analyses)
    .where(and(inArray(analyses.tenderId, [...tenderIds]), eq(analyses.kind, "facts"), eq(analyses.valid, true)))
    .orderBy(analyses.tenderId, sql`${analyses.createdAt} desc`);
  const result = new Map<string, LatestFacts>();
  for (const row of rows) {
    const read = readStoredFacts(row.output);
    if (read) {
      result.set(row.tenderId, {
        analysisId: row.id,
        createdAt: row.createdAt,
        documentIds: row.documentIds,
        stored: read,
        facts: evidencedFacts(read.facts, read.quoteChecks),
      });
    }
  }
  return result;
}

/**
 * The full lot-level assessment of one tender from its latest facts, worked
 * out now: what the detail page shows. Null without valid facts.
 */
export async function assessOne(
  db: AppDb,
  tenderId: string,
  options: { now?: Date; policy?: Policy } = {},
): Promise<{ assessment: TenderAssessment; latest: LatestFacts } | null> {
  const [latest, [tender], lotRows, rates] = await Promise.all([
    latestFacts(db, [tenderId]).then((m) => m.get(tenderId)),
    db.select().from(tenders).where(eq(tenders.id, tenderId)),
    db.select().from(lots).where(eq(lots.tenderId, tenderId)),
    loadRateTable(db),
  ]);
  if (!latest || !tender) return null;
  const input = policyInputOf(tender, lotRows, latest.facts, rates, options.now ?? new Date());
  return { assessment: assessTender(input, options.policy ?? POLICY), latest };
}

type Summary = Omit<TenderAssessmentRow, "tenderId" | "assessedAt" | "statusChangedAt">;

function summaryOf(assessment: TenderAssessment, factsAnalysisId: string): Summary {
  const best = assessment.best;
  return {
    factsAnalysisId,
    policyVersion: assessment.policyVersion,
    status: best.status,
    bestLot: best.lotNumber,
    explanation: best.explanation,
    blocking: best.gates.filter((g) => g.state === "FAIL").map((g) => g.id),
    fitLow: best.scores.fit.low,
    fitHigh: best.scores.fit.high,
    preliminaryLow: best.scores.preliminary.low,
    preliminaryHigh: best.scores.preliminary.high,
    confidence: best.confidence,
  };
}

const SUMMARY_KEYS = [
  "factsAnalysisId",
  "policyVersion",
  "status",
  "bestLot",
  "explanation",
  "blocking",
  "fitLow",
  "fitHigh",
  "preliminaryLow",
  "preliminaryHigh",
  "confidence",
] as const satisfies readonly (keyof Summary)[];

function sameSummary(a: Summary, b: Summary): boolean {
  return SUMMARY_KEYS.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

export type AssessStats = {
  assessed: number;
  /** Rows written: new assessments and changed ones. */
  changed: number;
  /** New assessments and changes of status, lot or policy version, each also in assessment_history. */
  statusChanged: number;
  /** Tenders whose assessment failed; logged, the others go on. */
  errors: number;
  /** Assessments removed because their tender's latest facts can no longer be read. */
  removed: number;
  byStatus: Partial<Record<Status, number>>;
};

const BATCH = 200;
/**
 * Transaction-level advisory lock taken by every writer of tender_assessments:
 * the worker's jobs and the command line may run at once, and each must see
 * the others' rows before it decides what changed. Session-level locks are not
 * reliable behind the Supabase pooler.
 */
const ASSESS_LOCK = sql.raw("select pg_advisory_xact_lock(7301101944)");

type AssessContext = { now: Date; policy: Policy; rates: RateTable; dryRun: boolean; log: (message: string) => void };

/** Tenders with valid facts whose facts were extracted, or whose notice was written, since then. */
async function changedSince(db: AppDb, since: Date): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: analyses.tenderId })
    .from(analyses)
    .innerJoin(tenders, eq(tenders.id, analyses.tenderId))
    .where(and(eq(analyses.kind, "facts"), eq(analyses.valid, true), or(gte(analyses.createdAt, since), gte(tenders.updatedAt, since))));
  return rows.map((r) => r.id);
}

/**
 * Assesses tenders with valid facts: the given ones (tenderIds) and those
 * changed since `changedSince`, or all when neither is given. Writes a row
 * only when the verdict changed, and a history row when the status, the lot
 * or the policy version did. With `dryRun` nothing is written.
 */
export async function assessTenders(
  db: AppDb,
  options: {
    now?: Date;
    policy?: Policy;
    tenderIds?: readonly string[];
    changedSince?: Date;
    dryRun?: boolean;
    log?: (message: string) => void;
  } = {},
): Promise<AssessStats> {
  const stats: AssessStats = { assessed: 0, changed: 0, statusChanged: 0, errors: 0, removed: 0, byStatus: {} };
  const targeted = options.tenderIds || options.changedSince;
  const ids = targeted ? new Set(options.tenderIds) : null;
  if (ids && options.changedSince) for (const id of await changedSince(db, options.changedSince)) ids.add(id);
  // Nothing changed: not even the rate table is read (runs after every sync and facts run).
  if (ids && !ids.size) return stats;
  const context: AssessContext = {
    now: options.now ?? new Date(),
    policy: options.policy ?? POLICY,
    rates: await loadRateTable(db),
    dryRun: options.dryRun ?? false,
    log: options.log ?? ((message) => console.warn(message)),
  };
  if (ids) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += BATCH) {
      await assessBatch(db, list.slice(i, i + BATCH), context, stats);
    }
    return stats;
  }
  for (let after: string | null = null; ; ) {
    const rows = await db
      .selectDistinct({ id: analyses.tenderId })
      .from(analyses)
      .where(and(eq(analyses.kind, "facts"), eq(analyses.valid, true), after ? gt(analyses.tenderId, after) : undefined))
      .orderBy(asc(analyses.tenderId))
      .limit(BATCH);
    if (!rows.length) break;
    await assessBatch(
      db,
      rows.map((r) => r.id),
      context,
      stats,
    );
    after = rows[rows.length - 1]!.id;
  }
  return stats;
}

type Change = { tenderId: string; summary: Summary; statusChanged: boolean };

/** Reads the batch and works out each verdict; `unreadable` holds tenders whose latest facts no longer read. */
async function evaluate(
  db: AppDb,
  ids: readonly string[],
  context: AssessContext,
  stats: AssessStats,
): Promise<{ summaries: Map<string, Summary>; unreadable: string[] }> {
  const [factsByTender, tenderRows, lotRows] = await Promise.all([
    latestFacts(db, ids),
    db
      .select({
        id: tenders.id,
        valueEur: tenders.valueEur,
        submissionDeadline: tenders.submissionDeadline,
        buyerCountry: tenders.buyerCountry,
        noticeLanguage: tenders.noticeLanguage,
        details: tenders.details,
        publishedAt: tenders.publishedAt,
      })
      .from(tenders)
      .where(inArray(tenders.id, [...ids])),
    db
      .select({ tenderId: lots.tenderId, lotNumber: lots.lotNumber, valueAmount: lots.valueAmount, valueCurrency: lots.valueCurrency })
      .from(lots)
      .where(inArray(lots.tenderId, [...ids])),
  ]);
  const lotsByTender = new Map<string, PolicyLot[]>();
  for (const lot of lotRows) lotsByTender.set(lot.tenderId, [...(lotsByTender.get(lot.tenderId) ?? []), lot]);

  const summaries = new Map<string, Summary>();
  for (const tender of tenderRows) {
    const latest = factsByTender.get(tender.id);
    if (!latest) continue;
    try {
      const input = policyInputOf(tender, lotsByTender.get(tender.id) ?? [], latest.facts, context.rates, context.now);
      const summary = summaryOf(assessTender(input, context.policy), latest.analysisId);
      summaries.set(tender.id, summary);
      stats.assessed++;
      stats.byStatus[summary.status] = (stats.byStatus[summary.status] ?? 0) + 1;
    } catch (error) {
      // One tender's bad data must not leave the ones after it unassessed.
      stats.errors++;
      context.log(`[assess] ${tender.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Facts that no longer read (an answer of an old schema) cannot back a verdict.
  return { summaries, unreadable: ids.filter((id) => !factsByTender.has(id)) };
}

function decide(summaries: Map<string, Summary>, currentRows: TenderAssessmentRow[], stats: AssessStats): Change[] {
  const current = new Map(currentRows.map((row) => [row.tenderId, row]));
  const changes: Change[] = [];
  for (const [tenderId, summary] of summaries) {
    const before = current.get(tenderId);
    if (before && sameSummary(before, summary)) continue;
    const statusChanged =
      !before || before.status !== summary.status || before.bestLot !== summary.bestLot || before.policyVersion !== summary.policyVersion;
    changes.push({ tenderId, summary, statusChanged });
  }
  stats.changed += changes.length;
  stats.statusChanged += changes.filter((c) => c.statusChanged).length;
  return changes;
}

const currentOf = (db: AppDb, ids: string[]) =>
  ids.length ? db.select().from(tenderAssessments).where(inArray(tenderAssessments.tenderId, ids)) : Promise.resolve([]);

async function assessBatch(db: AppDb, ids: readonly string[], context: AssessContext, stats: AssessStats): Promise<void> {
  if (context.dryRun) {
    const { summaries, unreadable } = await evaluate(db, ids, context, stats);
    decide(summaries, await currentOf(db, [...summaries.keys()]), stats);
    stats.removed += (await currentOf(db, unreadable)).length;
    return;
  }
  // Read, decide and write under the lock, so an overlapping run never
  // writes a verdict worked out from data older than the one it replaces.
  await db.transaction(async (tx) => {
    await tx.execute(ASSESS_LOCK);
    const { summaries, unreadable } = await evaluate(tx, ids, context, stats);
    if (unreadable.length) {
      const removed = await tx.delete(tenderAssessments).where(inArray(tenderAssessments.tenderId, unreadable)).returning({ id: tenderAssessments.tenderId });
      stats.removed += removed.length;
    }
    const changes = decide(summaries, await currentOf(tx, [...summaries.keys()]), stats);
    for (const { tenderId, summary, statusChanged } of changes) {
      await tx
        .insert(tenderAssessments)
        .values({ tenderId, ...summary, assessedAt: context.now, statusChangedAt: context.now })
        .onConflictDoUpdate({
          target: tenderAssessments.tenderId,
          set: {
            ...summary,
            assessedAt: context.now,
            statusChangedAt: statusChanged ? context.now : sql`${tenderAssessments.statusChangedAt}`,
          },
        });
      if (statusChanged) {
        await tx.insert(assessmentHistory).values({
          tenderId,
          factsAnalysisId: summary.factsAnalysisId,
          policyVersion: summary.policyVersion,
          status: summary.status,
          bestLot: summary.bestLot,
          explanation: summary.explanation,
          blocking: summary.blocking as GateId[],
          createdAt: context.now,
        });
      }
    }
  });
}
