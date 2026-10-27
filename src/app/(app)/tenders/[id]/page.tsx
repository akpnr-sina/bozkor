import { and, asc, desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { StatStrip } from "@/components/stat-strip";
import { TabNav } from "@/components/tab-nav";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/db";
import { isConnectionLost, retryRead } from "@/db/retry";
import { analyses, criteriaProfiles, deepRequests, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { sourcesHash } from "@/analysis/evidence";
import { monthlyLlmSpend } from "@/analysis/budget";
import { loadDeepView } from "@/analysis/deep-view";
import { isFactsPending } from "@/analysis/facts";
import { byLotNumber, toTriageNotice } from "@/analysis/notice";
import { latestTranslations } from "@/analysis/translations";
import { noticeQuoteSources } from "@/analysis/triage-input";
import { isFetchWanted } from "@/documents/fetch-job";
import { loadTenderDocuments } from "@/documents/queries";
import { uploadsConfigured } from "@/documents/storage";
import { loadRateTable } from "@/fx/rates";
import { latestFacts, policyInputOf } from "@/policy/assess";
import { assessTender } from "@/policy/engine";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { loadCategories } from "@/matching/apply";
import { matchTender } from "@/matching/engine";
import type { SourceId } from "@/sources/types";
import { AssessmentDetail, AssessmentFacts, AssessmentSummary } from "./assessment-card";
import { assessmentView, decidingFacts } from "./assessment-view";
import { DeepAnalysisCard } from "./deep-analysis-card";
import { documentName } from "./document-state";
import { DocumentUpload } from "./document-upload";
import { DocumentsCard } from "./documents-card";
import { HistoryTab } from "./history-tab";
import { OverviewTab } from "./overview-tab";
import { TenderHeader } from "./tender-header";
import { deadlineWarning, documentsFigure, historyRows, matchRows, TABS, tabHref, tabOf, tenderFigures, timelineSteps } from "./tender-view";

export const metadata: Metadata = { title: "İhale" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function TenderPage(props: PageProps<"/tenders/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <Link href="/inbox" className="w-fit text-[13px] text-ink-500 hover:text-ink-900">
            Gelen kutusu
          </Link>
          <p className="text-sm text-ink-500">Yükleniyor...</p>
        </div>
      }
    >
      <TenderDetail params={props.params} searchParams={props.searchParams} />
    </Suspense>
  );
}

/** A read the page can do without: should it fail (a table not migrated yet, say), the rest of the page shows. */
const optional =
  <T,>(what: string, fallback: T) =>
  (error: unknown): T => {
    if (isConnectionLost(error)) throw error;
    console.error(`[tender page] ${what}:`, error);
    return fallback;
  };

async function loadTender(id: string) {
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const now = new Date();
  const db = getDb();
  const [tender] = await db.select().from(tenders).where(eq(tenders.id, id));
  if (!tender) return null;
  const [lotRows, documentList, matchRowsRead, reviewRows, categories] = await Promise.all([
    db.select().from(lots).where(eq(lots.tenderId, id)).orderBy(asc(lots.lotNumber)),
    // The notice's links in the order the facts stage reads them, so the fingerprints agree.
    loadTenderDocuments(db, id),
    db
      .select({
        profileId: profileMatches.profileId,
        profileName: criteriaProfiles.name,
        profileActive: criteriaProfiles.active,
        reasons: profileMatches.filterReasons,
        unmatchedAt: profileMatches.unmatchedAt,
        rules: criteriaProfiles.rules,
      })
      .from(profileMatches)
      .innerJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
      .where(eq(profileMatches.tenderId, id))
      .orderBy(asc(criteriaProfiles.name)),
    db.select().from(tenderReviews).where(eq(tenderReviews.tenderId, id)).orderBy(desc(tenderReviews.decidedAt)),
    // The taxonomy a profile's categories stand for: why a profile matches no more.
    loadCategories(db),
  ]);
  const [translations, latest, rates, [latestFactsAttempt], fetchWanted, factsPending, spend, deep, analysisRows, requestRows] = await Promise.all([
    latestTranslations(db, [id]),
    latestFacts(db, [id]).then((byTender) => byTender.get(id) ?? null),
    loadRateTable(db),
    // The newest facts attempt, to show a failure after the last valid result.
    db
      .select()
      .from(analyses)
      .where(and(eq(analyses.tenderId, id), eq(analyses.kind, "facts")))
      .orderBy(desc(analyses.createdAt))
      .limit(1),
    isFetchWanted(db, id),
    // The facts queue's own test: whether the stored facts wait to be extracted again.
    isFactsPending(db, id),
    monthlyLlmSpend(db),
    loadDeepView(db, id).catch(optional("deep analysis view", null)),
    // The history tab: every call made for the tender, with its cost.
    db
      .select({
        kind: analyses.kind,
        model: analyses.model,
        promptVersion: analyses.promptVersion,
        costUsd: analyses.costUsd,
        valid: analyses.valid,
        error: analyses.error,
        createdAt: analyses.createdAt,
      })
      .from(analyses)
      .where(eq(analyses.tenderId, id))
      .orderBy(desc(analyses.createdAt))
      .limit(200),
    db
      .select({
        status: deepRequests.status,
        requestedBy: deepRequests.requestedBy,
        requestedAt: deepRequests.requestedAt,
        finishedAt: deepRequests.finishedAt,
        error: deepRequests.error,
      })
      .from(deepRequests)
      .where(eq(deepRequests.tenderId, id))
      .orderBy(desc(deepRequests.requestedAt))
      .limit(50)
      .catch(optional("deep analysis requests", [])),
  ]);
  // The assessment as assessOne works it out, keeping the engine's input to
  // find the facts the status rests on.
  const policyInput = latest ? policyInputOf(tender, lotRows, latest.facts, rates, now) : null;
  const assessed = latest && policyInput ? { assessment: assessTender(policyInput), latest } : null;
  return {
    now,
    policyInput,
    tender,
    lots: lotRows.sort(byLotNumber),
    documents: documentList.documents,
    storedBytes: documentList.storedBytes,
    fetchWanted,
    factsPending,
    budgetExceeded: spend.exceeded,
    matches: matchRowsRead,
    categories,
    reviews: reviewRows,
    translation: translations.get(id) ?? null,
    assessed,
    latestFactsAttempt: latestFactsAttempt ?? null,
    deep,
    analyses: analysisRows,
    deepRequests: requestRows,
  };
}

async function TenderDetail({ params, searchParams }: { params: PageProps<"/tenders/[id]">["params"]; searchParams: PageProps<"/tenders/[id]">["searchParams"] }) {
  await getCurrentUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const tab = tabOf((await searchParams).tab);
  const data = await retryRead(() => loadTender(id));
  if (!data) notFound();
  const { tender, reviews, translation, now } = data;
  const uploadsEnabled = uploadsConfigured();
  const current = reviews[0] ?? null;
  const noticeHash = sourcesHash(noticeQuoteSources(toTriageNotice(tender, data.lots)));
  // A change the team has already decided on after does not need the badge.
  const changedSinceDecision = !!tender.changedAt && (!current || tender.changedAt > current.decidedAt);
  const warning = deadlineWarning(tender.submissionDeadline, now);
  const portal = tender.documentsPortalUrl;

  const figures = tenderFigures(
    {
      valueAmount: tender.valueAmount,
      valueCurrency: tender.valueCurrency,
      valueEur: tender.valueEur,
      submissionDeadline: tender.submissionDeadline,
      procedureType: tender.procedureType,
      buyerCountry: tender.buyerCountry,
      nutsCode: tender.nutsCode,
      fit: data.assessed?.assessment.best.scores.fit ?? null,
      documents: documentsFigure(data.documents, portal),
    },
    now,
  ).map((figure) => (figure.label === "Dokümanlar" ? { ...figure, href: tabHref(tender.id, "documents") } : figure));

  const fileNames = (data.assessed?.latest.documentIds ?? []).map((documentId) => {
    const doc = data.documents.find((d) => d.id === documentId);
    return doc ? documentName(doc) : "";
  });
  // Which facts the status rests on: the engine runs once more per known fact, so only for the tab that shows them.
  const assessment =
    tab === "overview" && data.assessed && data.policyInput
      ? assessmentView(data.assessed, tender.details ?? null, fileNames, decidingFacts(data.policyInput, data.assessed.latest.stored))
      : null;

  const history = historyRows({ tender, reviews, analyses: data.analyses, deepRequests: data.deepRequests });
  const tabs = TABS.map((t) => ({
    href: tabHref(tender.id, t.tab),
    label: t.label,
    count: t.tab === "documents" ? data.documents.length : t.tab === "history" ? history.length : null,
    active: t.tab === tab,
  }));

  return (
    <div className="flex flex-col gap-[18px]">
      <TenderHeader
        tender={tender}
        title={translation?.title || tender.title}
        originalTitle={translation?.title ? tender.title : null}
        translationOutdated={!!translation?.sourcesHash && translation.sourcesHash !== noticeHash}
        assessment={data.assessed?.assessment.best.status ?? null}
        changedSinceDecision={changedSinceDecision}
        decision={current?.decision ?? null}
      />

      {warning && tender.submissionDeadline && (
        <Notice
          tone="warn"
          title={warning.title}
          action={
            portal ? (
              <a href={portal} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Portalı aç<span className="sr-only"> (yeni sekmede açılır)</span>
              </a>
            ) : undefined
          }
        >
          Son teklif: {formatDateTime(tender.submissionDeadline)}
          {portal ? " · teklif alıcının portalından verilir." : ""}
        </Notice>
      )}

      <StatStrip size="md" items={figures} />

      <TabNav label="İhale bölümleri" items={tabs} />

      {tab === "overview" && (
        <OverviewTab
          description={
            tender.description
              ? translation?.description
                ? { text: translation.description, original: tender.description, language: tender.noticeLanguage }
                : { text: tender.description, original: null, language: tender.noticeLanguage }
              : null
          }
          cpvs={[tender.cpvMain, ...tender.cpvAdditional].filter((c): c is string => !!c)}
          lots={data.lots}
          lotTitlesTr={new Map(translation?.lots.map((lot) => [lot.lotNumber, lot.title]) ?? [])}
          lotDescriptionsTr={new Map(translation?.lots.map((lot) => [lot.lotNumber, lot.description]) ?? [])}
          timeline={timelineSteps(tender, now)}
          matches={matchRows(data.matches, (rules) =>
            matchTender(
              {
                source: tender.source as SourceId,
                noticeType: tender.noticeType,
                regime: tender.regime,
                contractNature: tender.contractNature,
                status: tender.status,
                title: tender.title,
                description: tender.description,
                buyerCountry: tender.buyerCountry,
                cpvMain: tender.cpvMain,
                cpvAdditional: tender.cpvAdditional,
                valueEur: tender.valueEur,
                submissionDeadline: tender.submissionDeadline,
                noticeLanguage: tender.noticeLanguage,
                lots: data.lots.map((lot) => ({ title: lot.title, description: lot.description, cpv: lot.cpv })),
              },
              rules,
              { categories: data.categories, now },
            ),
          )}
          summary={
            <AssessmentSummary
              result={data.assessed}
              latestAttempt={data.latestFactsAttempt}
              stale={!!data.assessed && data.factsPending}
              budgetExceeded={data.budgetExceeded}
              tenderId={tender.id}
              checks={assessment?.checks ?? []}
            />
          }
          assessment={
            data.assessed &&
            assessment && (
              <>
                <AssessmentFacts result={data.assessed} view={assessment} />
                <AssessmentDetail result={data.assessed} fileCount={data.assessed.latest.documentIds.length} />
              </>
            )
          }
          tenderId={tender.id}
          decision={current?.decision ?? null}
          reviews={reviews}
          now={now}
        />
      )}

      {tab === "deep" && <DeepAnalysisCard view={data.deep} tenderId={tender.id} />}

      {tab === "documents" && (
        <DocumentsCard
          tenderId={tender.id}
          documents={data.documents}
          storedBytes={data.storedBytes}
          portalUrl={portal}
          fetchWanted={data.fetchWanted}
          uploadsEnabled={uploadsEnabled}
          now={now}
          upload={<DocumentUpload tenderId={tender.id} disabledReason={uploadsEnabled ? null : "Dosya deposu henüz ayarlı değil; yükleme kapalı."} />}
        />
      )}

      {tab === "history" && <HistoryTab rows={history} />}
    </div>
  );
}
