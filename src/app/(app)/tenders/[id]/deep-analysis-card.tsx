import { Badge } from "@/components/ui/badge";
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

// The deep analysis of a tender's documents (SPEC 7.2, section 8): where the
// request stands, with its button, then the result section by section, each
// claim with where its quote was found (CLAUDE.md rule 5). The model's
// suggestion stands apart from the team's decision (rule 4).

const WARNING = "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200";
const SEVERITY_CLASSES: Record<RiskRow["severity"], string> = {
  high: "border-transparent bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  medium: WARNING,
  low: "border-transparent bg-muted text-muted-foreground",
};

/** `view` is null when it could not be read: the rest of the page still shows. */
export function DeepAnalysisCard({ view, tenderId }: { view: DeepView | null; tenderId: string }) {
  if (!view) return <p className="text-sm text-muted-foreground">Derin analiz bilgisi şu an okunamadı; sayfayı yenileyin.</p>;
  const status = deepStatus(view);
  const budget = budgetNote(view.budget);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <DeepRefresh active={status.waiting} />
      <div className="flex flex-col gap-2 rounded-lg border p-4">
        <p className="font-medium">{status.title}</p>
        {status.detail && <p className="text-muted-foreground">{status.detail}</p>}
        {status.error && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Hata ayrıntısı</summary>
            <p className="mt-1 whitespace-pre-line wrap-anywhere">{status.error}</p>
          </details>
        )}
        {status.action && (
          <div className="flex flex-wrap items-center gap-2">
            <DeepAnalyzeButton tenderId={tenderId} label={status.action} variant={view.result ? "outline" : "default"} />
            {budget && (
              <span className="text-xs text-amber-900 dark:text-amber-200" title={`Bu ay ${view.budget.spentUsd.toFixed(2)} / ${view.budget.budgetUsd.toFixed(2)} USD`}>
                {budget}
              </span>
            )}
          </div>
        )}
      </div>
      {view.result && <ResultView result={view.result} older={view.state !== "done"} />}
    </div>
  );
}

