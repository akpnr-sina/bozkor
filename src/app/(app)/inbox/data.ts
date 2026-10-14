import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db";
import { criteriaProfiles, documents, profileMatches, reviewDecision, tenderReviews, tenders } from "@/db/schema";
import type { ReviewDecision } from "@/lib/format";
import { openTender } from "@/matching/apply";
import { sourceIds } from "@/matching/rules";

const ROW_LIMIT = 500;

export type Filters = {
  profile: string;
  source: string;
  status: "open" | "closed" | "all";
  decision: "" | "none" | ReviewDecision;
};

export function readFilters(params: Record<string, string | string[] | undefined>): Filters {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };
  const status = one("status");
  const decision = one("decision");
  const profile = one("profile");
  return {
    profile: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile) ? profile : "",
    source: (sourceIds as readonly string[]).includes(one("source")) ? one("source") : "",
    status: status === "closed" || status === "all" ? status : "open",
    decision:
      decision === "none" || (reviewDecision.enumValues as readonly string[]).includes(decision)
        ? (decision as Filters["decision"])
        : "",
  };
}

const isConcreteDecision = (decision: Filters["decision"]): decision is ReviewDecision =>
  decision !== "" && decision !== "none";

/** Decisions that mean the team is still working on the tender. */
const ACTIVE_DECISIONS: ReviewDecision[] = ["GO", "REVIEW", "WATCH"];

/**
 * Tenders for the inbox, one row per tender, nearest deadline first. By
 * default the current matches of active profiles, plus tenders whose latest
 * decision is GO, REVIEW or WATCH even when no profile matches them any more
 * (a paused profile, or a tender that fell out of scope). With a concrete
 * decision filter every tender carrying that decision, matched or not, so a
 * decided tender can always be found again.
 */
export async function loadInbox(db: AppDb, filters: Filters, limit = ROW_LIMIT) {
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
  if (history) conditions.push(eq(latestReview.decision, filters.decision as ReviewDecision));
  else conditions.push(or(isNotNull(profileMatches.profileId), inArray(latestReview.decision, ACTIVE_DECISIONS))!);

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
    isNew: sql<boolean>`coalesce(bool_or(${profileMatches.state} = 'new'), false)`,
    current: sql<boolean>`coalesce(bool_or(${profileMatches.unmatchedAt} is null and ${criteriaProfiles.active}), false)`,
    bestScore: sql<number | null>`max(${profileMatches.triageScore})`,
    documentCount: sql<number>`(select count(*)::int from ${documents} where ${documents.tenderId} = ${tenders.id})`,
    total: sql<number>`(count(*) over ())::int`,
  };

  // One row per tender; the limit applies to tenders, not to match rows.
  const base = history
    ? db
        .with(latestReview)
        .select(fields)
        .from(tenders)
        .innerJoin(latestReview, eq(latestReview.tenderId, tenders.id))
        .leftJoin(profileMatches, eq(profileMatches.tenderId, tenders.id))
        .leftJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
    : db
        .with(latestReview)
        .select(fields)
        .from(tenders)
        .leftJoin(latestReview, eq(latestReview.tenderId, tenders.id))
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

  const rows = await base
    .where(and(...conditions))
    .groupBy(tenders.id, latestReview.decision, latestReview.decidedAt)
    .orderBy(sql`${tenders.submissionDeadline} asc nulls last`, asc(tenders.id))
    .limit(limit);

  return { profiles, hasAnyProfile: profileCount > 0, list: rows, total: rows[0]?.total ?? 0 };
}
