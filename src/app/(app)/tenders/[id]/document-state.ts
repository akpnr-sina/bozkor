import { isFetchableUrl } from "@/documents/fetch-job";
import { takesDocuments } from "@/documents/hosts";
import type { TenderDocument } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";

// What the tender page says about each document: one short state, a tone for
// its badge and a note with the reason or the next step.

export type DocumentTone = "good" | "waiting" | "action" | "problem" | "neutral";
export type DocumentState = { label: string; tone: DocumentTone; note: string | null };

export type StateContext = {
  /** Contents the analysis already reads through another document. */
  inputShas: ReadonlySet<string>;
  /** The tender's links are fetched now (fetchWanted). */
  fetchWanted: boolean;
  /** Files can be uploaded on the page. */
  uploadsEnabled: boolean;
  now: Date;
};

const KIND_LABELS: Record<string, string> = {
  [KIND_MIME.pdf]: "PDF",
  [KIND_MIME.docx]: "DOCX",
  [KIND_MIME.xlsx]: "XLSX",
  [KIND_MIME.zip]: "ZIP",
};

export function documentState(doc: TenderDocument, ctx: StateContext): DocumentState {
  const takeIt = ctx.uploadsEnabled ? "indirip buraya yükleyin." : "indirebilirsiniz.";
  switch (doc.fetchStatus) {
    case "pending": {
      // retry_at is the next attempt after a failure, or a run's claim while it fetches the link.
      const waiting = doc.retryAt !== null && doc.retryAt > ctx.now;
      const failedBefore = doc.fetchError !== null || doc.fetchAttempts > 0;
      if (waiting && !failedBefore) return { label: "İndiriliyor", tone: "waiting", note: null };
      if (waiting) return { label: "Yeniden denenecek", tone: "waiting", note: join(doc.fetchError, `Sonraki deneme: ${formatDateTime(doc.retryAt)}.`) };
      if (!isFetchableUrl(doc.sourceUrl)) return { label: "İndirilmedi", tone: "neutral", note: "Bu link web adresi değil; otomatik denenmez." };
      if (!ctx.fetchWanted) {
        return { label: "İndirilmedi", tone: "neutral", note: `Bu ihale otomatik indirme kapsamında değil; gerekirse linke gidip dosyayı ${takeIt}` };
      }
      return failedBefore
        ? { label: "Yeniden denenecek", tone: "waiting", note: join(doc.fetchError, "Sıradaki çalıştırmada denenecek.") }
        : { label: "İndirilmedi", tone: "neutral", note: "Link otomatik denenecek." };
    }
    case "needs_manual":
      // A link of a portal whose documents are taken (its page's links or its API), not taken to the end yet: the next runs go on.
      if (!doc.processed && takesDocuments(doc.sourceUrl)) {
        return ctx.fetchWanted
          ? { label: "Portaldan alınıyor", tone: "waiting", note: doc.fetchError }
          : { label: "Portaldan kısmen alındı", tone: "action", note: `İhale artık otomatik indirme kapsamında değil; eksikleri portaldan ${takeIt}` };
      }
      // Its document links were followed; what came of them is listed under it.
      if (doc.members) return { label: "Portaldan alındı", tone: "good", note: join(doc.fetchError, `Eksik varsa portaldan ${takeIt}`) };
      return { label: "Portalda", tone: "action", note: join(doc.fetchError, `Portaldan ${takeIt}`) };
    case "failed":
      return { label: "Alınamadı", tone: "problem", note: doc.fetchError };
    case "unsupported":
      return { label: "Okunmuyor", tone: "neutral", note: doc.fetchError };
    case "fetched":
      break;
  }
  if (!doc.stored) return { label: "Depoda yok", tone: "problem", note: doc.fetchError };
  if (!doc.processed) return { label: "Okunuyor", tone: "waiting", note: doc.fetchError ?? "Bir iki dakika içinde okunur; sayfa kendiliğinden yenilenir." };
  if (doc.analysisInput) return { label: "Analize girecek", tone: "good", note: doc.fetchError };
  if (doc.mime === KIND_MIME.zip) {
    // "Alınmayan: ..." lists what an opened ZIP left out; any other note says why it was not opened.
    if (doc.members || doc.fetchError?.startsWith("Alınmayan")) return { label: "ZIP açıldı", tone: "neutral", note: doc.fetchError };
    if (doc.fetchError) return { label: "Açılmadı", tone: "problem", note: doc.fetchError };
    return { label: "ZIP açıldı", tone: "neutral", note: "ZIP'te alınacak dosya yoktu." };
  }
  if (doc.sha256 && ctx.inputShas.has(doc.sha256)) return { label: "Kopya", tone: "neutral", note: "Aynı içerikteki dosya analize giriyor." };
  if (doc.fetchError) return { label: "Okunamadı", tone: "problem", note: doc.fetchError };
  return { label: "Metin yok", tone: "problem", note: "Dosyada okunacak metin bulunamadı." };
}

/** Kind, size, pages and text of a stored file: "PDF, 2,4 MB, 18 sayfa". */
export function documentFacts(doc: TenderDocument): string | null {
  if (!doc.stored) return null;
  const parts = [doc.mime ? (KIND_LABELS[doc.mime] ?? null) : null, doc.sizeBytes !== null ? formatBytes(doc.sizeBytes) : null];
  if (doc.pageCount) parts.push(`${formatNumber(doc.pageCount)} sayfa`);
  else if (doc.textChars) parts.push(`${formatNumber(doc.textChars)} karakter metin`);
  if (doc.textTruncated) parts.push("metnin bir kısmı alındı");
  return parts.filter(Boolean).join(", ") || null;
}

/** Notice descriptions up to this long make a name; longer ones (a whole specification, say) are shown below it. */
const NAME_CHARS = 120;

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};

/** The name to show: the file's name, a short description from the notice, or the link's site. */
export function documentName(doc: TenderDocument): string {
  if (doc.filename) return doc.filename;
  if (doc.title && doc.title.length <= NAME_CHARS) return doc.title;
  const host = hostOf(doc.sourceUrl);
  return host ? `${host} linki` : "Adsız dosya";
}

/** The notice's description of the link, when the name does not already show it. */
export function documentDescription(doc: TenderDocument): string | null {
  return doc.title && doc.title !== documentName(doc) ? doc.title : null;
}

const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" ") || null;
