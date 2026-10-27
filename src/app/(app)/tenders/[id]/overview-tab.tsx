import { DueChip } from "@/components/due-chip";
import { EmptyState } from "@/components/empty-state";
import { FormattedText } from "@/components/formatted-text";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Lot, TenderReview } from "@/db/schema";
import { DECISION_LABELS, formatDate, formatDateTime, formatMoney, lotLabel, type ReviewDecision } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DecisionForm } from "./decision-form";
import { Mark } from "./fact-grid";
import type { MatchRow, TimelineStep } from "./tender-view";

// The overview tab: on the left what is bought (the notice's text, its CPV
// codes and lots), the timeline, why the tender matches, then the
// assessment's detail and the facts it rests on; on the right the
// assessment's short summary and the team's decision (SPEC section 8).

type Props = {
  description: { text: string; original: string | null; language: string | null } | null;
  cpvs: string[];
  lots: Lot[];
  lotTitlesTr: Map<string, string>;
  lotDescriptionsTr: Map<string, string>;
  timeline: TimelineStep[];
  matches: MatchRow[];
  /** The assessment's short summary, first in the right column. */
  summary: React.ReactNode;
  /** The assessment's detail and its facts, in the main column after the match reasons. */
  assessment: React.ReactNode;
  tenderId: string;
  decision: ReviewDecision | null;
  reviews: TenderReview[];
  now: Date;
};

export function OverviewTab(props: Props) {
  return (
    <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-[18px]">
        <SubjectCard description={props.description} cpvs={props.cpvs} />
        <LotsCard lots={props.lots} titlesTr={props.lotTitlesTr} descriptionsTr={props.lotDescriptionsTr} />
        <TimelineCard steps={props.timeline} now={props.now} />
        <MatchCard matches={props.matches} />
        {props.assessment}
      </div>
      <div className="flex min-w-0 flex-col gap-[18px]">
        {props.summary}
        <DecisionCard tenderId={props.tenderId} decision={props.decision} reviews={props.reviews} />
      </div>
    </div>
  );
}

