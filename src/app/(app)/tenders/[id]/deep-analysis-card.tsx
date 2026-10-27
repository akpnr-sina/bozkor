import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { DeepResult, DeepView } from "@/analysis/deep-view";
import { DeepAnalyzeButton } from "./deep-analyze-button";
import { DeepRefresh } from "./deep-refresh";
import {
  answerRows,
  budgetNote,
  claimRows,
  deepFooter,
  deepStatus,
  evaluationRows,
  itemRows,
  type ListRow,
  missingRows,
  NOT_IN_DOCUMENTS,
  olderResultNote,
  type RiskRow,
  riskRows,
  SEVERITY_LABELS,
  skippedRows,
  type SourceTag,
  STALE_NOTE,
  suggestion,
  UNVERIFIED,
  type ClaimRow,
  type ItemRow,
} from "./deep-view-format";
import { Evidence, FactCell, FactGrid, type FactTone, LongText, Mark } from "./fact-grid";

// The deep analysis of a tender's documents (SPEC 7.2, section 8): where the
// request stands, with its button, then the result section by section, each
// claim with where its quote was found (CLAUDE.md rule 5). Laid out like the
// overview: the findings in the main column, the model's suggestion, the
// risks and what is missing on the right. The model's suggestion stands apart
// from the team's decision (rule 4).

const STATE_VARIANT: Record<DeepView["state"], BadgeVariant> = { none: "default", queued: "info", running: "info", done: "ok", failed: "err" };
const SEVERITY_VARIANT: Record<RiskRow["severity"], BadgeVariant> = { high: "err", medium: "warn", low: "default" };

