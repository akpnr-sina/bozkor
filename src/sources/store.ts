import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { AppDb } from "@/db";
import { analyses, documents, lots, profileMatches, rawNotices, tenderReviews, tenders } from "@/db/schema";
import { foldNotices, type FoldedTender } from "./fold";
import { isProductScope } from "./scope";
import { isFullNotice, type NormalizedNotice, type RawNoticeKeys, type SourceId } from "./types";

/** JSON with object keys sorted, so the hash ignores key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Database clock, so "before this run" comparisons are not affected by local clock skew. */
export async function databaseNow(db: AppDb): Promise<Date> {
  const result: unknown = await db.execute(sql`select (extract(epoch from now()) * 1000)::bigint::text as ms`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { ms: string }[];
  return new Date(Number(rows[0]?.ms));
}

export type RawRow = { keys: RawNoticeKeys; payload: unknown };

/**
 * Writes raw payloads. Re-fetching an identical payload is a no-op; a changed
 * payload for the same notice adds a row. Returns the procedures that got new rows.
 */
export async function storeRawNotices(
  db: AppDb,
  source: SourceId,
  rows: RawRow[],
): Promise<{ inserted: number; procedureKeys: string[] }> {
  if (!rows.length) return { inserted: 0, procedureKeys: [] };
  const inserted = await db
    .insert(rawNotices)
    .values(
      rows.map(({ keys, payload }) => ({
        source,
        externalId: keys.externalId,
        procedureKey: keys.procedureKey,
        payload,
        sha256: sha256Hex(stableStringify(payload)),
      })),
    )
    .onConflictDoNothing()
    .returning({ procedureKey: rawNotices.procedureKey });
  const procedureKeys = [...new Set(inserted.map((r) => r.procedureKey).filter((k): k is string => !!k))];
  return { inserted: inserted.length, procedureKeys };
}

const excluded = (column: PgColumn): SQL => sql.raw(`excluded."${column.name}"`);

type UpsertResult = { tenderId: string; inserted: boolean; changed: boolean };

/**
 * Upserts the folded tender with its lots and document links. A tender that
 * existed before this run and now has a newer notice (correction, cancellation,
 * planning turning into a tender) gets changed_at, which drives the "değişti" badge.
 */
export async function upsertTender(
  db: AppDb,
  f: FoldedTender,
  runStartedAt: Date,
  rawIds: readonly string[] = [],
): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(tenders)
      .values({
        source: f.source,
        externalId: f.externalId,
        procedureKey: f.procedureKey,
        noticeType: f.noticeType,
        regime: f.regime,
        contractNature: f.contractNature,
        status: f.status,
        title: f.title,
        description: f.description,
        buyerName: f.buyerName,
        buyerCountry: f.buyerCountry,
        nutsCode: f.nutsCode,
        cpvMain: f.cpvMain,
        cpvAdditional: f.cpvAdditional,
        valueAmount: f.valueAmount,
        valueCurrency: f.valueCurrency,
        publishedAt: f.publishedAt,
        submissionDeadline: f.submissionDeadline,
        clarificationDeadline: f.clarificationDeadline,
        procedureType: f.procedureType,
        noticeLanguage: f.noticeLanguage,
        noticeUrl: f.noticeUrl,
        documentsPortalUrl: f.documentsPortalUrl,
      })
      .onConflictDoUpdate({
        target: [tenders.source, tenders.procedureKey],
        set: {
          externalId: excluded(tenders.externalId),
          noticeType: excluded(tenders.noticeType),
          regime: excluded(tenders.regime),
          contractNature: excluded(tenders.contractNature),
          status: excluded(tenders.status),
          title: excluded(tenders.title),
          description: excluded(tenders.description),
          buyerName: excluded(tenders.buyerName),
          buyerCountry: excluded(tenders.buyerCountry),
          nutsCode: excluded(tenders.nutsCode),
          cpvMain: excluded(tenders.cpvMain),
          cpvAdditional: excluded(tenders.cpvAdditional),
          valueAmount: excluded(tenders.valueAmount),
          valueCurrency: excluded(tenders.valueCurrency),
          publishedAt: excluded(tenders.publishedAt),
          submissionDeadline: excluded(tenders.submissionDeadline),
          clarificationDeadline: excluded(tenders.clarificationDeadline),
          procedureType: excluded(tenders.procedureType),
          noticeLanguage: excluded(tenders.noticeLanguage),
          noticeUrl: excluded(tenders.noticeUrl),
          documentsPortalUrl: excluded(tenders.documentsPortalUrl),
          changedAt: sql`case
            when ${tenders.externalId} is distinct from excluded.external_id
              and ${tenders.createdAt} < ${runStartedAt.toISOString()}::timestamptz
            then now() else ${tenders.changedAt} end`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: tenders.id,
        inserted: sql<boolean>`(xmax = 0)`,
        changedNow: sql<boolean>`coalesce(${tenders.changedAt} >= ${runStartedAt.toISOString()}::timestamptz, false)`,
      });
    if (!row) throw new Error(`Upsert returned no row for ${f.source}/${f.procedureKey}`);

    const lotNumbers = f.lots.map((l) => l.lotNumber);
    if (f.lots.length) {
      await tx
        .insert(lots)
        .values(f.lots.map((l) => ({ ...l, tenderId: row.id })))
        .onConflictDoUpdate({
          target: [lots.tenderId, lots.lotNumber],
          set: {
            title: excluded(lots.title),
            description: excluded(lots.description),
            cpv: excluded(lots.cpv),
            valueAmount: excluded(lots.valueAmount),
            valueCurrency: excluded(lots.valueCurrency),
            quantityText: excluded(lots.quantityText),
          },
        });
    }
    await tx
      .delete(lots)
      .where(
        lotNumbers.length
          ? and(eq(lots.tenderId, row.id), notInArray(lots.lotNumber, lotNumbers))
          : eq(lots.tenderId, row.id),
      );

    // Links accumulate; fetch status of already known links is left alone.
    if (f.documents.length) {
      await tx
        .insert(documents)
        .values(
          f.documents.map((d) => ({
            tenderId: row.id,
            origin: "auto" as const,
            sourceUrl: d.url,
            title: d.title,
            documentType: d.documentType,
          })),
        )
        .onConflictDoUpdate({
          target: [documents.tenderId, documents.sourceUrl],
          targetWhere: sql.raw(`origin = 'auto'`),
          set: { title: excluded(documents.title), documentType: excluded(documents.documentType) },
        });
    }

    // Same transaction: a crash either keeps both the tender and the marks, or neither.
    await markApplied(tx, rawIds);

    return { tenderId: row.id, inserted: Boolean(row.inserted), changed: !row.inserted && Boolean(row.changedNow) };
  });
}