function SubjectCard({ description, cpvs }: { description: Props["description"]; cpvs: string[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>İhale konusu</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {description ? (
          <>
            <FormattedText text={description.text} className="text-sm leading-relaxed text-ink-900" />
            {description.original && (
              <details className="text-sm">
                <summary className="cursor-pointer text-ink-500 hover:text-ink-900">Orijinal metin ({description.language ?? "?"})</summary>
                <FormattedText text={description.original} className="mt-2 text-ink-700" />
              </details>
            )}
          </>
        ) : (
          <EmptyState>İlanda açıklama yok.</EmptyState>
        )}
        {cpvs.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">CPV</span>
            <ul className="flex flex-wrap gap-1.5">
              {cpvs.map((cpv, i) => (
                <li key={cpv} className={cn("border px-1.5 py-0.5 font-mono text-xs", i === 0 ? "border-ink-900 text-ink-900" : "border-line text-ink-600")} title={i === 0 ? "Ana CPV" : undefined}>
                  {cpv}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LotsCard({ lots, titlesTr, descriptionsTr }: { lots: Lot[]; titlesTr: Map<string, string>; descriptionsTr: Map<string, string> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lotlar · {lots.length}</CardTitle>
      </CardHeader>
      {lots.length ? (
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
            {lots.map((lot) => {
              const description = descriptionsTr.get(lot.lotNumber) || lot.description;
              return (
                <TableRow key={lot.id}>
                  <TableCell className="px-4 font-mono text-xs whitespace-nowrap text-ink-600">{lotLabel(lot.lotNumber)}</TableCell>
                  <TableCell className="px-4 py-3 whitespace-normal" title={titlesTr.get(lot.lotNumber) ? (lot.title ?? undefined) : undefined}>
                    {titlesTr.get(lot.lotNumber) || lot.title || "Belirtilmemiş"}
                    {description && (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-ink-500 hover:text-ink-900">Açıklama</summary>
                        <FormattedText text={description} className="mt-1 text-ink-700" />
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="px-4 font-mono text-xs whitespace-normal text-ink-600">{lot.cpv.join(", ") || "Belirtilmemiş"}</TableCell>
                  <TableCell className="px-4 text-right font-mono text-xs whitespace-nowrap">{formatMoney(lot.valueAmount, lot.valueCurrency)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <CardContent>
          <EmptyState>İlanda lot bilgisi yok.</EmptyState>
        </CardContent>
      )}
    </Card>
  );
}

const STEP_MARK: Record<TimelineStep["state"], string> = {
  past: "border-ink-900 bg-ink-900",
  next: "border-ink-900 bg-surface",
  later: "border-line-strong bg-surface",
};

function TimelineCard({ steps, now }: { steps: TimelineStep[]; now: Date }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Takvim</CardTitle>
      </CardHeader>
      <CardContent>
        {steps.length ? (
          <ol className="flex flex-col">
            {steps.map((step, i) => (
              <li key={step.label} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span aria-hidden className={cn("mt-1 size-2.5 shrink-0 border-2", STEP_MARK[step.state])} />
                  {i < steps.length - 1 && <span aria-hidden className="w-px flex-1 bg-line" />}
                </div>
                <div className={cn("flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1", i < steps.length - 1 && "pb-4")}>
                  <span className={cn("text-sm", step.state === "later" ? "text-ink-500" : "text-ink-900", step.state === "next" && "font-medium")}>
                    {step.label}
                    {step.state === "past" && <span className="sr-only"> (geçti)</span>}
                    {step.state === "next" && <span className="sr-only"> (sıradaki)</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn("font-mono text-xs", step.state === "later" ? "text-ink-500" : "text-ink-700")}>
                      {step.label === "Yayın" ? formatDate(step.at) : formatDateTime(step.at)}
                    </span>
                    {step.state !== "past" && <DueChip deadline={step.at} now={now} />}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState>İlanda tarih bilgisi yok.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function MatchCard({ matches }: { matches: MatchRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Eşleşme nedenleri</CardTitle>
      </CardHeader>
      <CardContent>
        {matches.length ? (
          <ul className="flex flex-col gap-4">
            {matches.map((m) => (
              <li key={m.profileId} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-900">{m.name}</span>
                  {!m.active && <Badge>Pasif profil</Badge>}
                  {m.unmatchedAt && <Badge variant="warn">{formatDate(m.unmatchedAt)} tarihinden beri uymuyor</Badge>}
                </div>
                <ul className="flex flex-col gap-1 text-[13px]">
                  {m.held.map((reason, i) => (
                    <li key={`held-${i}`} className="flex items-start gap-2 text-ink-700">
                      <Mark state="held" className="mt-1.5" />
                      <span>
                        <span className="sr-only">Tutan kural: </span>
                        {reason}
                      </span>
                    </li>
                  ))}
                  {m.failed.map((reason, i) => (
                    <li key={`failed-${i}`} className="flex items-start gap-2 text-ink-500">
                      <Mark state="off" className="mt-1.5" />
                      <span>
                        <span className="sr-only">Tutmayan kural: </span>
                        {reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>Bu ihale hiçbir profille eşleşmedi.</EmptyState>
        )}
      </CardContent>
    </Card>
  );
}

function DecisionCard({ tenderId, decision, reviews }: { tenderId: string; decision: ReviewDecision | null; reviews: TenderReview[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Karar</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <p className="text-sm font-medium text-ink-900">{decision ? DECISION_LABELS[decision] : <span className="font-normal text-ink-500">Karar verilmedi</span>}</p>
        <DecisionForm tenderId={tenderId} current={decision} />
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <span className="eyebrow">Karar geçmişi</span>
          {reviews.length ? (
            <ol className="flex flex-col gap-3 text-sm">
              {reviews.map((review) => (
                <li key={review.id} className="flex flex-col gap-0.5 border-l-2 border-line-strong pl-3">
                  <span className="font-medium text-ink-900">{review.decision ? DECISION_LABELS[review.decision] : "Karar geri alındı"}</span>
                  {review.note && <span className="whitespace-pre-line text-ink-700">{review.note}</span>}
                  <span className="font-mono text-[11px] text-ink-500">
                    {review.decidedBy} · {formatDateTime(review.decidedAt)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState>Henüz karar verilmedi.</EmptyState>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
