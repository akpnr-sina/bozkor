import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db";
import { criteriaProfiles, documents, profileMatches, reviewDecision, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import type { ReviewDecision } from "@/lib/format";
import { latestTranslations } from "@/analysis/translations";
import { openTender } from "@/matching/apply";
import { sourceIds } from "@/matching/rules";
import { STATUSES } from "@/policy/engine";
import { STATUS_GROUPS, type StatusGroup } from "@/policy/labels";

export const PAGE_SIZE = 100;
const MAX_PAGE = 10_000;

export type Filters = {
  profile: string;
  source: string;
  status: "open" | "closed" | "all";
  decision: "" | "none" | ReviewDecision;
  /** A group of qualification policy statuses, or tenders not assessed yet. */
  assessment: "" | "none" | StatusGroup;
  /** Nearest deadline first, or the most promising verdict first. */
  sort: "deadline" | "assessment";
  /** 1-based. */
  page: number;
};

export function readFilters(params: Record<string, string | string[] | undefined>): Filters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };
  const status = one("status");
  const decision = one("decision");
  const profile = one("profile");
  const assessment = one("assessment");
  const page = Number(one("page"));
  return {
    profile: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile) ? profile : "",
    source: (sourceIds as readonly string[]).includes(one("source")) ? one("source") : "",
    status: status === "closed" || status === "all" ? status : "open",
    decision:
      decision === "none" || (reviewDecision.enumValues as readonly string[]).includes(decision)
        ? (decision as Filters["decision"])
        : "",
    assessment: assessment === "none" || Object.hasOwn(STATUS_GROUPS, assessment) ? (assessment as Filters["assessment"]) : "",
    sort: one("sort") === "assessment" ? "assessment" : "deadline",
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