/** Marks exactly the raw rows that were read, so rows added meanwhile by another run stay pending. */
async function markApplied(db: Pick<AppDb, "update">, rawIds: readonly string[]): Promise<void> {
  if (!rawIds.length) return;
  await db
    .update(rawNotices)
    .set({ appliedAt: sql`now()` })
    .where(inArray(rawNotices.id, [...rawIds]));
}

/**
 * Work someone has put into a tender: a decision, an AI analysis or a
 * downloaded document. Such a tender is never deleted for being out of scope.
 */
const hasWork = (): SQL => sql`(
  exists (select 1 from ${tenderReviews} where ${tenderReviews.tenderId} = ${tenders.id})
  or exists (select 1 from ${analyses} where ${analyses.tenderId} = ${tenders.id})
  or exists (select 1 from ${documents} where ${documents.tenderId} = ${tenders.id} and ${documents.storagePath} is not null)
)`;

/**
 * Deletes the tender of an out-of-scope procedure, which exists when it was
 * stored before the scope rule or a correction changed its nature. "kept"
 * means the tender has work on it (see hasWork): it stays, its current
 * profile matches end, and the caller keeps it up to date.
 */
async function removeOutOfScope(
  db: AppDb,
  source: SourceId,
  procedureKey: string,
  rawIds: readonly string[],
): Promise<"deleted" | "kept" | "absent"> {
  return db.transaction(async (tx) => {
    // Lock first and check in a later statement: its snapshot then sees a
    // decision saved while we waited, which the cascade would otherwise delete.
    const [tender] = await tx
      .select({ id: tenders.id })
      .from(tenders)
      .where(and(eq(tenders.source, source), eq(tenders.procedureKey, procedureKey)))
      .for("update");
    if (!tender) {
      await markApplied(tx, rawIds);
      return "absent";
    }
    const deleted = await tx
      .delete(tenders)
      .where(and(eq(tenders.id, tender.id), sql`not ${hasWork()}`))
      .returning({ id: tenders.id });
    if (deleted.length) {
      await markApplied(tx, rawIds);
      return "deleted";
    }
    await tx
      .update(profileMatches)
      .set({ unmatchedAt: sql`now()` })
      .where(and(eq(profileMatches.tenderId, tender.id), isNull(profileMatches.unmatchedAt)));
    return "kept";
  });
}

