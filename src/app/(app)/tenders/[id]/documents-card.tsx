import { EmptyState } from "@/components/empty-state";
import { Meter } from "@/components/meter";
import { Notice } from "@/components/notice";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DOCUMENT_LIMITS } from "@/documents/limits";
import type { TenderDocument } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import { formatBytes } from "@/lib/format";
import { DeleteDocumentButton } from "./delete-document-button";
import { documentDescription, documentFacts, documentName, documentState, type DocumentTone } from "./document-state";
import { RefreshWhileReading } from "./refresh-while-reading";

// The documents of a tender (SPEC section 8): the notice's links with what
// fetching found, uploaded files, the members of ZIPs, and what the deep
// analysis will read. Most links lead to a portal; the tab says so first.
// Laid out like the overview: the list in the main column, the portal, the
// upload and the space used on the right.

const TONE_VARIANT: Record<DocumentTone, BadgeVariant> = {
  good: "ok",
  waiting: "info",
  action: "warn",
  problem: "err",
  neutral: "default",
};

const LINK = "text-ink-900 underline underline-offset-4 hover:text-ink-600";

type Props = {
  tenderId: string;
  documents: TenderDocument[];
  storedBytes: number;
  portalUrl: string | null;
  /** The tender's links are fetched now (fetchWanted). */
  fetchWanted: boolean;
  uploadsEnabled: boolean;
  now: Date;
  /** The upload area, a client component. */
  upload: React.ReactNode;
};

