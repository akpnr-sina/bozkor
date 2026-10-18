import { AssessmentBadge } from "@/components/assessment-badge";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Analysis } from "@/db/schema";
import type { ReadFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import { formatDateTime, formatMoney, lotLabel } from "@/lib/format";
import type { LatestFacts } from "@/policy/assess";
import { PRODUCT_CATEGORIES } from "@/policy/categories";
import { awardFromDetails, expectedScore, FINAL_STATUSES, type LotAssessment, type Range, type TenderAssessment } from "@/policy/engine";
import { GATE_LABELS, GATE_STATE_LABELS } from "@/policy/labels";
import { DIMENSION_LABELS, type Dimension } from "@/policy/policy";
import type { NoticeDetails } from "@/sources/types";

// The qualification policy's verdict on a tender (docs/qualification-policy-v1.md):
// per lot a status with its reasons, three scores and the preliminary score as
// ranges, the gates and the next actions; then the facts it rests on, each with
// its quote and whether the quote was found in the notice (CLAUDE.md rule 5).

type Props = {
  result: { assessment: TenderAssessment; latest: LatestFacts } | null;
  /** The newest facts attempt, valid or not. */
  latestAttempt: Analysis | null;
  /** The facts wait to be extracted again: the notice, its files or the extraction changed since. */
  stale: boolean;
  details: NoticeDetails | null;
  tenderId: string;
  /** Names of the files the facts call read, in the order of its "file:<n>" quote sources. */
  fileNames?: string[];
  /** The month's LLM budget is spent: automatic extraction waits (CLAUDE.md rule 7). */
  budgetExceeded?: boolean;
};

const range = (r: Range) => (r.low === r.high ? `${r.low}` : `${r.low}-${r.high}`);

export function AssessmentCard({ result, latestAttempt, stale, details, tenderId, fileNames = [], budgetExceeded = false }: Props) {
  const failedSince = latestAttempt && !latestAttempt.valid && latestAttempt.id !== result?.latest.analysisId ? latestAttempt : null;
  if (!result) {
    return failedSince ? (
      <FailedAttempt attempt={failedSince} hasEarlier={false} tenderId={tenderId} />
    ) : (
      <Muted>
        Henüz değerlendirilmedi. Güncel eşleşmelerin ve karar verilen ihalelerin olguları sırayla çıkarılır; bu birkaç dakika sürebilir.
      </Muted>
    );
  }
  const { assessment, latest } = result;
  const best = assessment.best;
  const multiLot = assessment.lots.length > 1;
  return (
    <div className="flex flex-col gap-5 text-sm">
      {stale && (
        <p className="text-xs text-muted-foreground">
          {budgetExceeded
            ? "İlan, dosyalar ya da çıkarma yöntemi bu olgulardan sonra değişti; ama bu ayın LLM bütçesi doldu, olgular bütçe yenilenince ya da elle çalıştırılınca güncellenir."
            : "İlan, dosyalar ya da çıkarma yöntemi bu olgulardan sonra değişti; olgular yeniden çıkarılmak üzere sırada."}
        </p>
      )}
      {failedSince && <FailedAttempt attempt={failedSince} hasEarlier tenderId={tenderId} />}
      <LotVerdict lot={best} heading={multiLot ? `En umut verici lot: ${lotLabel(best.lotNumber)} (${best.productTr})` : null} />
      {multiLot && <LotsTable lots={assessment.lots} />}
      <FactsList stored={latest.stored} details={details} fileNames={fileNames} />
      <p className="text-xs text-muted-foreground">
        Olguları AI ilan metninden çıkardı ({formatDateTime(latest.createdAt)}); puan, kapı ve kararları kod {assessment.policyVersion} politikasıyla
        hesapladı. Doğrulanmamış alıntıya dayanan olgu karar için kullanılmaz. Karar sizindir.
      </p>
    </div>
  );
}

function LotVerdict({ lot, heading }: { lot: LotAssessment; heading: string | null }) {
  const final = FINAL_STATUSES.includes(lot.status);
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-4">
      {heading && <h3 className="font-medium">{heading}</h3>}
      <div className="flex flex-col gap-2">
        <div>
          <AssessmentBadge status={lot.status} />
        </div>
        <p>{lot.explanation}</p>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
        <Score label="Fırsat uyumu" range={lot.scores.fit} />
        <Score label="Teklif hazırlığı" range={lot.scores.readiness} />
        <Score label="Ticari uygunluk" range={lot.scores.viability} />
        <Score label="Ön puan (100)" range={lot.scores.preliminary} />
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Güven</dt>
          <dd className="tabular-nums">%{lot.confidence}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        Puanlar ilandaki bilgilere göre tahmindir: bilinmeyen ölçütler küçük yazılan aralığı açar, gösterilen sayı ortasıdır. Güven, puanın ne kadarının bilinen bilgiye dayandığını söyler.
      </p>
      {!final && lot.actions.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">Sonraki adımlar</h4>
          <ol className="list-decimal pl-5">
            {lot.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ol>
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-muted-foreground">Kapılar</summary>
        <ul className="mt-2 flex flex-col gap-1.5">
          {lot.gates.map((gate) => (
            <li key={gate.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">{gate.id}</span>
              <span className="font-medium">{GATE_LABELS[gate.id]}</span>
              <Badge variant={gate.state === "FAIL" ? "destructive" : "outline"}>{GATE_STATE_LABELS[gate.state]}</Badge>
              {gate.note && <span className="text-muted-foreground">{gate.note}</span>}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary className="cursor-pointer text-muted-foreground">Puan ayrıntısı</summary>
        <div className="mt-2 rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Boyut</TableHead>
                <TableHead className="text-right">Puan</TableHead>
                <TableHead>Neden</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(Object.keys(DIMENSION_LABELS) as Dimension[]).map((key) => {
                const d = lot.dimensions[key];
                return (
                  <TableRow key={key}>
                    <TableCell className="whitespace-normal">
                      {key}. {DIMENSION_LABELS[key]}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {range({ low: d.low, high: d.high })} / {d.weight}
                    </TableCell>
                    <TableCell className="whitespace-normal text-muted-foreground">{d.notes.join(" ")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Bilinmeyen ölçütler aralık olarak gösterilir: alt sınır en kötü, üst sınır en iyi durum.</p>
      </details>
    </article>
  );
}

function LotsTable({ lots }: { lots: LotAssessment[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-medium">Lot bazında</h3>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lot</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead className="text-right">Uyum</TableHead>
              <TableHead className="text-right">Değer</TableHead>
              <TableHead>Gerekçe</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lots.map((lot) => (
              <TableRow key={lot.lotNumber}>
                <TableCell className="whitespace-normal">
                  {lotLabel(lot.lotNumber)}
                  <span className="block text-xs text-muted-foreground">{lot.productTr}</span>
                </TableCell>
                <TableCell>
                  <AssessmentBadge status={lot.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums" title={`Aralık ${range(lot.scores.fit)}`}>
                  {expectedScore(lot.scores.fit)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{lot.valueEur !== null ? formatMoney(lot.valueEur, "EUR") : "?"}</TableCell>
                <TableCell className="min-w-64 whitespace-normal text-muted-foreground">{lot.explanation}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facts

const UNKNOWN = "Bilinmiyor";
const VALUE_LABELS: Record<string, string> = {
  REQUIRED: "Zorunlu",
  MINOR: "Basit montaj",
  NONE: "Yok",
  NOT_REQUIRED: "Yok",
  YES: "Evet",
  NO: "Hayır",
  UNKNOWN,
  SINGLE: "Tek teslimat",
  FEW: "Birkaç teslimat",
  REPEATED: "Süre boyunca tekrarlanan siparişler",
  ONE: "Tek nokta",
  MANY: "Çok sayıda nokta",
  BRAND_ONLY: "Belirli marka, muadil kabul edilmiyor",
  BRAND_OR_EQUIVALENT: "Marka ya da muadili",
  MANDATORY: "Zorunlu",
  OPTIONAL: "İsteğe bağlı",
  LOWEST_PRICE: "En düşük fiyat",
  PRICE_QUALITY: "Fiyat ve kalite",
};
const POINTS_LABELS: Record<string, string> = { ONE: "Tek nokta", FEW: "Birkaç nokta", MANY: "Çok sayıda nokta", UNKNOWN };
const NATURE_LABELS: Record<string, string> = {
  STANDARD: "Standart ürün",
  CUSTOM: "Ölçüye ya da çizime göre üretim",
  SPECIALISED: "Uzmanlık isteyen ya da güvenlik açısından kritik",
  UNKNOWN: "Standart mı özel mi belli değil",
};
const CERT_LEVEL_LABELS: Record<FactsOutput["certifications"][number]["level"], string> = {
  BIDDER: "istekli",
  MANUFACTURER: "üretici",
  PRODUCT: "ürün",
  PROJECT: "projeye özel",
  UNKNOWN: "seviyesi belirsiz",
};

/** Where a quote was found, in Turkish: a part of the notice, or a file and its page. */
function sourceLabel(key: string, fileNames: readonly string[]): string {
  const file = /^file:(\d+)(?::p(\d+))?$/.exec(key);
  if (file) {
    const name = fileNames[Number(file[1]) - 1];
    return `${name ? `"${name}"` : `dosya ${file[1]}`}${file[2] ? `, sayfa ${file[2]}` : ""}`;
  }
  if (key === "title") return "başlık";
  if (key === "description") return "açıklama";
  if (key === "performance") return "ifa koşulları";
  const lot = /^lot:(.+):(title|description|quantity)$/.exec(key);
  if (lot) return `${lotLabel(lot[1]!)} ${{ title: "başlığı", description: "açıklaması", quantity: "miktarı" }[lot[2] as "title" | "description" | "quantity"]}`;
  const item = /^(selection|document):(\d+)$/.exec(key);
  if (item) return item[1] === "selection" ? `seçim kriteri ${item[2]}` : `doküman ${item[2]} açıklaması`;
  return key;
}

function FactsList({ stored, details, fileNames }: { stored: ReadFacts; details: NoticeDetails | null; fileNames: readonly string[] }) {
  const { facts, quoteChecks } = stored;
  /** Where a quote was found, as a label; null when it was not found, undefined without checks. */
  const label = (key: string | null | undefined) => (key ? sourceLabel(key, fileNames) : key);
  const found = (key: keyof NonNullable<typeof quoteChecks>["facts"]) => (quoteChecks ? label(quoteChecks.facts[key]) : undefined);
  const months = details?.durationMonths ?? null;
  const award = awardFromDetails(details);
  const lotPrefix = (lots: string[]) => (facts.lots.length > 1 && lots.length ? `${lots.map(lotLabel).join(", ")}: ` : "");
  return (
    <details className="rounded-lg border p-4" open>
      <summary className="cursor-pointer font-medium">İlandan çıkarılan olgular</summary>
      <div className="mt-3 flex flex-col gap-3">
        {facts.summaryTr && <p>{facts.summaryTr}</p>}
        <ul className="flex flex-col gap-2">
          {facts.lots.map((lot, i) => (
            <li key={`lot-${i}`} className="flex flex-col gap-1">
              <span>
                <span className="text-muted-foreground">{facts.lots.length > 1 ? lotLabel(lot.lotNumber) : "Ürün"}:</span> {lot.productTr} (
                {PRODUCT_CATEGORIES[lot.category].label})
              </span>
              <ul className="flex flex-col gap-1 pl-4">
                <FactRow
                  label="Nitelik"
                  value={NATURE_LABELS[lot.productNature]!}
                  detail=""
                  quote={lot.natureQuote}
                  found={quoteChecks ? label(quoteChecks.lots[i]?.nature) : undefined}
                  unknown={lot.productNature === "UNKNOWN"}
                />
                <FactRow
                  label="Miktar"
                  value={lot.quantity.text || "Belirtilmemiş"}
                  detail=""
                  quote={lot.quantity.quote}
                  found={quoteChecks ? label(quoteChecks.lots[i]?.quantity) : undefined}
                  unknown={lot.quantity.kind === "UNKNOWN" && !lot.quantity.text}
                />
              </ul>
            </li>
          ))}
          <FactRow label="Kurulum" value={lotPrefix(facts.installation.lots) + VALUE_LABELS[facts.installation.value]!} detail={facts.installation.detail} quote={facts.installation.quote} found={found("installation")} unknown={facts.installation.value === "UNKNOWN"} />
          <FactRow label="Devreye alma, eğitim" value={lotPrefix(facts.commissioningTraining.lots) + VALUE_LABELS[facts.commissioningTraining.value]!} detail={facts.commissioningTraining.detail} quote={facts.commissioningTraining.quote} found={found("commissioningTraining")} unknown={facts.commissioningTraining.value === "UNKNOWN"} />
          <FactRow label="Yerinde servis" value={lotPrefix(facts.localService.lots) + VALUE_LABELS[facts.localService.value]!} detail={facts.localService.detail} quote={facts.localService.quote} found={found("localService")} unknown={facts.localService.value === "UNKNOWN"} />
          <FactRow label="Garanti" value={facts.warranty.years === null ? UNKNOWN : facts.warranty.years === 0 ? "İstenmiyor" : `${facts.warranty.years} yıl`} detail={facts.warranty.detail} quote={facts.warranty.quote} found={found("warranty")} unknown={facts.warranty.years === null} />
          <FactRow label="Teslimat düzeni" value={VALUE_LABELS[facts.deliveryPattern.value]!} detail={facts.deliveryPattern.detail} quote={facts.deliveryPattern.quote} found={found("deliveryPattern")} unknown={facts.deliveryPattern.value === "UNKNOWN"} />
          <FactRow label="Teslim noktaları" value={POINTS_LABELS[facts.deliveryPoints.value]!} detail={facts.deliveryPoints.detail} quote={facts.deliveryPoints.quote} found={found("deliveryPoints")} unknown={facts.deliveryPoints.value === "UNKNOWN"} />
          {months !== null ? (
            <FactRow label="Sözleşme süresi" value={`${months} ay`} detail="İlanın yapılandırılmış alanından." quote="" found={undefined} structured />
          ) : (
            <FactRow label="Sözleşme süresi" value={facts.contractDuration.months !== null ? `${facts.contractDuration.months} ay` : UNKNOWN} detail="" quote={facts.contractDuration.quote} found={found("contractDuration")} unknown={facts.contractDuration.months === null} />
          )}
          {details?.framework !== null && details?.framework !== undefined ? (
            <FactRow label="Çerçeve anlaşma" value={details.framework ? "Evet" : "Hayır"} detail="İlanın yapılandırılmış alanından." quote="" found={undefined} structured />
          ) : (
            <FactRow label="Çerçeve anlaşma" value={VALUE_LABELS[facts.framework.value]!} detail="" quote={facts.framework.quote} found={found("framework")} unknown={facts.framework.value === "UNKNOWN"} />
          )}
          <FactRow label="Marka" value={facts.brand.value === "NONE" ? "Marka şartı yok" : VALUE_LABELS[facts.brand.value]!} detail={facts.brand.detail} quote={facts.brand.quote} found={found("brand")} unknown={facts.brand.value === "UNKNOWN"} />
          <FactRow label="Referans şartı" value={VALUE_LABELS[facts.pastPerformance.value]!} detail={facts.pastPerformance.detail} quote={facts.pastPerformance.quote} found={found("pastPerformance")} unknown={facts.pastPerformance.value === "UNKNOWN"} />
          <FactRow label="Asgari ciro" value={VALUE_LABELS[facts.turnover.value]!} detail={facts.turnover.detail} quote={facts.turnover.quote} found={found("turnover")} unknown={facts.turnover.value === "UNKNOWN"} />
          <FactRow label="Numune" value={VALUE_LABELS[facts.samples.value]!} detail="" quote={facts.samples.quote} found={found("samples")} unknown={facts.samples.value === "UNKNOWN"} />
          <FactRow label="Saha ziyareti" value={VALUE_LABELS[facts.siteVisit.value]!} detail="" quote={facts.siteVisit.quote} found={found("siteVisit")} unknown={facts.siteVisit.value === "UNKNOWN"} />
          <FactRow label="Kontrole tabi ürün" value={VALUE_LABELS[facts.restrictedProduct.value]!} detail={facts.restrictedProduct.detail} quote={facts.restrictedProduct.quote} found={found("restrictedProduct")} unknown={facts.restrictedProduct.value === "UNKNOWN"} />
          {award ? (
            <FactRow label="Değerlendirme" value={VALUE_LABELS[award.value]!} detail={`${award.text}. İlanın yapılandırılmış alanından.`} quote="" found={undefined} structured />
          ) : (
            <FactRow label="Değerlendirme" value={VALUE_LABELS[facts.awardCriteria.value]!} detail={facts.awardCriteria.detail} quote={facts.awardCriteria.quote} found={found("awardCriteria")} unknown={facts.awardCriteria.value === "UNKNOWN"} />
          )}
          {facts.certifications.map((cert, i) => (
            <FactRow
              key={`cert-${i}`}
              label="Belge"
              value={`${cert.name} (${CERT_LEVEL_LABELS[cert.level]})`}
              detail=""
              quote={cert.quote}
              found={quoteChecks ? label(quoteChecks.certifications[i]) : undefined}
            />
          ))}
        </ul>
        {facts.documentsToCheck.length > 0 && (
          <div className="flex flex-col gap-1">
            <h4 className="font-medium">Bilinmeyenleri çözecek dokümanlar</h4>
            <ul className="list-disc pl-5">
              {facts.documentsToCheck.map((doc) => (
                <li key={doc}>{doc}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function FactRow({
  label,
  value,
  detail,
  quote,
  found,
  unknown,
  structured,
}: {
  label: string;
  value: string;
  detail: string;
  quote: string;
  /** Where the quote was found, as a label (sourceLabel); null when it was not; undefined without checks. */
  found: string | null | undefined;
  /** An unknown value needs no quote. */
  unknown?: boolean;
  /** From the notice's structured fields, not from the model. */
  structured?: boolean;
}) {
  const verified = !!found;
  return (
    <li className="flex flex-col gap-0.5">
      <span>
        <span className="text-muted-foreground">{label}:</span> <span className={unknown ? "text-muted-foreground" : undefined}>{value}</span>
      </span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      {!unknown && !structured && (
        <span className="flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
          {quote && <q className="italic wrap-anywhere">{quote}</q>}
          {verified ? (
            <span>kaynak: {found}</span>
          ) : (
            <Badge variant="outline" title="Alıntı modelin okuduğu ilan metninde ve dosyalarda bulunamadı; bu olgu karar için kullanılmadı.">
              doğrulanmadı, kararda kullanılmadı
            </Badge>
          )}
        </span>
      )}
    </li>
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
    <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-3 text-xs">
      <p>
        {hasEarlier ? "Son olgu çıkarma denemesi başarısız" : "Olgu çıkarma başarısız"} ({formatDateTime(attempt.createdAt)}): {errorKind(attempt.error)}.{" "}
        {attempt.output === null ? "Bir saat sonra kendiliğinden yeniden denenir." : "İlan değişince yeniden denenir."}
      </p>
      <details>
        <summary className="cursor-pointer text-muted-foreground">Ayrıntı</summary>
        <p className="mt-1 wrap-anywhere">{attempt.error ?? "Hata metni yok."}</p>
        <p className="mt-1 text-muted-foreground">
          Elle yeniden denemek için: <code>pnpm facts --tender={tenderId}</code>
        </p>
      </details>
    </div>
  );
}

function Score({ label, range: r }: { label: string; range: Range }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        <span className="text-base font-medium">{expectedScore(r)}</span>
        {r.low !== r.high && <span className="ml-1 text-xs text-muted-foreground">({range(r)})</span>}
      </dd>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
