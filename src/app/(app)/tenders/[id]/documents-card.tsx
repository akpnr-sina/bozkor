import { Badge } from "@/components/ui/badge";
import { DOCUMENT_LIMITS } from "@/documents/limits";
import type { TenderDocument } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import { formatBytes } from "@/lib/format";
import { DeleteDocumentButton } from "./delete-document-button";
import { documentDescription, documentFacts, documentName, documentState, type DocumentTone } from "./document-state";
import { RefreshWhileReading } from "./refresh-while-reading";

// The documents of a tender (SPEC section 8): the notice's links with what
// fetching found, uploaded files, the members of ZIPs, and what the deep
// analysis will read. Most links lead to a portal; the card says so first.

const TONE_VARIANT: Record<DocumentTone, "default" | "secondary" | "destructive" | "outline"> = {
  good: "default",
  waiting: "secondary",
  action: "outline",
  problem: "destructive",
  neutral: "outline",
};

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
    <div className="flex flex-col gap-4">
      <RefreshWhileReading active={reading > 0} />
      <p className="text-sm text-muted-foreground">{summary.join(", ")}.</p>

      {showPortal && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p>
            {inputs.length
              ? "Bazı linkler hâlâ alıcının portalına gidiyor; eksik dosyalar orada olabilir."
              : uploadsEnabled
                ? "Dokümanlar alıcının portalında. Portaldan indirip buraya yükleyin; ZIP olarak da yükleyebilirsiniz."
                : "Dokümanlar alıcının portalında; portaldan indirilebilir."}
          </p>
          <a
            href={portal}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border px-3 text-sm font-medium hover:bg-muted"
          >
            Portalı aç<span className="sr-only"> (yeni sekmede açılır)</span>
          </a>
        </div>
      )}

      {upload}

      {documents.length ? (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {documents.map((doc) => {
            const state = documentState(doc, context);
            const facts = documentFacts(doc);
            const name = documentName(doc);
            const description = documentDescription(doc);
            const fromNotice = doc.origin === "auto" && doc.sourceUrl && !doc.parentId;
            return (
              <li key={doc.id} className="flex flex-col gap-1 px-3 py-2" style={doc.depth ? { paddingLeft: `${0.75 + doc.depth * 1.25}rem` } : undefined}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium wrap-anywhere">{name}</span>
                  <Badge variant={TONE_VARIANT[state.tone]}>{state.label}</Badge>
                  <span className="text-xs text-muted-foreground">{originLabel(doc)}</span>
                </div>
                {description && (
                  <span title={description} className="line-clamp-3 text-xs text-muted-foreground wrap-anywhere">
                    {description}
                  </span>
                )}
                {facts && <span className="text-xs text-muted-foreground">{facts}</span>}
                {state.note && <span className="text-xs text-muted-foreground wrap-anywhere">{state.note}</span>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  {doc.stored && doc.mime === KIND_MIME.pdf && (
                    <a
                      href={`/documents/${doc.id}?view=1`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${name} dosyasını yeni sekmede aç`}
                      className="underline underline-offset-4"
                    >
                      Aç
                    </a>
                  )}
                  {doc.stored && (
                    <a href={`/documents/${doc.id}`} aria-label={`${name} dosyasını indir`} className="underline underline-offset-4">
                      İndir
                    </a>
                  )}
                  {fromNotice && (
                    <a
                      href={doc.sourceUrl!}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`${name} linkini yeni sekmede aç`}
                      className="underline underline-offset-4"
                    >
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
        <p className="text-sm text-muted-foreground">
          {portal ? "İlanda doğrudan doküman linki yok; henüz dosya yüklenmedi." : "İlanda doküman linki yok ve henüz dosya yüklenmedi."}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Bu ihalenin dosyaları: {formatBytes(storedBytes)} / {formatBytes(DOCUMENT_LIMITS.tenderBytes)}. &quot;Analize girecek&quot; dosyaları derin analiz okur.
      </p>
    </div>
  );
}
