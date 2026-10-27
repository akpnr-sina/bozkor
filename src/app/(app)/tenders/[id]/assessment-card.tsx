import { ChevronRight } from "lucide-react";
import { AssessmentBadge } from "@/components/assessment-badge";
import { EmptyState } from "@/components/empty-state";
import { Meter } from "@/components/meter";
import { Notice } from "@/components/notice";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Analysis } from "@/db/schema";
import { formatDateTime, formatMoney, lotLabel } from "@/lib/format";
import { expectedScore, FINAL_STATUSES, type Gate, type GateState, type LotAssessment, type Range } from "@/policy/engine";
import { GATE_LABELS, GATE_STATE_LABELS } from "@/policy/labels";
import { DIMENSION_LABELS, type Dimension } from "@/policy/policy";
import { allFacts, GATE_MARK, UNVERIFIED_FACT, UNVERIFIED_WHY, type AssessmentResult, type AssessmentView, type CheckRow, type Fact, type FactBox } from "./assessment-view";
import { Evidence, FactCell, FactGrid, FactValue, LongText, Mark, MarkLegend, MARK_WORDS } from "./fact-grid";

// The qualification policy's verdict on a tender (docs/qualification-policy-v1.md),
// in three parts: on the right a short summary (status, fit, why, the checks
// it rests on); in the main column the detail (scores, next actions, lots,
// gates) and the facts it rests on, each with its quote and whether the quote
// was found (CLAUDE.md rule 5).

const range = (r: Range) => (r.low === r.high ? `${r.low}` : `${r.low}-${r.high}`);

type SummaryProps = {
  result: AssessmentResult | null;
  /** The newest facts attempt, valid or not. */
  latestAttempt: Analysis | null;
  /** The facts wait to be extracted again: the notice, its files or the extraction changed since. */
  stale: boolean;
  /** The month's LLM budget is spent: automatic extraction waits (CLAUDE.md rule 7). */
  budgetExceeded?: boolean;
  tenderId: string;
  /** The checks to list (summaryChecks); none before the assessment. */
  checks: CheckRow[];
};

