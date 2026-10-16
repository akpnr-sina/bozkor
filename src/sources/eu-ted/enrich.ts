import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { profileMatches, rawNotices, tenderReviews, tenders } from "@/db/schema";
import { applyProcedures, emptyApplyStats, storeRawNotices, type ApplyStats } from "../store";
import { addStats, emptySyncStats } from "../sync";
import type { RawNoticeKeys } from "../types";
import { normalizeTedNotice, tedNoticeKeys } from "./normalize";

/** What enrichment needs from the TED client; tests pass a fake. */
export type TedNoticeSource = {
  noticesByNumber(numbers: readonly string[]): AsyncIterable<unknown[]>;
};

export type EnrichStats = ApplyStats & {
  /** TED tenders with a current match or a decision. */
  tenders: number;
  /** Their notices, asked for by publication number. */
  requested: number;
  /** Notices the API returned. */
  fetched: number;
  /** Raw rows that were new: payloads that now carry the added fields. */
  rawInserted: number;
};

/** Publication numbers per request; one page holds them all. */
const BATCH = 100;
/** Procedures re-applied at a time, as in renormalize. */
const APPLY_BATCH = 200;

/** Procedures of the TED tenders the team sees: a current match on any profile, or any decision. */
async function procedureKeysToEnrich(db: AppDb, onlyMissingDetails: boolean): Promise<string[]> {
  const rows = await db
    .select({ procedureKey: tenders.procedureKey })
    .from(tenders)
    .where(
      and(
        eq(tenders.source, "eu_ted"),
        onlyMissingDetails ? isNull(tenders.details) : undefined,
        or(
          sql`exists (select 1 from ${profileMatches} where ${profileMatches.tenderId} = ${tenders.id} and ${isNull(profileMatches.unmatchedAt)})`,
          sql`exists (select 1 from ${tenderReviews} where ${tenderReviews.tenderId} = ${tenders.id})`,
        ),
      ),
    )
    .orderBy(asc(tenders.procedureKey));
  return rows.map((r) => r.procedureKey);
}

/**
 * Fetches the notices of the TED tenders the team sees again, with the
 * fields added to TED_FIELDS since they were stored, and re-applies their
 * procedures. Every new payload is kept as a raw row (CLAUDE.md rule 2);
 * folding reads the latest payload of each notice. Refetching is not a new
 * notice, so no tender is marked as changed. Running it again stores nothing.
 *
 * With onlyMissingDetails, only tenders without details are asked for, such
 * as old ones matched since the last run. Tenders whose notices state no
 * details are asked again each time; their unchanged payloads write nothing.
 */
export async function enrichTedNotices(
  db: AppDb,
  client: TedNoticeSource,
  options: { log?: (message: string) => void; batchSize?: number; onlyMissingDetails?: boolean } = {},
): Promise<EnrichStats> {
  const { log = console.log, batchSize = BATCH, onlyMissingDetails = false } = options;
  const procedureKeys = await procedureKeysToEnrich(db, onlyMissingDetails);
  const stats: EnrichStats = { ...emptyApplyStats(), tenders: procedureKeys.length, requested: 0, fetched: 0, rawInserted: 0 };
  if (!procedureKeys.length) return stats;

  const numbers = (
    await db
      .selectDistinct({ externalId: rawNotices.externalId })
      .from(rawNotices)
      .where(and(eq(rawNotices.source, "eu_ted"), inArray(rawNotices.procedureKey, procedureKeys)))
      .orderBy(asc(rawNotices.externalId))
  ).map((r) => r.externalId);
  stats.requested = numbers.length;

  const changed = new Set<string>();
  for (let i = 0; i < numbers.length; i += batchSize) {
    for await (const page of client.noticesByNumber(numbers.slice(i, i + batchSize))) {
      stats.fetched += page.length;
      const rows = page.flatMap((payload) => {
        const keys: RawNoticeKeys | null = tedNoticeKeys(payload);
        return keys ? [{ keys, payload }] : [];
      });
      const stored = await storeRawNotices(db, "eu_ted", rows);
      stats.rawInserted += stored.inserted;
      for (const key of stored.procedureKeys) changed.add(key);
    }
    log(`  ${Math.min(i + batchSize, numbers.length)} / ${numbers.length} ilan`);
  }

  // As in renormalize: a run start at the epoch never marks a tender as changed.
  const keys = [...changed];
  let applied = emptySyncStats();
  for (let i = 0; i < keys.length; i += APPLY_BATCH) {
    const part = await applyProcedures(db, "eu_ted", keys.slice(i, i + APPLY_BATCH), normalizeTedNotice, new Date(0), log);
    applied = addStats(applied, { ...part, fetched: 0, rawInserted: 0 });
  }
  return { ...applied, tenders: stats.tenders, requested: stats.requested, fetched: stats.fetched, rawInserted: stats.rawInserted };
}
