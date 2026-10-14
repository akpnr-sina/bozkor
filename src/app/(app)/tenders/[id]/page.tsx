import { asc, desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { criteriaProfiles, documents, documentFetchStatus, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import {
  CONTRACT_NATURE_LABELS,
  DECISION_LABELS,
  daysLeft,
  formatDate,
  formatDateTime,
  formatDaysLeft,
  formatMoney,
  NOTICE_TYPE_LABELS,
  REGIME_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
} from "@/lib/format";
import { describeReason, parseReasons } from "@/matching/describe";
import { isProductScope } from "@/sources/scope";
import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "İhale" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FETCH_STATUS_LABELS: Record<(typeof documentFetchStatus.enumValues)[number], string> = {
  pending: "Henüz indirilmedi",
  fetched: "İndirildi",
  needs_manual: "Elle yüklenmeli",
  failed: "İndirilemedi",
  unsupported: "Desteklenmeyen biçim",
};

export default function TenderPage(props: PageProps<"/tenders/[id]">) {
  return (
    <div className="flex flex-col gap-6">
      <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
        Gelen kutusuna dön
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
        <TenderDetail params={props.params} />
      </Suspense>
    </div>
  );
}

async function loadTender(id: string) {
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const db = getDb();
  const [tender] = await db.select().from(tenders).where(eq(tenders.id, id));
  if (!tender) return null;
  const [lotRows, documentRows, matchRows, reviewRows] = await Promise.all([
    db.select().from(lots).where(eq(lots.tenderId, id)).orderBy(asc(lots.lotNumber)),
    db.select().from(documents).where(eq(documents.tenderId, id)).orderBy(asc(documents.createdAt)),
    db
      .select({
        profileId: profileMatches.profileId,
        profileName: criteriaProfiles.name,
        profileActive: criteriaProfiles.active,
        reasons: profileMatches.filterReasons,
        unmatchedAt: profileMatches.unmatchedAt,
      })
      .from(profileMatches)
      .innerJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
      .where(eq(profileMatches.tenderId, id))
      .orderBy(asc(criteriaProfiles.name)),
    db.select().from(tenderReviews).where(eq(tenderReviews.tenderId, id)).orderBy(desc(tenderReviews.decidedAt)),
  ]);
  return { tender, lots: lotRows, documents: documentRows, matches: matchRows, reviews: reviewRows };
}

async function TenderDetail({ params }: { params: PageProps<"/tenders/[id]">["params"] }) {
  await getCurrentUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const data = await loadTender(id);
  if (!data) notFound();
  const { tender, reviews } = data;
  const now = new Date();
  const current = reviews[0] ?? null;
  const cpvs = [tender.cpvMain, ...tender.cpvAdditional].filter((c): c is string => !!c);
  // A change the team has already decided on after does not need the badge.
  const changedSinceDecision = tender.changedAt && (!current || tender.changedAt > current.decidedAt);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-8">
        <header className="flex flex-col gap-3">
          <h1 className="text-xl font-semibold">{tender.title}</h1>
          <div className="flex flex-wrap gap-2">
            <Badge variant={tender.status === "open" ? "default" : "secondary"}>{STATUS_LABELS[tender.status]}</Badge>
            {tender.noticeType && <Badge variant="outline">{NOTICE_TYPE_LABELS[tender.noticeType] ?? tender.noticeType}</Badge>}
            <Badge variant="outline">{REGIME_LABELS[tender.regime]}</Badge>
            {tender.contractNature && <Badge variant="outline">{CONTRACT_NATURE_LABELS[tender.contractNature]}</Badge>}
            {!isProductScope(tender.contractNature, tender.cpvMain) && (
              <Badge variant="destructive" title="Sadece mal alımları takip ediliyor. Bu ihale kararınız olduğu için duruyor, profillerle eşleşmez.">
                Kapsam dışı
              </Badge>
            )}
            <Badge variant="outline">{SOURCE_LABELS[tender.source as keyof typeof SOURCE_LABELS] ?? tender.source}</Badge>
            {changedSinceDecision && <Badge variant="destructive">Değişti: {formatDate(tender.changedAt)}</Badge>}
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            {tender.noticeUrl && (
              <a href={tender.noticeUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Orijinal ilan
              </a>
            )}
            {tender.documentsPortalUrl && (
              <a href={tender.documentsPortalUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Doküman portalı
              </a>
            )}
          </div>
        </header>

        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label="Alıcı" value={tender.buyerName ?? "Belirtilmemiş"} />
          <Fact label="Ülke / bölge" value={[tender.buyerCountry, tender.nutsCode].filter(Boolean).join(" / ") || "Belirtilmemiş"} />
          <Fact
            label="Tahmini değer"
            value={
              tender.valueEur !== null && tender.valueCurrency !== "EUR"
                ? `${formatMoney(tender.valueAmount, tender.valueCurrency)} (${formatMoney(tender.valueEur, "EUR")})`
                : formatMoney(tender.valueAmount, tender.valueCurrency)
            }
          />
          <Fact label="Usul" value={tender.procedureType ?? "Belirtilmemiş"} />
          <Fact label="Yayın tarihi" value={formatDate(tender.publishedAt)} />
          <Fact
            label="Son teklif tarihi"
            value={
              tender.submissionDeadline
                ? `${formatDateTime(tender.submissionDeadline)} (${formatDaysLeft(daysLeft(tender.submissionDeadline, now))})`
                : "Belirtilmemiş"
            }
          />
          <Fact label="Soru sorma son tarihi" value={formatDateTime(tender.clarificationDeadline)} />
          <Fact label="İlan dili / numarası" value={`${tender.noticeLanguage ?? "?"} / ${tender.externalId}`} />
          <Fact label="CPV" value={cpvs.length ? cpvs.join(", ") : "Belirtilmemiş"} wide />
        </dl>

        {tender.description && (
          <Section title="Açıklama">
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Açıklamayı göster</summary>
              <p className="mt-2 whitespace-pre-line">{tender.description}</p>
            </details>
          </Section>
        )}

        <Section title="Eşleşme nedenleri">
          {data.matches.length ? (
            <ul className="flex flex-col gap-3 text-sm">
              {data.matches.map((m) => (
                <li key={m.profileId} className="flex flex-col gap-1">
                  <span className="font-medium">
                    {m.profileName}
                    {!m.profileActive && <span className="font-normal text-muted-foreground"> (pasif profil)</span>}
                    {m.unmatchedAt && (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        ({formatDate(m.unmatchedAt)} tarihinden beri kriterlere uymuyor)
                      </span>
                    )}
                  </span>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {parseReasons(m.reasons).map((reason, i) => (
                      <li key={i}>{describeReason(reason)}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>Bu ihale hiçbir profille eşleşmedi.</Empty>
          )}
        </Section>

        <Section title={`Lotlar (${data.lots.length})`}>
          {data.lots.length ? (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lot</TableHead>
                    <TableHead>Başlık</TableHead>
                    <TableHead>CPV</TableHead>
                    <TableHead className="text-right">Değer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lots.map((lot) => (
                    <TableRow key={lot.id}>
                      <TableCell>{lot.lotNumber}</TableCell>
                      <TableCell className="whitespace-normal">{lot.title ?? "Belirtilmemiş"}</TableCell>
                      <TableCell className="whitespace-normal">{lot.cpv.join(", ") || "Belirtilmemiş"}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(lot.valueAmount, lot.valueCurrency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Empty>İlanda lot bilgisi yok.</Empty>
          )}
        </Section>

        <Section title="AI ön değerlendirmesi">
          <Empty>Henüz yok. Triage puanı bir sonraki aşamada eklenecek.</Empty>
        </Section>

        <Section title={`Dokümanlar (${data.documents.length})`}>
          {data.documents.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {data.documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {doc.sourceUrl ? (
                    <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4 wrap-anywhere">
                      {doc.title ?? doc.filename ?? doc.sourceUrl}
                    </a>
                  ) : (
                    <span>{doc.title ?? doc.filename ?? "Adsız doküman"}</span>
                  )}
                  <span className="text-muted-foreground">{FETCH_STATUS_LABELS[doc.fetchStatus]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>İlanda doküman linki yok. Dokümanlar genelde doküman portalında.</Empty>
          )}
        </Section>

        <Section title="Derin analiz">
          <Empty>Henüz yok. Doküman analizi ilerleyen aşamada eklenecek.</Empty>
        </Section>
      </div>

      <aside className="flex flex-col gap-6">
        <Section title="Karar">
          <p className="text-sm">
            {current?.decision ? DECISION_LABELS[current.decision] : <span className="text-muted-foreground">Karar verilmedi</span>}
          </p>
          <DecisionForm tenderId={tender.id} current={current?.decision ?? null} />
        </Section>
        <Section title="Karar geçmişi">
          {reviews.length ? (
            <ol className="flex flex-col gap-3 text-sm">
              {reviews.map((review) => (
                <li key={review.id} className="flex flex-col gap-0.5 border-l-2 pl-3">
                  <span className="font-medium">
                    {review.decision ? DECISION_LABELS[review.decision] : "Karar geri alındı"}
                  </span>
                  {review.note && <span className="whitespace-pre-line">{review.note}</span>}
                  <span className="text-xs text-muted-foreground">
                    {review.decidedBy}, {formatDateTime(review.decidedAt)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Henüz karar verilmedi.</Empty>
          )}
        </Section>
      </aside>
    </div>
  );
}

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "flex flex-col gap-0.5 sm:col-span-2" : "flex flex-col gap-0.5"}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="wrap-anywhere">{value}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