/** Query string for the inbox with these filters, defaults left out. */
export function inboxQuery(filters: Filters, page = filters.page): string {
  const params = new URLSearchParams();
  if (filters.profile) params.set("profile", filters.profile);
  if (filters.source) params.set("source", filters.source);
  if (filters.status !== "open") params.set("status", filters.status);
  if (filters.decision) params.set("decision", filters.decision);
  if (filters.assessment) params.set("assessment", filters.assessment);
  if (filters.sort !== "deadline") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

const isConcreteDecision = (decision: Filters["decision"]): decision is ReviewDecision =>
  decision !== "" && decision !== "none";

/** Decisions that mean the team is still working on the tender. */
const ACTIVE_DECISIONS: ReviewDecision[] = ["GO", "REVIEW", "WATCH"];

/**
 * One page of tenders for the inbox, one row per tender, nearest deadline first. By
 * default the current matches of active profiles, plus tenders whose latest
 * decision is GO, REVIEW or WATCH even when no profile matches them any more
 * (a paused profile, or a tender that fell out of scope). With a concrete
 * decision filter every tender carrying that decision, matched or not, so a
 * decided tender can always be found again.
 */
export async function loadInbox(db: AppDb, filters: Filters, pageSize = PAGE_SIZE) {
  const [profiles, [{ n: profileCount } = { n: 0 }]] = await Promise.all([
    db
      .select({ id: criteriaProfiles.id, name: criteriaProfiles.name })
      .from(criteriaProfiles)
      .where(eq(criteriaProfiles.active, true))
      .orderBy(asc(criteriaProfiles.name)),
    db.select({ n: sql<number>`count(*)::int` }).from(criteriaProfiles),
  ]);

  const latestReview = db.$with("latest_review").as(
    db
      .selectDistinctOn([tenderReviews.tenderId], {
        tenderId: tenderReviews.tenderId,
        decision: tenderReviews.decision,
        decidedAt: tenderReviews.decidedAt,
      })
      .from(tenderReviews)
      .orderBy(tenderReviews.tenderId, desc(tenderReviews.decidedAt)),
  );

  const history = isConcreteDecision(filters.decision);
  const conditions: SQL[] = [];
  if (filters.profile) conditions.push(eq(profileMatches.profileId, filters.profile));
  if (filters.source) conditions.push(eq(tenders.source, filters.source));
  if (filters.status === "open") conditions.push(openTender());
  if (filters.status === "closed") conditions.push(sql`not (${openTender()})`);
  if (filters.decision === "none") conditions.push(isNull(latestReview.decision));
  if (filters.assessment === "none") conditions.push(isNull(tenderAssessments.status));
  else if (filters.assessment) conditions.push(inArray(tenderAssessments.status, [...STATUS_GROUPS[filters.assessment]]));
  // Out of scope (a services lot let through, say) stays out of the everyday
  // list (team decision, 14 October 2026) unless the team is working on it;
  // "Elenen" shows it.
  else if (!history) {
    conditions.push(or(sql`${tenderAssessments.status} is distinct from 'HARD_REJECT'`, inArray(latestReview.decision, ACTIVE_DECISIONS))!);
  }
  if (history) conditions.push(eq(latestReview.decision, filters.decision as ReviewDecision));
  else conditions.push(or(isNotNull(profileMatches.profileId), inArray(latestReview.decision, ACTIVE_DECISIONS))!);

  // In the decision view every match row is joined; "new" counts only current matches of active profiles.
  const currentMatch = sql`${profileMatches.unmatchedAt} is null and ${criteriaProfiles.active}`;
  // Most promising status first (the order of STATUSES), then the higher fit.
  const statusRank = sql`array_position(${sql.raw(`array[${STATUSES.map((s) => `'${s}'`).join(", ")}]::text[]`)}, ${tenderAssessments.status})`;

  const fields = {
    tenderId: tenders.id,
    title: tenders.title,
    buyerName: tenders.buyerName,
    buyerCountry: tenders.buyerCountry,
    source: tenders.source,
    contractNature: tenders.contractNature,
    cpvMain: tenders.cpvMain,
    valueEur: tenders.valueEur,
    valueAmount: tenders.valueAmount,
    valueCurrency: tenders.valueCurrency,
    submissionDeadline: tenders.submissionDeadline,
    changedAt: tenders.changedAt,
    documentsPortalUrl: tenders.documentsPortalUrl,
    decision: latestReview.decision,
    decidedAt: latestReview.decidedAt,
    // With a decision filter the tender may have no match rows at all.
    profiles: sql<string[]>`coalesce(array_remove(array_agg(distinct ${criteriaProfiles.name}), null), '{}')`,
    isNew: sql<boolean>`coalesce(bool_or(${profileMatches.state} = 'new') filter (where ${currentMatch}), false)`,
    current: sql<boolean>`coalesce(bool_or(${currentMatch}), false)`,
    assessmentStatus: tenderAssessments.status,
    assessmentExplanation: tenderAssessments.explanation,
    fitLow: tenderAssessments.fitLow,
    fitHigh: tenderAssessments.fitHigh,
    // Counted before LIMIT and OFFSET, so it is the total over all pages.
    total: sql<number>`(count(*) over ())::int`,
  };

  // One row per tender; the page applies to tenders, not to match rows.
  // Built afresh for each run: Drizzle builders are not reusable.
  const base = () =>
    history
      ? db
          .with(latestReview)
          .select(fields)
          .from(tenders)
          .innerJoin(latestReview, eq(latestReview.tenderId, tenders.id))
          .leftJoin(tenderAssessments, eq(tenderAssessments.tenderId, tenders.id))
          .leftJoin(profileMatches, eq(profileMatches.tenderId, tenders.id))
          .leftJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
      : db
          .with(latestReview)
          .select(fields)
          .from(tenders)
          .leftJoin(latestReview, eq(latestReview.tenderId, tenders.id))
          .leftJoin(tenderAssessments, eq(tenderAssessments.tenderId, tenders.id))
          // Only current matches of active profiles take part.
          .leftJoin(
            profileMatches,
            and(
              eq(profileMatches.tenderId, tenders.id),
              isNull(profileMatches.unmatchedAt),
              sql`${profileMatches.profileId} in (select id from ${criteriaProfiles} where active)`,
            ),
          )
          .leftJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId));

  const run = (limit: number, offset: number) =>
    base()
      .where(and(...conditions))
      .groupBy(tenders.id, latestReview.decision, latestReview.decidedAt, tenderAssessments.tenderId)
      .orderBy(
        ...(filters.sort === "assessment"
          ? [sql`${statusRank} asc nulls last`, sql`(${tenderAssessments.fitLow} + ${tenderAssessments.fitHigh}) desc nulls last`]
          : []),
        sql`${tenders.submissionDeadline} asc nulls last`,
        asc(tenders.id),
      )
      .limit(limit)
      .offset(offset);

  const rows = await run(pageSize, (filters.page - 1) * pageSize);
  // A page past the end (tenders closed or got decided meanwhile) still reports the total.
  const total = rows[0]?.total ?? (filters.page > 1 ? ((await run(1, 0))[0]?.total ?? 0) : 0);
  const extras = await pageExtras(db, rows.map((r) => r.tenderId));
  const list = rows.map((row) => ({ ...row, ...(extras.get(row.tenderId) ?? { documentCount: 0, titleTr: null }) }));
  return { profiles, hasAnyProfile: profileCount > 0, list, total };
}

/** For the tenders on one page only: the number of document links and the Turkish title. */
async function pageExtras(db: AppDb, tenderIds: string[]) {
  const extras = new Map<string, { documentCount: number; titleTr: string | null }>();
  if (!tenderIds.length) return extras;
  const [counts, translations] = await Promise.all([
    db
      .select({ tenderId: documents.tenderId, n: sql<number>`count(*)::int` })
      .from(documents)
      .where(inArray(documents.tenderId, tenderIds))
      .groupBy(documents.tenderId),
    latestTranslations(db, tenderIds),
  ]);
  for (const id of tenderIds) extras.set(id, { documentCount: 0, titleTr: translations.get(id)?.title ?? null });
  for (const row of counts) extras.get(row.tenderId)!.documentCount = row.n;
  return extras;
}