export function DocumentsCard({ tenderId, documents, storedBytes, portalUrl, fetchWanted, uploadsEnabled, now, upload }: Props) {
  const inputs = documents.filter((doc) => doc.analysisInput);
  const inputShas = new Set(inputs.map((doc) => doc.sha256).filter((sha): sha is string => !!sha));
  // Portal pages that gave none of their files.
  const atPortal = documents.filter((doc) => doc.fetchStatus === "needs_manual" && !doc.members);
  const reading = documents.filter((doc) => doc.stored && !doc.processed).length;
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  /** Where a document came from: the notice, a ZIP, a portal page, or an upload. */
  const originLabel = (doc: TenderDocument) => {
    const parent = doc.parentId ? byId.get(doc.parentId) : undefined;
    if (parent) return parent.mime === KIND_MIME.zip ? "ZIP'ten" : "Portaldan";
    return doc.origin === "auto" && doc.sourceUrl ? "İlandan" : "Yüklendi";
  };
  const portal = portalUrl ?? atPortal.find((doc) => doc.sourceUrl)?.sourceUrl ?? null;
  const children = new Map<string, string[]>();
  for (const doc of documents) if (doc.parentId) children.set(doc.parentId, [...(children.get(doc.parentId) ?? []), doc.id]);
  /** Everything that came out of a ZIP, ZIPs inside it included. */
  const descendants = (id: string): number => (children.get(id) ?? []).reduce((n, child) => n + 1 + descendants(child), 0);
  const context = { inputShas, fetchWanted, uploadsEnabled, now };

  const summary = [
    inputs.length ? `${inputs.length} dosya analize girecek` : "Henüz analize girecek dosya yok",
    reading ? `${reading} dosya okunuyor` : "",
    atPortal.length ? `${atPortal.length} link alıcının portalına gidiyor` : "",
  ].filter(Boolean);
  const showPortal = portal && (!inputs.length || atPortal.length > 0);

  return (
    <div className="grid items-start gap-[18px] lg:grid-cols-[minmax(0,1fr)_380px]">
      <RefreshWhileReading tenderId={tenderId} reading={reading} />
      <Card>
        <CardHeader>
          <CardTitle>Dokümanlar · {documents.length}</CardTitle>
          <CardDescription>{summary.join(", ")}.</CardDescription>
        </CardHeader>
        {documents.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {documents.map((doc) => {
              const state = documentState(doc, context);
              const facts = documentFacts(doc);
              const name = documentName(doc);
              const description = documentDescription(doc);
              const fromNotice = doc.origin === "auto" && doc.sourceUrl && !doc.parentId;
              return (
                <li key={doc.id} className="flex flex-col gap-1.5 px-4 py-3" style={doc.depth ? { paddingLeft: `${1 + doc.depth * 1.25}rem` } : undefined}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {doc.depth > 0 && (
                      <span aria-hidden className="text-ink-400">
                        ↳
                      </span>
                    )}
                    <span className="text-sm font-medium text-ink-900 wrap-anywhere">{name}</span>
                    <Badge variant={TONE_VARIANT[state.tone]} dot>
                      {state.label}
                    </Badge>
                    <span className="text-xs text-ink-500">{originLabel(doc)}</span>
                  </div>
                  {description && (
                    <span title={description} className="line-clamp-3 text-xs text-ink-600 wrap-anywhere">
                      {description}
                    </span>
                  )}
                  {facts && <span className="font-mono text-xs text-ink-500">{facts}</span>}
                  {state.note && <span className="text-xs text-ink-600 wrap-anywhere">{state.note}</span>}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {doc.stored && doc.mime === KIND_MIME.pdf && (
                      <a href={`/documents/${doc.id}?view=1`} target="_blank" rel="noreferrer" aria-label={`${name} dosyasını yeni sekmede aç`} className={LINK}>
                        Aç
                      </a>
                    )}
                    {doc.stored && (
                      <a href={`/documents/${doc.id}`} aria-label={`${name} dosyasını indir`} className={LINK}>
                        İndir
                      </a>
                    )}
                    {fromNotice && (
                      <a href={doc.sourceUrl!} target="_blank" rel="noreferrer" aria-label={`${name} linkini yeni sekmede aç`} className={LINK}>
                        Linke git
                      </a>
                    )}
                    {/* A ZIP's members go with the ZIP; deleting one alone could not be undone, as the ZIP stays. */}
                    {doc.origin === "manual" && !doc.parentId && uploadsEnabled && (
                      <DeleteDocumentButton tenderId={tenderId} documentId={doc.id} name={name} members={descendants(doc.id)} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <CardContent>
            <EmptyState>{portal ? "İlanda doğrudan doküman linki yok; henüz dosya yüklenmedi." : "İlanda doküman linki yok ve henüz dosya yüklenmedi."}</EmptyState>
          </CardContent>
        )}
        <CardFooter className="text-xs text-ink-500">
          <p>&quot;Analize girecek&quot; dosyaları olgu çıkarma ve derin analiz okur.</p>
        </CardFooter>
      </Card>

      {/* On a narrow screen the portal and the upload come first: they are what the team does here. */}
      <div className="order-first flex min-w-0 flex-col gap-[18px] lg:order-none">
        {showPortal && (
          <Notice
            tone="info"
            title={inputs.length ? "Bazı linkler alıcının portalına gidiyor" : "Dokümanlar alıcının portalında"}
            action={
              <a href={portal} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Portalı aç<span className="sr-only"> (yeni sekmede açılır)</span>
              </a>
            }
          >
            {inputs.length
              ? "Eksik dosyalar orada olabilir."
              : uploadsEnabled
                ? "Portaldan indirip buraya yükleyin; ZIP olarak da yükleyebilirsiniz."
                : "Portaldan indirilebilir."}
          </Notice>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Dosya yükle</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {upload}
            <div className="flex flex-col gap-1.5 border-t border-line pt-3">
              <span className="flex items-baseline justify-between gap-3 text-xs text-ink-500">
                <span>Bu ihalenin dosyaları</span>
                <span className="font-mono text-ink-700">
                  {formatBytes(storedBytes)} / {formatBytes(DOCUMENT_LIMITS.tenderBytes)}
                </span>
              </span>
              <Meter value={storedBytes} max={DOCUMENT_LIMITS.tenderBytes} tone="muted" label="Kullanılan yer" className="w-full" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
