"use client";

import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import { AssessmentBadge } from "@/components/assessment-badge";
import { DueChip } from "@/components/due-chip";
import { Meter } from "@/components/meter";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { countryName, DECISION_LABELS, DECISION_SHORT, formatDate, formatDateTime, formatMoney, SOURCE_LABELS } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isProductScope } from "@/sources/scope";
import type { DocumentSummary, InboxRow } from "./data";

// The inbox list and, on a wide screen, the summary of the selected tender
// next to it (the design's right panel). A click selects a row, the title or
// Enter opens the tender, the arrow keys move through the list. Below the
// panel's width a click opens the tender.

const WIDE = "(min-width: 1280px)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const useWide = () =>
  useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );

/** Columns that need a very wide screen; below it the summary panel (or the tender page) shows them. */
const EXTRA = "hidden min-[1720px]:table-cell";
/** Columns hidden on a phone, where the verdict goes under the title. */
const MAIN = "hidden md:table-cell";

const SOURCE_SHORT: Record<string, string> = { uk_fat: "Find a Tender", eu_ted: "TED" };

const fitOf = (row: InboxRow) => (row.fitLow !== null && row.fitHigh !== null ? Math.round((row.fitLow + row.fitHigh) / 2) : null);

export function InboxWorkspace({
  rows,
  now,
  top,
  empty,
  bottom,
}: {
  rows: InboxRow[];
  now: Date;
  top: React.ReactNode;
  empty: React.ReactNode;
  bottom: React.ReactNode;
}) {
  const router = useRouter();
  const wide = useWide();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((row) => row.tenderId === selectedId) ?? rows[0] ?? null;
  const rowElements = useRef(new Map<string, HTMLTableRowElement>());

  const open = (row: InboxRow) => router.push(`/tenders/${row.tenderId}`);
  const move = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setSelectedId(row.tenderId);
    rowElements.current.get(row.tenderId)?.focus();
  };

  return (
    <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="flex min-w-0 flex-col gap-[18px]">
        {top}
        {rows.length ? (
          <div className="border border-line bg-surface">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>İhale</TableHead>
                  <TableHead className={MAIN}>Değerlendirme</TableHead>
                  <TableHead className={MAIN}>Uyum</TableHead>
                  <TableHead className={EXTRA}>Doküman</TableHead>
                  <TableHead className={cn(EXTRA, "text-right")}>Değer (EUR)</TableHead>
                  <TableHead className={EXTRA}>Karar</TableHead>
                  <TableHead className="text-right">Kalan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  const isSelected = row.tenderId === selected?.tenderId;
                  const fit = fitOf(row);
                  return (
                    <TableRow
                      key={row.tenderId}
                      ref={(element) => {
                        if (element) rowElements.current.set(row.tenderId, element);
                        else rowElements.current.delete(row.tenderId);
                      }}
                      // One tab stop for the list (the selected row); the arrow keys move from there.
                      tabIndex={isSelected ? 0 : -1}
                      data-state={isSelected ? "selected" : undefined}
                      aria-current={isSelected && wide ? "true" : undefined}
                      onClick={() => (wide ? setSelectedId(row.tenderId) : open(row))}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter") open(row);
                        else if (event.key === "ArrowDown") {
                          event.preventDefault();
                          move(index + 1);
                        } else if (event.key === "ArrowUp") {
                          event.preventDefault();
                          move(index - 1);
                        }
                      }}
                      className="cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink-900 data-[state=selected]:bg-transparent xl:data-[state=selected]:bg-canvas"
                    >
                      <TableCell className="relative w-full max-w-0 py-2.5 whitespace-normal">
                        {isSelected && <span aria-hidden className="absolute inset-y-0 left-0 hidden w-0.5 bg-ink-900 xl:block" />}
                        <div className="flex min-w-0 flex-col gap-[3px]">
                          <div className="flex min-w-0 items-center gap-2">
                            <Link
                              href={`/tenders/${row.tenderId}`}
                              onClick={(event) => event.stopPropagation()}
                              className="truncate text-sm font-medium underline-offset-4 hover:underline"
                            >
                              {row.titleTr ?? row.title}
                            </Link>
                            <RowBadges row={row} />
                          </div>
                          <span className="truncate text-xs text-ink-500">
                            {[row.buyerName, countryName(row.buyerCountry), SOURCE_SHORT[row.source] ?? row.source].filter(Boolean).join(" · ")}
                          </span>
                          {row.assessmentExplanation && (
                            <span className="line-clamp-2 text-[13px] text-ink-600 xl:hidden">{row.assessmentExplanation}</span>
                          )}
                          <span className="pt-1 md:hidden">
                            {row.assessmentStatus ? <AssessmentBadge status={row.assessmentStatus} /> : <Badge dot>Sırada</Badge>}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className={MAIN}>
                        {row.assessmentStatus ? <AssessmentBadge status={row.assessmentStatus} /> : <Badge dot>Sırada</Badge>}
                      </TableCell>
                      <TableCell className={MAIN}>
                        {fit !== null ? (
                          <span
                            className="flex items-center gap-2.5"
                            title={`Fırsat uyumu. İlanda bilinmeyen ölçütlerle aralık ${row.fitLow}-${row.fitHigh}; gösterilen ortası.`}
                          >
                            <span className="w-6 font-mono text-[13px]">{fit}</span>
                            <Meter value={fit} label="Uyum" />
                          </span>
                        ) : (
                          <span className="text-ink-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className={EXTRA}>
                        <DocumentsText summary={row.documents} />
                      </TableCell>
                      <TableCell className={cn(EXTRA, "text-right font-mono text-[13px]")}>
                        <Value row={row} />
                      </TableCell>
                      <TableCell className={cn(EXTRA, "font-mono text-xs")}>
                        {row.decision ? DECISION_SHORT[row.decision] : <span className="text-ink-400">-</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <DueChip deadline={row.submissionDeadline} now={now} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          empty
        )}
        {bottom}
      </div>
      {selected && <Summary row={selected} now={now} />}
    </div>
  );
}

function RowBadges({ row }: { row: InboxRow }) {
  const changed = row.changedAt && (!row.decidedAt || row.changedAt > row.decidedAt);
  const outOfScope = !isProductScope(row.contractNature, row.cpvMain);
  return (
    <>
      {row.isNew && (
        <Badge variant="info" className="shrink-0">
          Yeni
        </Badge>
      )}
      {changed && (
        <Badge variant="warn" className="shrink-0">
          Değişti
        </Badge>
      )}
      {outOfScope ? (
        <Badge variant="outline" className="shrink-0" title="Sadece mal alımları takip ediliyor; kararınız olduğu için listede.">
          Kapsam dışı
        </Badge>
      ) : (
        !row.current && (
          <Badge variant="outline" className="shrink-0">
            Artık eşleşmiyor
          </Badge>
        )
      )}
    </>
  );
}

function Value({ row }: { row: InboxRow }) {
  if (row.valueEur !== null) return <>{formatMoney(row.valueEur, "EUR")}</>;
  if (row.valueAmount !== null) return <span className="text-ink-500">{formatMoney(row.valueAmount, row.valueCurrency)}</span>;
  return <span className="text-ink-400">Yok</span>;
}

/** The short word shows; the explanation is a tooltip, and read out by screen readers. */
function DocumentsText({ summary }: { summary: DocumentSummary }) {
  const cell = (text: string, explanation: string, muted = false) => (
    <span title={explanation} className={cn("text-[13px]", muted && "text-ink-500")}>
      {text}
      <span className="sr-only">: {explanation}</span>
    </span>
  );
  switch (summary.state) {
    case "files":
      return cell(`${summary.files} dosya`, "okunmuş, analize girecek dosyalar");
    case "reading":
      return cell("Okunuyor", "dosyalar depoda, worker okuyor", true);
    case "portal":
      return cell("Portal", "dokümanlar alıcının portalında; ihale sayfasından portala gidip indirin ve yükleyin");
    default:
      return <span className="text-ink-400">-</span>;
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface px-3 py-2.5">
      <dt className="font-heading text-[10px] font-medium tracking-[0.12em] text-ink-500 uppercase">{label}</dt>
      <dd className="text-[13px]">{children}</dd>
    </div>
  );
}

/** The selected tender at a glance, without leaving the list. */
function Summary({ row, now }: { row: InboxRow; now: Date }) {
  const fit = fitOf(row);
  return (
    <aside
      aria-label="Seçili ihalenin özeti"
      className="sticky top-[84px] hidden max-h-[calc(100svh-108px)] flex-col self-start border border-line bg-surface xl:flex"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="truncate font-mono text-xs text-ink-500">{row.externalId}</span>
            {row.assessmentStatus ? <AssessmentBadge status={row.assessmentStatus} /> : <Badge dot>Sırada</Badge>}
          </div>
          <h2 className="text-lg leading-snug font-semibold text-pretty">{row.titleTr ?? row.title}</h2>
          {row.titleTr && <p className="text-[13px] text-ink-500">{row.title}</p>}
          <p className="text-[13px] text-ink-600">{[row.buyerName, countryName(row.buyerCountry)].filter(Boolean).join(" · ")}</p>
          <div className="flex flex-wrap gap-1.5 empty:hidden">
            <RowBadges row={row} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-px border border-line bg-line">
          <Fact label="Değer">
            <span className="font-mono">
              <Value row={row} />
            </span>
          </Fact>
          <Fact label="Son teklif">
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span className="font-mono">{formatDate(row.submissionDeadline)}</span>
              <DueChip deadline={row.submissionDeadline} now={now} className="px-1 py-0" />
            </span>
          </Fact>
          <Fact label="Kaynak">{SOURCE_LABELS[row.source as keyof typeof SOURCE_LABELS] ?? row.source}</Fact>
          <Fact label="Dokümanlar">
            <DocumentsText summary={row.documents} />
          </Fact>
        </dl>
        {(row.assessmentExplanation || fit !== null) && (
          <section className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="eyebrow">Değerlendirme</h3>
              {fit !== null && (
                <span className="font-heading text-2xl leading-none font-medium">
                  {fit}
                  <span className="text-[13px] text-ink-400"> / 100</span>
                </span>
              )}
            </div>
            {fit !== null && <Meter value={fit} label="Uyum" className="w-full" />}
            {row.assessmentExplanation && <p className="text-[13px] leading-relaxed">{row.assessmentExplanation}</p>}
            {fit !== null && row.fitLow !== row.fitHigh && (
              <p className="text-xs text-ink-500">
                İlanda bilinmeyen ölçütlerle uyum aralığı {row.fitLow}-{row.fitHigh}.
              </p>
            )}
          </section>
        )}
        <section className="flex flex-col gap-2.5">
          <h3 className="eyebrow">Eşleşen profiller · {row.profiles.length}</h3>
          {row.profiles.length ? (
            <div className="flex flex-wrap gap-1.5">
              {row.profiles.map((profile) => (
                <span key={profile} className="inline-flex h-5 items-center rounded-sm bg-canvas px-1.5 text-[11px] text-ink-600">
                  {profile}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-ink-500">Şu an eşleşen aktif profil yok.</p>
          )}
        </section>
        <section className="flex flex-col gap-1.5">
          <h3 className="eyebrow">Karar</h3>
          <p className="text-[13px]">
            {row.decision ? DECISION_LABELS[row.decision] : "Karar verilmedi"}
            {row.decidedAt && <span className="text-ink-500"> · {formatDateTime(row.decidedAt)}</span>}
          </p>
        </section>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-line px-6 py-4">
        <Link href={`/tenders/${row.tenderId}`} className={cn(buttonVariants(), "flex-1")}>
          İhaleyi aç
        </Link>
        {row.noticeUrl && (
          <a href={row.noticeUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
            İlan
            <ExternalLink />
          </a>
        )}
      </div>
    </aside>
  );
}
