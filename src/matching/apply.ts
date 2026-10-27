import { and, desc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db";
import { categories, criteriaProfiles, lots, profileMatches, tenders } from "@/db/schema";
import type { Regime, SourceId } from "@/sources/types";
import { matchTender } from "./engine";
import { profileRulesSchema, type ProfileRules } from "./rules";
import type { MatchableTender, MatchCategory, MatchReason, RuleKey } from "./types";

type Profile = { id: string; name: string; rules: ProfileRules };
type Candidate = MatchableTender & { id: string; publishedAt: Date | null; updatedAt: Date };
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

/**
 * Tenders to judge, with their lots. The lots come in one query over the same
 * condition, side by side with the tenders: 30 days are about 9,400 tenders
 * and 41,000 lots (22 MB of text), and lists of ids sent a thousand at a time
 * took six times as long.
 */
async function loadCandidates(db: Executor, where: SQL): Promise<Candidate[]> {
  const tenderRows = db
    .select({
      id: tenders.id,
      source: tenders.source,
      noticeType: tenders.noticeType,
      regime: tenders.regime,
      contractNature: tenders.contractNature,
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
      updatedAt: tenders.updatedAt,
    })
    .from(tenders)
    .where(where);
  const lotRows = db
    .select({ tenderId: lots.tenderId, title: lots.title, description: lots.description, cpv: lots.cpv })
    .from(lots)
    .where(inArray(lots.tenderId, db.select({ id: tenders.id }).from(tenders).where(where)));
  const [rows, lotList] = await Promise.all([tenderRows, lotRows]);

  const lotsByTender = new Map<string, MatchableTender["lots"]>();
  for (const lot of lotList) {
    const list = lotsByTender.get(lot.tenderId) ?? [];
    list.push({ title: lot.title, description: lot.description, cpv: lot.cpv });
    lotsByTender.set(lot.tenderId, list);
  }

  return rows.map((row) => ({
    ...row,
    source: row.source as SourceId,
    regime: row.regime as Regime,
    lots: lotsByTender.get(row.id) ?? [],
  }));
}

/**
 * Match candidates the process keeps in memory (the web app's profile pages):
 * the preview and a profile's rematch judge thousands of tenders, and reading
 * their texts every time cost 22-32 MB of Supabase egress. A load reads each
 * tender's updated_at and EUR value (which changes without updated_at) and
 * the full rows only of tenders that are new or were written again, so it
 * gives what a full read would.
 */
const candidateCaches = new WeakMap<object, Map<string, { candidate: Candidate; seenAt: number }>>();
/** Past this many changed tenders the scope is read whole: one condition is faster than lists of ids. */
const RELOAD_BY_ID_MAX = 2_000;
/** Tenders no load has asked for in this long leave the memory. */
const UNUSED_DROP_MS = 6 * 60 * 60_000;

/** The candidates `scope` selects, through the cache of `key` (the database the caller was given). */
async function cachedCandidates(key: object, db: Executor, scope: SQL): Promise<Candidate[]> {
  let cache = candidateCaches.get(key);
  if (!cache) candidateCaches.set(key, (cache = new Map()));
  const store = cache;
  const now = Date.now();
  const current = await db.select({ id: tenders.id, updatedAt: tenders.updatedAt, valueEur: tenders.valueEur }).from(tenders).where(scope);
  const changed = current.filter((row) => store.get(row.id)?.candidate.updatedAt.getTime() !== row.updatedAt.getTime()).map((row) => row.id);
  if (changed.length) {
    const loaded =
      changed.length > RELOAD_BY_ID_MAX
        ? await loadCandidates(db, scope)
        : (await Promise.all(chunks(changed).map((ids) => loadCandidates(db, inArray(tenders.id, ids))))).flat();
    for (const candidate of loaded) store.set(candidate.id, { candidate, seenAt: now });
  }
  const result: Candidate[] = [];
  for (const row of current) {
    const entry = store.get(row.id);
    // Deleted between the two reads.
    if (!entry) continue;
    entry.seenAt = now;
    entry.candidate.valueEur = row.valueEur;
    result.push(entry.candidate);
  }
  for (const [id, entry] of store) if (now - entry.seenAt > UNUSED_DROP_MS) store.delete(id);
  return result;
}

// Time-based rejections (closed, cancelled, awarded, deadline too close) do
// not end a match; it stays, hidden in the inbox. Only the criteria do.
const KEEP_EXISTING_ON: ReadonlySet<RuleKey> = new Set(["status", "deadline"]);

// Worker and profile saves both rematch; serialize them so one cannot write
// back matches computed from rules the other has just replaced.
const REMATCH_LOCK = 774_201;

export type RematchStats = { profiles: number; tenders: number; matched: number; created: number; unmatched: number };

/**
 * The open tenders a run after a sync judges: those written since
 * `changedSince` (updated_at) and those in `tenderIds`; every open tender when
 * neither is given. Time alone never makes a tender match (the days left only
 * shrink), so the others cannot have changed.
 */
function changedTenders(options: { changedSince?: Date; tenderIds?: readonly string[] }): SQL | undefined {
  if (!options.changedSince && !options.tenderIds) return undefined;
  const parts = [
    options.changedSince ? gte(tenders.updatedAt, options.changedSince) : undefined,
    options.tenderIds?.length ? inArray(tenders.id, [...options.tenderIds]) : undefined,
  ].filter((part) => part !== undefined);
  return parts.length ? or(...parts) : sql`false`;
}

/**
 * Re-evaluates active profiles and syncs profile_matches. Without profileIds
 * (after a sync) only open tenders are considered, all of them or only the
 * changed ones (see changedTenders); for a changed profile its existing
 * matches are re-judged too, closed tenders included. A match the profile no
 * longer wants is marked with unmatched_at, never deleted. Matches of a tender
 * that falls out of scope end when it is stored (see store.ts).
 */
export async function rematch(
  db: AppDb,
  options: {
    profileIds?: readonly string[];
    /** Without profileIds: only open tenders written since then, and those in tenderIds. */
    changedSince?: Date;
    /** Without profileIds: tenders to judge although updated_at did not move (a new EUR value). */
    tenderIds?: readonly string[];
    now?: Date;
    log?: (m: string) => void;
  } = {},
): Promise<RematchStats> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REMATCH_LOCK})`);
    const stats: RematchStats = { profiles: 0, tenders: 0, matched: 0, created: 0, unmatched: 0 };
    const profiles = await loadProfiles(tx, options.profileIds, options.log);
    stats.profiles = profiles.length;
    if (!profiles.length) return stats;

    const profileIds = profiles.map((p) => p.id);
    const currentMatches = and(inArray(profileMatches.profileId, profileIds), isNull(profileMatches.unmatchedAt))!;
    const changed = options.profileIds?.length ? undefined : changedTenders(options);
    const candidateWhere = options.profileIds?.length
      ? or(openTender(), inArray(tenders.id, tx.select({ id: profileMatches.tenderId }).from(profileMatches).where(currentMatches)))!
      : and(openTender(), changed)!;
    const existing = await tx
      .select({ profileId: profileMatches.profileId, tenderId: profileMatches.tenderId })
      .from(profileMatches)
      .where(changed ? and(currentMatches, inArray(profileMatches.tenderId, tx.select({ id: tenders.id }).from(tenders).where(candidateWhere))) : currentMatches);
    const existingKeys = new Set(existing.map((m) => `${m.profileId}:${m.tenderId}`));

    // A profile's rematch judges every open tender: from the cache (a save is a web request); a sync's only a few.
    const candidates = options.profileIds?.length ? await cachedCandidates(db, tx, candidateWhere) : await loadCandidates(tx, candidateWhere);
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

// Previews re-run on every form change, so the last N days stay in memory.
// Fresh for 10 minutes; then a preview still answers from them while they
// reload behind it (new tenders arrive every two hours), and past an hour it
// waits for the reload.
export const PREVIEW_FRESH_MS = 10 * 60_000;
export const PREVIEW_MAX_AGE_MS = 60 * 60_000;

type PreviewCorpus = { loadedAt: number; days: number; tenders: Candidate[] };
const previewCache = new WeakMap<object, { corpus?: PreviewCorpus; loading?: Promise<PreviewCorpus> }>();

/** Drops the cached tenders of the preview and of profile rematches, e.g. after the tenders table was reset in tests. */
export function clearCandidateCaches(db: AppDb): void {
  previewCache.delete(db);
  candidateCaches.delete(db);
}

/** The tenders published in the last `days` days, from memory when fresh enough (see PREVIEW_FRESH_MS). */
async function previewCorpus(db: AppDb, days: number): Promise<Candidate[]> {
  let entry = previewCache.get(db);
  if (!entry) previewCache.set(db, (entry = {}));
  const cache = entry;
  // One load at a time, shared by the previews that wait for it.
  const reload = () =>
    (cache.loading ??= (async () => {
      const since = new Date(Date.now() - days * 24 * 60 * 60_000);
      const corpus = { loadedAt: Date.now(), days, tenders: await cachedCandidates(db, db, gte(tenders.publishedAt, since)) };
      if (previewCache.get(db) === cache) cache.corpus = corpus;
      return corpus;
    })().finally(() => {
      cache.loading = undefined;
    }));
  const corpus = cache.corpus?.days === days ? cache.corpus : undefined;
  const age = corpus ? Date.now() - corpus.loadedAt : Infinity;
  if (corpus && age < PREVIEW_FRESH_MS) return corpus.tenders;
  if (corpus && age < PREVIEW_MAX_AGE_MS) {
    // A failed reload keeps the old tenders; the next stale preview tries again.
    reload().catch(() => {});
    return corpus.tenders;
  }
  return (await reload()).tenders;
}

/**
 * "How many tenders would these rules have matched in the last N days":
 * each tender is judged as on the day it was published, when it was open.
 * openNow judges the same matches as of today, like the inbox does.
 */
export async function previewRules(db: AppDb, rules: ProfileRules, days = 30, now = new Date()): Promise<PreviewResult> {
  const [corpus, categoriesList] = await Promise.all([previewCorpus(db, days), loadCategories(db)]);
  const result: PreviewResult = { scanned: corpus.length, matched: 0, openNow: 0, examples: [], rejections: {} };
  const matches: PreviewResult["examples"] = [];
  for (const tender of corpus) {
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