/** The right column's summary: status, fit, why, and the few checks it rests on. */
export function AssessmentSummary({ result, latestAttempt, stale, budgetExceeded = false, tenderId, checks }: SummaryProps) {
  const failedSince = latestAttempt && !latestAttempt.valid && latestAttempt.id !== result?.latest.analysisId ? latestAttempt : null;
  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Değerlendirme</CardTitle>
        </CardHeader>
        <CardContent>
          {failedSince ? (
            <FailedAttempt attempt={failedSince} hasEarlier={false} tenderId={tenderId} />
          ) : (
            <EmptyState>Henüz değerlendirilmedi. Güncel eşleşmelerin ve karar verilen ihalelerin olguları sırayla çıkarılır; bu birkaç dakika sürebilir.</EmptyState>
          )}
        </CardContent>
      </Card>
    );
  }
  const { assessment } = result;
  const best = assessment.best;
  const fit = expectedScore(best.scores.fit);
  const legend = (["held", "failed", "unknown", "off"] as const).filter((state) => checks.some((c) => c.state === state));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Değerlendirme</CardTitle>
        <CardAction>
          <AssessmentBadge status={best.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {stale && (
          <p className="text-xs text-ink-500">
            {budgetExceeded
              ? "İlan, dosyalar ya da çıkarma yöntemi bu olgulardan sonra değişti; ama bu ayın LLM bütçesi doldu, olgular bütçe yenilenince ya da elle çalıştırılınca güncellenir."
              : "İlan, dosyalar ya da çıkarma yöntemi bu olgulardan sonra değişti; olgular yeniden çıkarılmak üzere sırada."}
          </p>
        )}
        {failedSince && <FailedAttempt attempt={failedSince} hasEarlier tenderId={tenderId} />}
        {assessment.lots.length > 1 && (
          <p className="text-[13px] text-ink-600">
            En umut verici lot: {lotLabel(best.lotNumber)} ({best.productTr})
          </p>
        )}
        <div className="flex flex-col gap-2">
          <span className="eyebrow">Fırsat uyumu</span>
          <div className="flex items-center gap-3">
            <span className="font-heading text-[30px] leading-none font-medium text-ink-900">
              {fit}
              <span className="ml-1 text-sm text-ink-500">/ 100</span>
            </span>
            <Meter value={fit} label="Fırsat uyumu" className="flex-1" />
          </div>
          <span className="text-xs text-ink-500">
            {best.scores.fit.low === best.scores.fit.high ? "Kesin" : `Aralık ${range(best.scores.fit)}`} · güven %{best.confidence}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-ink-900">{best.explanation}</p>
        {checks.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Kararı belirleyen kontroller</span>
            <ul className="flex flex-col border-t border-line-soft">
              {checks.map((check) => (
                <li key={check.id} title={check.note || undefined} className="flex min-h-9 items-center gap-2.5 border-b border-line-soft py-1.5 text-[13px] text-ink-900">
                  <Mark state={check.state} />
                  <span className="min-w-0 truncate">{check.label}</span>
                  <span className="sr-only">
                    : {MARK_WORDS[check.state]}
                    {check.note ? `. ${check.note}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            <MarkLegend states={legend} />
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-4 text-[13px]">
        <a href="#olgular" className="text-ink-900 underline underline-offset-4 hover:text-ink-600">
          Tüm olgular
        </a>
        <a href="#degerlendirme-ayrintisi" className="text-ink-900 underline underline-offset-4 hover:text-ink-600">
          Değerlendirme ayrıntısı
        </a>
      </CardFooter>
    </Card>
  );
}

/** The main column's detail: the scores, the next actions, the lots, every gate and how the score adds up. */
export function AssessmentDetail({ result, fileCount }: { result: AssessmentResult; /** Files the facts call read. */ fileCount: number }) {
  const { assessment, latest } = result;
  const best = assessment.best;
  const multiLot = assessment.lots.length > 1;
  const final = FINAL_STATUSES.includes(best.status);
  const scores: { label: string; value: string; note?: string }[] = [
    { label: "Fırsat uyumu", ...score(best.scores.fit) },
    { label: "Teklif hazırlığı", ...score(best.scores.readiness) },
    { label: "Ticari uygunluk", ...score(best.scores.viability) },
    { label: "Ön puan (100)", ...score(best.scores.preliminary) },
    { label: "Güven", value: `%${best.confidence}` },
  ];
  return (
    <Card id="degerlendirme-ayrintisi" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Değerlendirme ayrıntısı{multiLot ? ` · ${lotLabel(best.lotNumber)}` : ""}</CardTitle>
      </CardHeader>
      <dl className="grid grid-cols-2 gap-px border-b border-line bg-surface sm:grid-cols-5">
        {scores.map((s) => (
          <div key={s.label} className="flex min-w-0 flex-col gap-2 px-4 py-3.5 outline outline-line">
            <dt className="eyebrow">{s.label}</dt>
            <dd className="flex flex-col gap-1">
              <span className="font-heading text-[22px] leading-[1.1] font-medium text-ink-900">{s.value}</span>
              {s.note && <span className="text-xs text-ink-500">{s.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <CardContent className="flex flex-col gap-5">
        <p className="text-xs text-ink-500">
          Puanlar ilandaki bilgilere göre tahmindir: bilinmeyen ölçütler küçük yazılan aralığı açar, gösterilen sayı ortasıdır. Güven, puanın ne kadarının bilinen bilgiye dayandığını söyler.
        </p>
        {!final && best.actions.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="eyebrow">Sonraki adımlar</h3>
            <ol className="flex flex-col border-t border-line-soft">
              {best.actions.map((action, i) => (
                <li key={action} className="flex gap-3 border-b border-line-soft py-2.5 text-sm text-ink-900">
                  <span className="w-5 shrink-0 font-mono text-xs leading-5 text-ink-500">{String(i + 1).padStart(2, "0")}</span>
                  <span>{action}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {multiLot && <LotsTable lots={assessment.lots} />}
        <Gates gates={best.gates} />
        <ScoreDetail lot={best} />
      </CardContent>
      <CardFooter className="text-xs text-ink-500">
        <p>
          Olguları AI ilan metninden{fileCount ? ` ve ${fileCount} dosyadan` : ""} çıkardı ({formatDateTime(latest.createdAt)}); puan, kapı ve kararları kod{" "}
          {assessment.policyVersion} politikasıyla hesapladı. Doğrulanmamış alıntıya dayanan olgu karar için kullanılmaz. Karar sizindir.
        </p>
      </CardFooter>
    </Card>
  );
}

const score = (r: Range) => ({ value: `${expectedScore(r)}`, note: r.low === r.high ? undefined : `aralık ${range(r)}` });

const GATE_VARIANT: Record<GateState, BadgeVariant> = { PASS: "ok", FAIL: "err", UNKNOWN: "warn", NOT_APPLICABLE: "default" };

function Gates({ gates }: { gates: Gate[] }) {
  const failing = gates.filter((g) => g.state === "FAIL").length;
  const unknown = gates.filter((g) => g.state === "UNKNOWN").length;
  return (
    <details id="kapilar" className="group border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-ink-900 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 text-ink-500 transition-transform group-open:rotate-90" />
        Kapılar · {gates.length}
        <span className="text-xs font-normal text-ink-500">
          {failing} takıldı, {unknown} bilinmiyor
        </span>
      </summary>
      <ul className="mt-3 flex flex-col border-t border-line-soft">
        {gates.map((gate) => (
          <li key={gate.id} className="grid grid-cols-[auto_2.25rem_minmax(0,1fr)] items-baseline gap-x-2.5 border-b border-line-soft py-2.5 text-[13px]">
            <Mark state={GATE_MARK[gate.state]} className="self-center" />
            <span className="font-mono text-xs text-ink-500">{gate.id}</span>
            <span className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{GATE_LABELS[gate.id]}</span>
                <Badge variant={GATE_VARIANT[gate.state]}>{GATE_STATE_LABELS[gate.state]}</Badge>
              </span>
              {gate.note && <span className="text-ink-600">{gate.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ScoreDetail({ lot }: { lot: LotAssessment }) {
  return (
    <details className="group border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-ink-900 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 text-ink-500 transition-transform group-open:rotate-90" />
        Puan ayrıntısı
      </summary>
      <div className="mt-3 border border-line">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">Boyut</TableHead>
              <TableHead className="px-3 text-right">Puan</TableHead>
              <TableHead className="px-3">Neden</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(Object.keys(DIMENSION_LABELS) as Dimension[]).map((key) => {
              const d = lot.dimensions[key];
              return (
                <TableRow key={key}>
                  <TableCell className="px-3 py-2.5 align-top whitespace-normal">
                    <span className="font-mono text-xs text-ink-500">{key}</span> {DIMENSION_LABELS[key]}
                  </TableCell>
                  <TableCell className="px-3 py-2.5 text-right align-top font-mono text-xs whitespace-nowrap">
                    {range({ low: d.low, high: d.high })} / {d.weight}
                  </TableCell>
                  <TableCell className="px-3 py-2.5 align-top text-[13px] whitespace-normal text-ink-600">{d.notes.join(" ")}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-ink-500">Bilinmeyen ölçütler aralık olarak gösterilir: alt sınır en kötü, üst sınır en iyi durum.</p>
    </details>
  );
}

function LotsTable({ lots }: { lots: LotAssessment[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="eyebrow">Lot bazında</h3>
      <div className="border border-line">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">Lot</TableHead>
              <TableHead className="px-3">Durum</TableHead>
              <TableHead className="px-3 text-right">Uyum</TableHead>
              <TableHead className="px-3 text-right">Değer</TableHead>
              <TableHead className="px-3">Gerekçe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.map((lot) => (
              <TableRow key={lot.lotNumber}>
                <TableCell className="px-3 py-2.5 align-top whitespace-normal">
                  <span className="font-mono text-xs text-ink-600">{lotLabel(lot.lotNumber)}</span>
                  <span className="block text-[13px] text-ink-900">{lot.productTr}</span>
                </TableCell>
                <TableCell className="px-3 py-2.5 align-top">
                  <AssessmentBadge status={lot.status} />
                </TableCell>
                <TableCell className="px-3 py-2.5 text-right align-top font-mono text-xs" title={`Aralık ${range(lot.scores.fit)}`}>
                  {expectedScore(lot.scores.fit)}
                </TableCell>
                <TableCell className="px-3 py-2.5 text-right align-top font-mono text-xs whitespace-nowrap">
                  {lot.valueEur !== null ? formatMoney(lot.valueEur, "EUR") : "?"}
                </TableCell>
                <TableCell className="min-w-64 px-3 py-2.5 align-top text-[13px] whitespace-normal text-ink-600">{lot.explanation}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** The main column's facts: in groups, each a box with its value, quote and source. */
export function AssessmentFacts({ result, view }: { result: AssessmentResult; view: AssessmentView }) {
  const { facts } = result.latest.stored;
  const all = allFacts(view.groups);
  const deciding = all.filter((f) => f.tone === "err").length;
  const unknown = all.filter((f) => f.tone === "warn").length;
  return (
    <Card id="olgular" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Olgular · {view.factCount}</CardTitle>
        {(deciding > 0 || unknown > 0) && (
          <CardAction className="flex flex-wrap justify-end gap-1.5">
            {deciding > 0 && (
              <Badge variant="err" dot>
                {deciding} kararı belirliyor
              </Badge>
            )}
            {unknown > 0 && (
              <Badge variant="warn" dot>
                {unknown} bilinmiyor
              </Badge>
            )}
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {facts.summaryTr && <p className="text-sm leading-relaxed text-ink-900">{facts.summaryTr}</p>}
        {view.groups.map(
          (group) =>
            group.boxes.length > 0 && (
              <section key={group.title} className="flex flex-col gap-2">
                <h3 className="eyebrow">{group.title}</h3>
                <FactGrid>
                  {group.boxes.map((box) => (
                    <FactBoxCell key={box.key} box={box} />
                  ))}
                </FactGrid>
              </section>
            ),
        )}
        {facts.documentsToCheck.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="eyebrow">Bilinmeyenleri çözecek dokümanlar</h3>
            <ul className="flex flex-col gap-1.5 text-sm text-ink-900">
              {facts.documentsToCheck.map((doc) => (
                <li key={doc} className="flex items-center gap-2">
                  <Mark state="unknown" />
                  {doc}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
      <CardFooter className="text-xs text-ink-500">
        <p>
          <span className="font-medium text-err">Kırmızı</span> değer kararı belirleyen olgudur: bilinmeseydi durum ya da gerekçesi değişirdi.{" "}
          <span className="font-medium text-warn">Sarı</span> değer ilandan anlaşılmayandır. Alıntısı bulunamayan olgu gri yazılır ve kararda kullanılmaz.
        </p>
      </CardFooter>
    </Card>
  );
}

function FactBoxCell({ box }: { box: FactBox }) {
  return (
    <FactCell label={box.label} value={box.value} tone={box.tone}>
      <FactBody fact={box} />
      {box.parts.length > 0 && (
        <dl className="mt-1 flex flex-col gap-3 border-t border-line-soft pt-3">
          {box.parts.map((part) => (
            <div key={part.key} className="flex flex-col gap-1">
              <dt className="eyebrow">{part.label}</dt>
              <dd className="flex flex-col gap-1.5">
                <FactValue value={part.value} tone={part.tone} />
                <FactBody fact={part} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </FactCell>
  );
}

function FactBody({ fact }: { fact: Fact }) {
  // A lot's product is used whether or not its quote was found: its quote shows only with a source.
  const quote = fact.quoted && (fact.source || fact.unverifiedBadge) ? fact.quote : undefined;
  return (
    <>
      {fact.detail && <LongText text={fact.detail} className="text-[13px] text-ink-600" />}
      <Evidence quote={quote} source={fact.source} unverified={fact.unverifiedBadge ? { label: UNVERIFIED_FACT, why: UNVERIFIED_WHY } : null} />
    </>
  );
}

/** Turkish heading for a stored error; the raw text goes in the details. */
function errorKind(error: string | null): string {
  if (!error) return "Yanıt beklenen biçimde değildi";
  if (error.startsWith("API hatası")) return "AI servisi hata verdi";
  if (error.startsWith("Model yanıt vermeyi reddetti")) return "Model bu ilanı değerlendirmedi";
  if (error.startsWith("Yanıt token sınırında kesildi")) return "Yanıt yarıda kesildi";
  return "Yanıt beklenen biçimde değildi";
}

function FailedAttempt({ attempt, hasEarlier, tenderId }: { attempt: Analysis; hasEarlier: boolean; tenderId: string }) {
  return (
    <Notice tone="err" title={hasEarlier ? "Son olgu çıkarma denemesi başarısız" : "Olgu çıkarma başarısız"}>
      <p>
        {formatDateTime(attempt.createdAt)}: {errorKind(attempt.error)}. {attempt.output === null ? "Bir saat sonra kendiliğinden yeniden denenir." : "İlan değişince yeniden denenir."}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer">Ayrıntı</summary>
        <p className="mt-1 wrap-anywhere">{attempt.error ?? "Hata metni yok."}</p>
        <p className="mt-1">
          Elle yeniden denemek için: <code className="font-mono">pnpm facts --tender={tenderId}</code>
        </p>
      </details>
    </Notice>
  );
}