/** `view` is null when it could not be read: the rest of the page still shows. */
export function DeepAnalysisCard({ view, tenderId }: { view: DeepView | null; tenderId: string }) {
  if (!view) return <Notice tone="err" title="Derin analiz bilgisi şu an okunamadı">Sayfayı yenileyin.</Notice>;
  const status = deepStatus(view);
  const budget = budgetNote(view.budget);
  const request = (
    <Card>
      <CardHeader>
        <CardTitle>Derin analiz</CardTitle>
        <CardAction>
          <Badge variant={STATE_VARIANT[view.state]} dot>
            {status.title}
          </Badge>
        </CardAction>
      </CardHeader>
      {(status.detail || status.error || status.action) && (
        <CardContent className="flex flex-col gap-3">
          {status.detail && <p className="text-[13px] leading-relaxed text-ink-600">{status.detail}</p>}
          {status.error && (
            <details className="text-xs text-ink-600">
              <summary className="cursor-pointer text-ink-500 hover:text-ink-900">Hata ayrıntısı</summary>
              <p className="mt-1 whitespace-pre-line wrap-anywhere">{status.error}</p>
            </details>
          )}
          {status.action && (
            <div className="flex flex-wrap items-center gap-3">
              <DeepAnalyzeButton tenderId={tenderId} label={status.action} />
              {budget && (
                <span className="text-xs text-warn" title={`Bu ay ${view.budget.spentUsd.toFixed(2)} / ${view.budget.budgetUsd.toFixed(2)} USD`}>
                  {budget}
                </span>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
  return (
    <div className="flex flex-col gap-[18px]">
      <DeepRefresh tenderId={tenderId} active={status.waiting} status={view.request?.status ?? null} />
      {view.result ? <ResultView result={view.result} older={view.state !== "done"} request={request} /> : request}
    </div>
  );
}

function ResultView({ result, older, request }: { result: DeepResult; older: boolean; request: React.ReactNode }) {
  const items = itemRows(result);
  const missing = missingRows(result);
  const risks = riskRows(result);
  const evaluation = evaluationRows(result);
  const answers = answerRows(result);
  const advice = suggestion(result);
  const skipped = skippedRows(result);
  const groups: { title: string; rows: ClaimRow[] }[] = [
    { title: "Hizmet kapsamı", rows: claimRows(result, "servicesScope") },
    { title: "Teslimat", rows: claimRows(result, "delivery") },
    { title: "Ticari şartlar", rows: claimRows(result, "commercial") },
    { title: "Yeterlilik", rows: claimRows(result, "eligibility") },
    { title: "Takvim", rows: claimRows(result, "timeline") },
  ];
  const findings = groups.reduce((n, g) => n + g.rows.length, 0);
  const summary = result.output.summaryTr.trim();
  return (
    <>
      {older && <Notice tone="info" title={olderResultNote(result)} />}
      {result.stale && <Notice tone="warn" title={STALE_NOTE} />}
      <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-[18px]">
          {summary && (
            <Card>
              <CardHeader>
                <CardTitle>Özet</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed text-ink-900">{summary}</p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Kalemler · {items.length}</CardTitle>
            </CardHeader>
            <CardContent>
              {items.length ? (
                <FactGrid>
                  {items.map((item, i) => (
                    <Item key={item.path} item={item} n={i + 1} />
                  ))}
                </FactGrid>
              ) : (
                <EmptyState>{NOT_IN_DOCUMENTS}.</EmptyState>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bulgular · {findings}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              {groups.map((group) => (
                <section key={group.title} className="flex flex-col gap-2">
                  <h3 className="eyebrow">{group.title}</h3>
                  {group.rows.length ? (
                    <FactGrid>
                      {group.rows.map((row) => (
                        <FactCell key={row.path} label={row.label} value={row.value} tone={claimTone(row)}>
                          {row.source && <Source tag={row.source} />}
                        </FactCell>
                      ))}
                    </FactGrid>
                  ) : (
                    <p className="text-[13px] text-ink-500">{NOT_IN_DOCUMENTS}.</p>
                  )}
                </section>
              ))}
            </CardContent>
          </Card>

          {evaluation.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Değerlendirme kriterleri · {evaluation.length}</CardTitle>
              </CardHeader>
              <CardContent>
                <Rows rows={evaluation} render={(row) => (
                  <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-sm text-ink-900">{row.text}</span>
                    {row.detail && <span className="font-mono text-xs text-ink-600">ağırlık: {row.detail}</span>}
                  </span>
                )} />
              </CardContent>
            </Card>
          )}

          {answers.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Profil soruları · {answers.length}</CardTitle>
              </CardHeader>
              <CardContent>
                <Rows rows={answers} render={(row) => (
                  <span className="flex flex-col gap-1">
                    <span className="text-[13px] text-ink-600">{row.text}</span>
                    <span className={row.detail === NOT_IN_DOCUMENTS ? "text-sm font-medium text-warn" : "text-sm text-ink-900"}>{row.detail}</span>
                  </span>
                )} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Analiz</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-xs text-ink-500">
              <p className="font-mono">{deepFooter(result).join(" · ")}</p>
              {result.files.length > 0 && (
                <details>
                  <summary className="cursor-pointer hover:text-ink-900">Okunan dosyalar ({result.files.length})</summary>
                  <ol className="mt-1 flex flex-col gap-0.5 text-ink-600">
                    {result.files.map((file) => (
                      <li key={file.n} className="wrap-anywhere">
                        <span className="font-mono text-ink-500">{String(file.n).padStart(2, "0")}</span> {file.name}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {skipped.length > 0 && (
                <details>
                  <summary className="cursor-pointer hover:text-ink-900">Analize alınmayan dosyalar ({skipped.length})</summary>
                  <ul className="mt-1 flex flex-col gap-0.5 text-ink-600">
                    {skipped.map((text, i) => (
                      <li key={i} className="wrap-anywhere">
                        {text}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p>Her bilginin yanında alıntının bulunduğu yer yazar; &quot;{UNVERIFIED}&quot; işaretli bilgiyi dokümandan kontrol edin.</p>
            </CardContent>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-[18px]">
          {request}

          <Card>
            <CardHeader>
              <CardTitle>AI önerisi</CardTitle>
              <CardAction>
                <Badge variant="outline">{advice.label}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {advice.reasons.length > 0 && (
                <ul className="flex flex-col gap-2 text-sm text-ink-900">
                  {advice.reasons.map((reason, i) => (
                    <li key={i} className="flex gap-2">
                      <span aria-hidden className="mt-2 size-1 shrink-0 bg-ink-400" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-ink-500">Bu öneriyi model verdi; karar ekibindir ve Genel bakış&apos;taki Karar bölümünden kaydedilir.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Riskler · {risks.length}</CardTitle>
            </CardHeader>
            <CardContent>
              {risks.length ? (
                <Rows rows={risks} render={(row) => (
                  <span className="flex flex-col items-start gap-1.5">
                    <Badge variant={SEVERITY_VARIANT[row.severity]} dot>
                      {SEVERITY_LABELS[row.severity]}
                    </Badge>
                    <span className="text-sm text-ink-900">{row.text}</span>
                  </span>
                )} />
              ) : (
                <EmptyState>Dokümanlarda risk işaretlenmedi.</EmptyState>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Eksik bilgiler · {missing.length}</CardTitle>
            </CardHeader>
            <CardContent>
              {missing.length ? (
                <ul className="flex flex-col gap-2 text-sm text-ink-900">
                  {missing.map((text, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Mark state="unknown" className="mt-1.5" />
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState>Eksik bilgi yazılmadı.</EmptyState>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/** A claim the documents do not give in amber, one whose quote was not found in grey (as the assessment's facts). */
const claimTone = (row: ClaimRow): FactTone => (row.empty ? "warn" : row.source && !row.source.verified ? "muted" : null);

/** Past this many specifications an item shows the first ones and opens for the rest. */
const SPECS_SHOWN = 4;

function Item({ item, n }: { item: ItemRow; n: number }) {
  const specs = item.specs.length > SPECS_SHOWN ? item.specs.slice(0, SPECS_SHOWN - 1) : item.specs;
  const more = item.specs.slice(specs.length);
  return (
    <FactCell label={`${item.lot ? `${item.lot} · ` : ""}Kalem ${n}`} value={item.description} tone={item.source.verified ? null : "muted"}>
      <dl className="flex flex-col gap-1.5 text-[13px]">
        {item.quantity && <Detail label="Miktar">{item.quantity}</Detail>}
        {item.specs.length > 0 && (
          <Detail label="Özellikler">
            <ul className="flex flex-col gap-0.5">
              {specs.map((spec, i) => (
                <li key={i}>
                  <LongText text={spec} />
                </li>
              ))}
            </ul>
            {more.length > 0 && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-ink-500 hover:text-ink-900">{more.length} özellik daha</summary>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {more.map((spec, i) => (
                    <li key={i}>
                      <LongText text={spec} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Detail>
        )}
        {item.standards.length > 0 && <Detail label="Standartlar">{item.standards.join(", ")}</Detail>}
        {item.certifications.length > 0 && <Detail label="Belgeler">{item.certifications.join(", ")}</Detail>}
      </dl>
      <Source tag={item.source} />
    </FactCell>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-ink-700 wrap-anywhere">{children}</dd>
    </div>
  );
}

/** Rows split by soft lines, each with where its quote was found. */
function Rows<R extends ListRow>({ rows, render }: { rows: R[]; render: (row: R) => React.ReactNode }) {
  return (
    <ul className="flex flex-col border-t border-line-soft">
      {rows.map((row) => (
        <li key={row.path} className="flex flex-col gap-1.5 border-b border-line-soft py-2.5">
          {render(row)}
          {row.source && <Source tag={row.source} />}
        </li>
      ))}
    </ul>
  );
}

/** Where the claim's quote was found, with the quote in the documents' language (the assessment's facts show theirs the same way). */
function Source({ tag }: { tag: SourceTag }) {
  return <Evidence quote={tag.quote} source={tag.verified ? tag.label : null} unverified={tag.verified ? null : { label: UNVERIFIED, why: tag.why }} />;
}
