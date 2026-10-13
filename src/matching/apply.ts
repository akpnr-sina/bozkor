import { and, desc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db";
import { categories, criteriaProfiles, lots, profileMatches, tenders } from "@/db/schema";
import type { Regime, SourceId } from "@/sources/types";
import { matchTender } from "./engine";
import { profileRulesSchema, type ProfileRules } from "./rules";
import type { MatchableTender, MatchCategory, MatchReason, RuleKey } from "./types";

type Profile = { id: string; name: string; rules: ProfileRules };
type Candidate = MatchableTender & { id: string; publishedAt: Date | null };
/** A database or a transaction on it. */
type Executor = Pick<AppDb, "select" | "insert" | "update" | "execute">;

const CHUNK = 1_000;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function loadCategories(db: Executor): Promise<MatchCategory[]> {
  return db.select({ id: categories.id, cpvPrefixes: categories.cpvPrefixes }).from(categories);
}

/** Active profiles with valid rules; a profile with unreadable rules is skipped, not fatal. */
async function loadProfiles(db: Executor, profileIds?: readonly string[], log?: (m: string) => void): Promise<Profile[]> {
  const where = profileIds?.length
    ? and(eq(criteriaProfiles.active, true), inArray(criteriaProfiles.id, [...profileIds]))
    : eq(criteriaProfiles.active, true);
  const rows = await db.select().from(criteriaProfiles).where(where);
  return rows.flatMap((row) => {
    const parsed = profileRulesSchema.safeParse(row.rules);
    if (!parsed.success) {
      log?.(`[matching] profile ${row.id} has invalid rules and was skipped`);
      return [];
    }
    return [{ id: row.id, name: row.name, rules: parsed.data }];
  });
}

/** Bids are still possible: status open and the deadline unknown or ahead. */
export const openTender = (): SQL =>
  and(eq(tenders.status, "open"), or(isNull(tenders.submissionDeadline), gt(tenders.submissionDeadline, sql`now()`)))!;

async function loadCandidates(db: Executor, where: SQL): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: tenders.id,
      source: tenders.source,
      noticeType: tenders.noticeType,
      regime: tenders.regime,
      status: tenders.status,
      title: tenders.title,
      description: tenders.description,
      buyerCountry: tenders.buyerCountry,
      cpvMain: tenders.cpvMain,
      cpvAdditional: tenders.cpvAdditional,
      valueEur: tenders.valueEur,
      submissionDeadline: tenders.submissionDeadline,
      noticeLanguage: tenders.noticeLanguage,
      publishedAt: tenders.publishedAt,
    })
    .from(tenders)
    .where(where);

  const lotsByTender = new Map<string, MatchableTender["lots"]>();
  for (const ids of chunks(rows.map((r) => r.id))) {
    const lotRows = await db
      .select({ tenderId: lots.tenderId, title: lots.title, description: lots.description, cpv: lots.cpv })
      .from(lots)
      .where(inArray(lots.tenderId, ids));
    for (const lot of lotRows) {
      const list = lotsByTender.get(lot.tenderId) ?? [];
      list.push({ title: lot.title, description: lot.description, cpv: lot.cpv });
      lotsByTender.set(lot.tenderId, list);
    }
  }

  return rows.map((row) => ({
    ...row,
    source: row.source as SourceId,
    regime: row.regime as Regime,
    lots: lotsByTender.get(row.id) ?? [],
  }));
}

// Time-based rejections (closed, cancelled, awarded, deadline too close) do
// not end a match; it stays, hidden in the inbox. Only the criteria do.
const KEEP_EXISTING_ON: ReadonlySet<RuleKey> = new Set(["status", "deadline"]);

// Worker and profile saves both rematch; serialize them so one cannot write
// back matches computed from rules the other has just replaced.
const REMATCH_LOCK = 774_201;

export type RematchStats = { profiles: number; tenders: number; matched: number; created: number; unmatched: number };

/**
 * Re-evaluates active profiles and syncs profile_matches. Without profileIds
 * (after a sync) only open tenders are considered; for a changed profile its
 * existing matches are re-judged too, closed tenders included. A match the
 * profile no longer wants is marked with unmatched_at, never deleted.
 */