function ResultView({ result, older }: { result: DeepResult; older: boolean }) {
  const items = itemRows(result);
  const missing = missingRows(result);
  const advice = suggestion(result);
  const skipped = skippedRows(result);
  return (
    <div className="flex flex-col gap-5">
      {older && <p className="text-xs text-muted-foreground">{olderResultNote(result)}</p>}
      {result.stale && <p className={`rounded-md px-3 py-2 text-xs ${WARNING}`}>{STALE_NOTE}</p>}

      {result.output.summaryTr.trim() && (
        <Block title="Özet">
          <p className="leading-relaxed">{result.output.summaryTr.trim()}</p>
        </Block>
      )}

      <Block title={`Kalemler (${items.length})`}>{items.length ? <Items rows={items} /> : <Muted>{NOT_IN_DOCUMENTS}.</Muted>}</Block>
      <Claims title="Teslimat" rows={claimRows(result, "delivery")} />
      <Claims title="Yeterlilik" rows={claimRows(result, "eligibility")} />
      <Claims title="Ticari şartlar" rows={claimRows(result, "commercial")} />
      <Claims title="Hizmet kapsamı" rows={claimRows(result, "servicesScope")} />
      <Rows title="Değerlendirme kriterleri" rows={evaluationRows(result)} detailLabel="ağırlık" />
      <Claims title="Takvim" rows={claimRows(result, "timeline")} />
      <Risks rows={riskRows(result)} />
      <Rows title="Profil soruları" rows={answerRows(result)} answers />
      {missing.length > 0 && (
        <Block title="Eksik bilgiler">
          <ul className="list-disc pl-5">
            {missing.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </Block>
      )}

      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">AI önerisi</span>
          <Badge variant="outline">{advice.label}</Badge>
        </div>
        {advice.reasons.length > 0 && (
          <ul className="list-disc pl-5">
            {advice.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">Bu öneriyi model verdi; karar ekibindir ve Karar bölümünden kaydedilir.</p>
      </div>

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>{deepFooter(result).join(" · ")}</p>
        {result.files.length > 0 && (
          <details>
            <summary className="cursor-pointer">Okunan dosyalar ({result.files.length})</summary>
            <ol className="mt-1 list-decimal pl-5">
              {result.files.map((file) => (
                <li key={file.n}>{file.name}</li>
              ))}
            </ol>
          </details>
        )}
        {skipped.length > 0 && (
          <details>
            <summary className="cursor-pointer">Analize alınmayan dosyalar ({skipped.length})</summary>
            <ul className="mt-1 list-disc pl-5">
              {skipped.map((text, i) => (
                <li key={i} className="wrap-anywhere">
                  {text}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p>
          Her bilginin yanında alıntının bulunduğu yer yazar; &quot;{UNVERIFIED}&quot; işaretli bilgiyi dokümandan kontrol edin.
        </p>
      </div>
    </div>
  );
}

function Items({ rows }: { rows: ItemRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((item) => (
        <li key={item.path} className="flex flex-col gap-1 rounded-md border p-3">
          <span className="font-medium">
            {item.lot && <span className="text-muted-foreground">{item.lot}: </span>}
            {item.description}
          </span>
          {item.quantity && (
            <span>
              <span className="text-muted-foreground">Miktar:</span> {item.quantity}
            </span>
          )}
          {item.specs.length > 0 && (
            <div>
              <span className="text-muted-foreground">Özellikler:</span>
              <ul className="list-disc pl-5">
                {item.specs.map((spec, i) => (
                  <li key={i}>{spec}</li>
                ))}
              </ul>
            </div>
          )}
          {item.standards.length > 0 && (
            <span>
              <span className="text-muted-foreground">Standartlar:</span> {item.standards.join(", ")}
            </span>
          )}
          {item.certifications.length > 0 && (
            <span>
              <span className="text-muted-foreground">Belgeler:</span> {item.certifications.join(", ")}
            </span>
          )}
          <Source tag={item.source} />
        </li>
      ))}
    </ul>
  );
}

function Claims({ title, rows }: { title: string; rows: ClaimRow[] }) {
  return (
    <Block title={title}>
      {rows.length ? (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.path} className="flex flex-col gap-0.5">
              <span>
                <span className="text-muted-foreground">{row.label}:</span> <span className={row.empty ? "text-muted-foreground" : undefined}>{row.value}</span>
              </span>
              {row.source && <Source tag={row.source} />}
            </li>
          ))}
        </ul>
      ) : (
        <Muted>{NOT_IN_DOCUMENTS}.</Muted>
      )}
    </Block>
  );
}

function Rows({ title, rows, detailLabel, answers }: { title: string; rows: ListRow[]; detailLabel?: string; answers?: boolean }) {
  if (!rows.length) return null;
  return (
    <Block title={title}>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.path} className="flex flex-col gap-0.5">
            {answers ? (
              <>
                <span className="text-muted-foreground">{row.text}</span>
                <span className={row.detail === NOT_IN_DOCUMENTS ? "text-muted-foreground" : undefined}>{row.detail}</span>
              </>
            ) : (
              <span>
                {row.text}
                {row.detail && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({detailLabel ? `${detailLabel}: ` : ""}
                    {row.detail})
                  </span>
                )}
              </span>
            )}
            {row.source && <Source tag={row.source} />}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Risks({ rows }: { rows: RiskRow[] }) {
  if (!rows.length) return null;
  return (
    <Block title="Riskler">
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.path} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-baseline gap-2">
              <Badge variant="outline" className={SEVERITY_CLASSES[row.severity]}>
                {SEVERITY_LABELS[row.severity]}
              </Badge>
              <span>{row.text}</span>
            </span>
            {row.source && <Source tag={row.source} />}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** Where the claim's quote was found; the quote itself, in the documents' language, opens on a click and shows on hover. */
function Source({ tag }: { tag: SourceTag }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
      {!tag.verified && (
        <Badge variant="outline" className={WARNING} title={tag.why}>
          {UNVERIFIED}
        </Badge>
      )}
      {tag.quote ? (
        <details>
          <summary className="cursor-pointer" title={tag.quote}>
            {tag.verified ? `kaynak: ${tag.label}` : "alıntı"}
          </summary>
          <q className="mt-1 block italic wrap-anywhere">{tag.quote}</q>
        </details>
      ) : (
        tag.verified && <span>kaynak: {tag.label}</span>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground">{children}</p>;
}
