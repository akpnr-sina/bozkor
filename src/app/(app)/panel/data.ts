import { inArray, isNull, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { criteriaProfiles, profileMatches, tenderAssessments, tenders } from "@/db/schema";
import { STATUS_GROUPS } from "@/policy/labels";
import { inboxCounts, loadInbox, readFilters } from "../inbox/data";

// The panel (the landing page): the inbox's key figures, the nearest deadlines
// among tenders worth acting on, and what the sources brought lately.

const UPCOMING = 6;
const COUNTRIES = 8;
const WEEKS = 8;

/** Verdicts the team still acts on: promising, conditional and watched; not assessed yet counts too. */
const LIVE = [...STATUS_GROUPS.promising, ...STATUS_GROUPS.conditional, ...STATUS_GROUPS.watch];

/** A tender with a current match of an active profile. */
const matched = sql`exists (
  select 1 from ${profileMatches} join ${criteriaProfiles} on ${criteriaProfiles.id} = ${profileMatches.profileId}
  where ${profileMatches.tenderId} = ${tenders.id} and ${profileMatches.unmatchedAt} is null and ${criteriaProfiles.active})`;

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

export type CountryStat = { country: string | null; found: number; matched: number };
export type WeekStat = { week: string; label: string; found: number; matched: number };

export async function loadPanel(db: AppDb) {
  const everyday = readFilters({});
  const [counts, go, upcoming, countries, weeks] = await Promise.all([
    inboxCounts(db, everyday),
    inboxCounts(db, { ...everyday, decision: "GO" }),
    loadInbox(db, everyday, UPCOMING, or(isNull(tenderAssessments.status), inArray(tenderAssessments.status, LIVE))),
    countryStats(db),
    weeklyStats(db),
  ]);
  return {
    counts,
    goOpen: go.all,
    upcoming: upcoming.list,
    hasAnyProfile: upcoming.hasAnyProfile,
    countries,
    weeks,
  };
}

/** Tenders published in the last 30 days by buyer country, the most first, and how many of them matched. */
async function countryStats(db: AppDb): Promise<CountryStat[]> {
  return db
    .select({
      country: tenders.buyerCountry,
      found: sql<number>`count(*)::int`,
      matched: sql<number>`(count(*) filter (where ${matched}))::int`,
    })
    .from(tenders)
    .where(sql`${tenders.publishedAt} > now() - interval '30 days'`)
    .groupBy(tenders.buyerCountry)
    .orderBy(sql`count(*) desc`, tenders.buyerCountry)
    .limit(COUNTRIES);
}

/** Tenders published per week (Istanbul, ISO weeks), the last WEEKS weeks with empty ones, and how many matched. */
async function weeklyStats(db: AppDb): Promise<WeekStat[]> {
  const result = await db.execute(sql`
    select to_char(w, 'IYYY-IW') as week, to_char(w, 'IW') as label,
      count(${tenders.id})::int as found,
      (count(${tenders.id}) filter (where ${matched}))::int as matched
    from generate_series(
      date_trunc('week', now() at time zone 'Europe/Istanbul') - make_interval(weeks => ${WEEKS - 1}),
      date_trunc('week', now() at time zone 'Europe/Istanbul'),
      interval '1 week'
    ) as w
    left join ${tenders} on date_trunc('week', ${tenders.publishedAt} at time zone 'Europe/Istanbul') = w
    group by w
    order by w`);
  return rowsOf<WeekStat>(result).map((row) => ({ ...row, found: Number(row.found), matched: Number(row.matched) }));
}