/** Procedures with raw rows that were stored but never applied, e.g. after an interrupted run. */
export async function pendingProcedureKeys(db: AppDb, source: SourceId): Promise<string[]> {
  const rows = await db
    .selectDistinct({ procedureKey: rawNotices.procedureKey })
    .from(rawNotices)
    .where(and(eq(rawNotices.source, source), isNull(rawNotices.appliedAt)));
  return rows.map((r) => r.procedureKey).filter((k): k is string => !!k);
}

export type ApplyStats = {
  procedures: number;
  inserted: number;
  updated: number;
  changed: number;
  /** Procedures with only partial notices (award stage, old-regime corrections) and no tender notice. */
  skipped: number;
  /** Services, works and software procedures, which are out of scope (see scope.ts). */
  outOfScope: number;
  /** Tenders deleted because their procedure turned out to be out of scope. */
  removed: number;
  /** Out-of-scope tenders kept and updated because someone worked on them (see hasWork). */
  outOfScopeKept: number;
  normalizeErrors: number;
};

export const emptyApplyStats = (): ApplyStats => ({
  procedures: 0,
  inserted: 0,
  updated: 0,
  changed: 0,
  skipped: 0,
  outOfScope: 0,
  removed: 0,
  outOfScopeKept: 0,
  normalizeErrors: 0,
});

/** Runs `fn` over items with at most `limit` in flight; waits for all before rethrowing. */
async function forEachConcurrent<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

// Each upsert is a few round trips to the database; overlapping procedures
// keeps a backfill from Turkey to an EU database to minutes. Stays below the
// app's pool size of 5.
const APPLY_CONCURRENCY = 4;

/** What the stored raw notices of one procedure fold into. */
export type ProcedurePlan = {
  procedureKey: string;
  /** Every raw row read, so exactly these get marked as applied. */
  rawIds: string[];
  /** Null when the procedure has no full notice yet (see isFullNotice). */
  folded: FoldedTender | null;
  inScope: boolean;
  /** Payloads of this procedure that failed to normalize. */
  unreadable: number;
};

/**
 * Loads the raw notices of the given procedures and folds each procedure,
 * without writing anything. Payloads that fail to normalize are logged and
 * left out.
 */