export async function rematch(
  db: AppDb,
  options: { profileIds?: readonly string[]; now?: Date; log?: (m: string) => void } = {},
): Promise<RematchStats> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REMATCH_LOCK})`);
    const stats: RematchStats = { profiles: 0, tenders: 0, matched: 0, created: 0, unmatched: 0 };
    const profiles = await loadProfiles(tx, options.profileIds, options.log);
    stats.profiles = profiles.length;
    if (!profiles.length) return stats;

    const profileIds = profiles.map((p) => p.id);
    const currentMatches = and(inArray(profileMatches.profileId, profileIds), isNull(profileMatches.unmatchedAt))!;
    const existing = await tx
      .select({ profileId: profileMatches.profileId, tenderId: profileMatches.tenderId })
      .from(profileMatches)
      .where(currentMatches);
    const existingKeys = new Set(existing.map((m) => `${m.profileId}:${m.tenderId}`));

    const candidateWhere = options.profileIds?.length
      ? or(openTender(), inArray(tenders.id, tx.select({ id: profileMatches.tenderId }).from(profileMatches).where(currentMatches)))!
      : openTender();
    const candidates = await loadCandidates(tx, candidateWhere);
    stats.tenders = candidates.length;

    const context = { categories: await loadCategories(tx), now: options.now ?? new Date() };
    const upserts: { profileId: string; tenderId: string; filterReasons: MatchReason[] }[] = [];
    const unmatch = new Map<string, string[]>();

    for (const profile of profiles) {
      for (const tender of candidates) {
        const result = matchTender(tender, profile.rules, context);
        if (result.matched) {
          upserts.push({ profileId: profile.id, tenderId: tender.id, filterReasons: result.reasons });
          continue;
        }
        if (!existingKeys.has(`${profile.id}:${tender.id}`)) continue;
        // Time-based rejections run before the criteria, so judge the criteria
        // on their own: keep the match only if the profile still wants the tender.
        const stillWanted =
          KEEP_EXISTING_ON.has(result.rejectedBy) &&
          matchTender({ ...tender, status: "open", submissionDeadline: null }, profile.rules, context).matched;
        if (!stillWanted) unmatch.set(profile.id, [...(unmatch.get(profile.id) ?? []), tender.id]);
      }
    }
    stats.matched = upserts.length;

    for (const batch of chunks(upserts, 500)) {
      const written = await tx
        .insert(profileMatches)
        .values(batch)
        .onConflictDoUpdate({
          target: [profileMatches.profileId, profileMatches.tenderId],
          set: { filterReasons: sql.raw(`excluded."filter_reasons"`), unmatchedAt: sql`null` },
          // Rewrite only what changed; most runs change nothing.
          setWhere: sql`${profileMatches.filterReasons} is distinct from excluded.filter_reasons or ${profileMatches.unmatchedAt} is not null`,
        })
        .returning({ created: sql<boolean>`(xmax = 0)` });
      stats.created += written.filter((w) => w.created).length;
    }
    for (const [profileId, tenderIds] of unmatch) {
      for (const ids of chunks(tenderIds)) {
        const marked = await tx
          .update(profileMatches)
          .set({ unmatchedAt: sql`now()` })
          .where(and(eq(profileMatches.profileId, profileId), inArray(profileMatches.tenderId, ids), isNull(profileMatches.unmatchedAt)))
          .returning({ tenderId: profileMatches.tenderId });
        stats.unmatched += marked.length;
      }
    }
    return stats;
  });
}

export type PreviewResult = {
  scanned: number;
  /** Would have matched on their publication day. */
  matched: number;
  /** Of those, how many match today (still open, deadline far enough): what the inbox will show. */
  openNow: number;
  /** Most recent matches first. */
  examples: { id: string; title: string; publishedAt: Date | null; reasons: MatchReason[] }[];
  rejections: Partial<Record<RuleKey, number>>;
};

// Previews re-run on every form change; keep the last N days in memory briefly.
const PREVIEW_TTL_MS = 2 * 60_000;
const previewCache = new WeakMap<object, { loadedAt: number; days: number; tenders: Candidate[] }>();

/** Drops the cached preview tenders, e.g. after the tenders table was reset in tests. */
export function clearPreviewCache(db: AppDb): void {
  previewCache.delete(db);
}

/**
 * "How many tenders would these rules have matched in the last N days":
 * each tender is judged as on the day it was published, when it was open.
 * openNow judges the same matches as of today, like the inbox does.
 */
export async function previewRules(db: AppDb, rules: ProfileRules, days = 30, now = new Date()): Promise<PreviewResult> {
  let cached = previewCache.get(db);
  if (!cached || cached.days !== days || Date.now() - cached.loadedAt > PREVIEW_TTL_MS) {
    const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
    cached = { loadedAt: Date.now(), days, tenders: await loadCandidates(db, gte(tenders.publishedAt, since)) };
    previewCache.set(db, cached);
  }
  const categoriesList = await loadCategories(db);
  const result: PreviewResult = { scanned: cached.tenders.length, matched: 0, openNow: 0, examples: [], rejections: {} };
  const matches: PreviewResult["examples"] = [];
  for (const tender of cached.tenders) {
    const publishedAt = tender.publishedAt ?? now;
    const outcome = matchTender({ ...tender, status: "open" }, rules, { categories: categoriesList, now: publishedAt });
    if (!outcome.matched) {
      result.rejections[outcome.rejectedBy] = (result.rejections[outcome.rejectedBy] ?? 0) + 1;
      continue;
    }
    matches.push({ id: tender.id, title: tender.title, publishedAt: tender.publishedAt, reasons: outcome.reasons });
    if (matchTender(tender, rules, { categories: categoriesList, now }).matched) result.openNow++;
  }
  result.matched = matches.length;
  result.examples = matches
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, 10);
  return result;
}

/** Current matches of open tenders per active profile, for the profile list. */
export async function openMatchCounts(db: AppDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ profileId: profileMatches.profileId, n: sql<number>`count(*)::int` })
    .from(profileMatches)
    .innerJoin(tenders, eq(tenders.id, profileMatches.tenderId))
    .where(and(openTender(), isNull(profileMatches.unmatchedAt)))
    .groupBy(profileMatches.profileId)
    .orderBy(desc(sql`count(*)`));
  return new Map(rows.map((r) => [r.profileId, r.n]));
}