export async function planProcedures(
  db: AppDb,
  source: SourceId,
  procedureKeys: readonly string[],
  normalize: (raw: unknown) => NormalizedNotice | null,
  log: (message: string) => void = console.warn,
): Promise<{ plans: ProcedurePlan[]; normalizeErrors: number }> {
  if (!procedureKeys.length) return { plans: [], normalizeErrors: 0 };
  const rows = await db
    .select({
      id: rawNotices.id,
      procedureKey: rawNotices.procedureKey,
      externalId: rawNotices.externalId,
      payload: rawNotices.payload,
    })
    .from(rawNotices)
    .where(and(eq(rawNotices.source, source), inArray(rawNotices.procedureKey, [...procedureKeys])))
    .orderBy(asc(rawNotices.fetchedAt), asc(rawNotices.id));

  // Latest fetched payload per notice, grouped by procedure, plus every row id read.
  type Group = { payloads: Map<string, unknown>; rawIds: string[] };
  const byProcedure = new Map<string, Group>();
  for (const row of rows) {
    if (!row.procedureKey) continue;
    let group = byProcedure.get(row.procedureKey);
    if (!group) byProcedure.set(row.procedureKey, (group = { payloads: new Map(), rawIds: [] }));
    group.payloads.set(row.externalId, row.payload);
    group.rawIds.push(row.id);
  }

  let normalizeErrors = 0;
  const plans: ProcedurePlan[] = [];
  for (const [procedureKey, { payloads, rawIds }] of byProcedure) {
    const notices: NormalizedNotice[] = [];
    let unreadable = 0;
    for (const [externalId, payload] of payloads) {
      try {
        const notice = normalize(payload);
        if (notice) notices.push(notice);
      } catch (error) {
        unreadable++;
        log(`[${source}] could not normalize ${externalId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    normalizeErrors += unreadable;
    const folded = notices.some(isFullNotice) ? foldNotices(notices) : null;
    plans.push({
      procedureKey,
      rawIds,
      folded,
      inScope: folded !== null && isProductScope(folded.contractNature, folded.cpvMain),
      unreadable,
    });
  }
  return { plans, normalizeErrors };
}

/**
 * Re-folds each procedure from all of its stored raw notices and upserts the
 * result. Safe to repeat: the same raw rows always produce the same tender.
 */
export async function applyProcedures(
  db: AppDb,
  source: SourceId,
  procedureKeys: readonly string[],
  normalize: (raw: unknown) => NormalizedNotice | null,
  runStartedAt: Date,
  log: (message: string) => void = console.warn,
): Promise<ApplyStats> {
  const stats = emptyApplyStats();
  const { plans, normalizeErrors } = await planProcedures(db, source, procedureKeys, normalize, log);
  stats.normalizeErrors = normalizeErrors;

  await forEachConcurrent(plans, APPLY_CONCURRENCY, async ({ procedureKey, rawIds, folded, inScope, unreadable }) => {
    // Award-only procedures (their tender notice predates our data) and lone
    // old-regime corrections would become tenders without a deadline or
    // status. Mark the rows anyway so they are not retried on every run;
    // renormalize picks them up again if the rules change.
    if (!folded) {
      stats.skipped++;
      await markApplied(db, rawIds);
      return;
    }

    if (!inScope) {
      stats.outOfScope++;
      // The unreadable notice may be the one that states the nature (a
      // cancellation alone does not): never delete on half the evidence.
      if (unreadable) {
        await markApplied(db, rawIds);
        return;
      }
      const outcome = await removeOutOfScope(db, source, procedureKey, rawIds);
      if (outcome === "deleted") stats.removed++;
      if (outcome !== "kept") return;
      // Someone worked on it: keep its deadline and status current.
      stats.outOfScopeKept++;
    }

    const result = await upsertTender(db, folded, runStartedAt, rawIds);
    stats.procedures++;
    if (result.inserted) stats.inserted++;
    else stats.updated++;
    if (result.changed) stats.changed++;
  });
  return stats;
}

export type ScopeReport = {
  procedures: number;
  /** Stored tenders that a run would delete, and how many of them have current profile matches. */
  wouldRemove: number;
  wouldRemoveMatched: number;
  /** Stored out-of-scope tenders that stay because someone worked on them, and how many lose current matches. */
  wouldKeep: number;
  wouldKeepMatched: number;
  /** Out-of-scope procedures without a stored tender. */
  outOfScopeAbsent: number;
};

/** What applying these procedures would delete or keep for being out of scope, without writing. */
export async function scopeReport(
  db: AppDb,
  source: SourceId,
  procedureKeys: readonly string[],
  normalize: (raw: unknown) => NormalizedNotice | null,
  log?: (message: string) => void,
): Promise<ScopeReport & { normalizeErrors: number }> {
  const { plans, normalizeErrors } = await planProcedures(db, source, procedureKeys, normalize, log);
  const report = {
    procedures: plans.length,
    wouldRemove: 0,
    wouldRemoveMatched: 0,
    wouldKeep: 0,
    wouldKeepMatched: 0,
    outOfScopeAbsent: 0,
  };
  // Same selection as applyProcedures: procedures with unreadable notices are left alone.
  const outKeys = plans.filter((p) => p.folded && !p.inScope && !p.unreadable).map((p) => p.procedureKey);
  if (!outKeys.length) return { ...report, normalizeErrors };

  const stored = await db
    .select({
      worked: sql<boolean>`${hasWork()}`,
      matched: sql<boolean>`exists (select 1 from ${profileMatches} where ${profileMatches.tenderId} = ${tenders.id} and ${profileMatches.unmatchedAt} is null)`,
    })
    .from(tenders)
    .where(and(eq(tenders.source, source), inArray(tenders.procedureKey, outKeys)));
  for (const row of stored) {
    if (row.worked) {
      report.wouldKeep++;
      if (row.matched) report.wouldKeepMatched++;
    } else {
      report.wouldRemove++;
      if (row.matched) report.wouldRemoveMatched++;
    }
  }
  report.outOfScopeAbsent = outKeys.length - stored.length;
  return { ...report, normalizeErrors };
}
