import { charCost, compareCandidates, type FactsFileCandidate } from "./facts-input";
import type { QuoteSources } from "./types";

// What the deep analysis reads (SPEC 7.2): the notice as the facts stage reads
// it, the profiles' questions, and the tender's files themselves, in the order
// a bid team reads them (uploads, specification, bid instructions, contract,
// price schedule, others). PDFs go as PDFs, so tables and scanned pages are
// read too; DOCX and XLSX as their text. The files are read in parts that stay
// well inside a request's limits (32 MB, the context window, 100 PDF pages);
// a tender whose files do not fit one part is read part by part and the parts
// are merged. Keep the tags in step with prompts/deep.v1.md.

/** A tender file the deep analysis may read: an analysis input (analysisInputIds) with what it takes to send it. */
export type DeepCandidate = FactsFileCandidate & { storagePath: string; sizeBytes: number; pageCount: number | null };

/** A file the analysis reads: its number in the input ("Dosya n", "file:<n>") and how it goes to the model. */
export type DeepFile = DeepCandidate & {
  n: number;
  /** As a PDF, or as its text: DOCX, XLSX, and a PDF too large for a part. */
  as: "pdf" | "text";
  /** Estimated input tokens. */
  tokens: number;
};

export type DeepSkipped = { candidate: DeepCandidate; reason: string };

export const DEEP_LIMITS = {
  /** Files read at most, in order; the rest are listed as left out. */
  files: 40,
  /** Parts of one analysis at most. */
  parts: 6,
  /** PDF bytes in a part: base64 makes them a third larger, and a request takes 32 MB. */
  partBytes: 18 * 1024 * 1024,
  /** PDF pages in a part: a request takes 100 under a 1M-token context. */
  partPages: 90,
  /** Estimated tokens of a part's files, the notice and the answer coming on top. */
  partTokens: 140_000,
  /** Estimated tokens of a PDF page as the model reads it: its text and its image (1,500-3,000 by the docs). */
  pdfPageTokens: 2_500,
  /** Characters of one file sent as text. */
  textFileChars: 150_000,
} as const;

const PAGE_BREAK = "\f";

/** Estimated tokens of a text: about one for 3.5 characters, Cyrillic and Greek counting double. */
export const textTokens = (text: string) => Math.ceil((text.length * charCost(text)) / 3.5);

/**
 * The text a file goes to the model with when not as a PDF: a PDF's pages in
 * `<sayfa no="k">` (the page numbers its quotes cite), other files' text as it
 * is, cut to DEEP_LIMITS.textFileChars.
 */
export function deepFileText(file: Pick<DeepCandidate, "kind" | "text">): { text: string; cut: boolean } {
  let text: string;
  if (file.kind === "pdf") {
    text = file.text
      .split(PAGE_BREAK)
      .map((page, k) => (page.trim() ? `<sayfa no="${k + 1}">\n${page.trim()}\n</sayfa>` : ""))
      .filter(Boolean)
      .join("\n");
  } else {
    text = file.text;
  }
  if (text.length <= DEEP_LIMITS.textFileChars) return { text, cut: false };
  return { text: text.slice(0, DEEP_LIMITS.textFileChars), cut: true };
}

/**
 * The files of a tender the analysis reads, numbered in reading order, and the
 * parts they are read in: each part within the limits, the files in order. A
 * PDF too large for a part goes as its text; one without text is left out,
 * as are files past the limits, each with why.
 */
export function planDeepParts(candidates: readonly DeepCandidate[]): { files: DeepFile[]; parts: DeepFile[][]; skipped: DeepSkipped[] } {
  const files: DeepFile[] = [];
  const parts: DeepFile[][] = [];
  const skipped: DeepSkipped[] = [];
  let part: DeepFile[] = [];
  let used = { tokens: 0, bytes: 0, pages: 0 };
  const close = () => {
    if (part.length) parts.push(part);
    part = [];
    used = { tokens: 0, bytes: 0, pages: 0 };
  };
  for (const candidate of [...candidates].sort(compareCandidates)) {
    if (files.length >= DEEP_LIMITS.files) {
      skipped.push({ candidate, reason: `Analiz en çok ${DEEP_LIMITS.files} dosya okur.` });
      continue;
    }
    const pages = candidate.kind === "pdf" ? (candidate.pageCount ?? 0) : 0;
    // A PDF within a request's pages and bytes goes as a PDF, alone in a part if its estimate is over a part's
    // tokens (the estimate is rough; a request the API finds too long is retried with the file as text).
    const fitsAsPdf = candidate.kind === "pdf" && pages > 0 && pages <= DEEP_LIMITS.partPages && candidate.sizeBytes <= DEEP_LIMITS.partBytes;
    let as: DeepFile["as"];
    let tokens: number;
    if (fitsAsPdf) {
      as = "pdf";
      tokens = pages * DEEP_LIMITS.pdfPageTokens;
    } else {
      const { text } = deepFileText(candidate);
      if (!text.trim()) {
        skipped.push({ candidate, reason: "Tek seferde okunamayacak kadar büyük PDF ve metni yok (taranmış olabilir)." });
        continue;
      }
      as = "text";
      tokens = Math.min(textTokens(text), DEEP_LIMITS.partTokens);
    }
    const bytes = as === "pdf" ? candidate.sizeBytes : 0;
    const filePages = as === "pdf" ? pages : 0;
    const fits =
      used.tokens + tokens <= DEEP_LIMITS.partTokens && used.bytes + bytes <= DEEP_LIMITS.partBytes && used.pages + filePages <= DEEP_LIMITS.partPages;
    if (!fits && part.length) close();
    if (!part.length && parts.length >= DEEP_LIMITS.parts) {
      skipped.push({ candidate, reason: `Analiz en çok ${DEEP_LIMITS.parts} parçada okur; bu dosyaya sıra gelmedi.` });
      continue;
    }
    const file: DeepFile = { ...candidate, n: files.length + 1, as, tokens };
    files.push(file);
    part.push(file);
    used = { tokens: used.tokens + tokens, bytes: used.bytes + bytes, pages: used.pages + filePages };
  }
  close();
  return { files, parts, skipped };
}

/** A value as an attribute: one line, no quotes or angle brackets, no em dash. */
const attribute = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replaceAll('"', "'")
    .replace(/[<>]/g, "")
    .replaceAll(String.fromCharCode(0x2014), "-")
    .trim()
    .slice(0, 200);

/** The title of a file's document block: "Dosya n: name". */
export const deepFileTitle = (file: Pick<DeepFile, "n" | "name">) => `Dosya ${file.n}: ${attribute(file.name)}`;

/** `<dosya_listesi>`: every file of the tender, those of this part marked, those left out with why (only so, once left out after being numbered). */
function fileList(all: readonly DeepFile[], skipped: readonly DeepSkipped[], part: readonly DeepFile[] | null): string[] {
  const left = new Set(skipped.map((s) => s.candidate.id));
  const files = all.filter((f) => !left.has(f.id));
  if (!files.length && !skipped.length) return [];
  const inPart = new Set(part?.map((f) => f.n));
  return [
    `<dosya_listesi toplam="${files.length + skipped.length}">`,
    ...files.map((f) => {
      const pages = f.kind === "pdf" && f.pageCount ? ` sayfa="${f.pageCount}"` : "";
      const asText = f.as === "text" && f.kind === "pdf" ? ' metin_olarak="evet"' : "";
      const here = part && inPart.has(f.n) ? ' bu_partide="evet"' : "";
      return `<dosya sira="${f.n}" ad="${attribute(f.name)}" tur="${f.kind}"${pages}${asText}${here}/>`;
    }),
    ...skipped.map((s) => `<dosya ad="${attribute(s.candidate.name)}" tur="${s.candidate.kind}" alinmadi="${attribute(s.reason)}"/>`),
    "</dosya_listesi>",
  ];
}

function questionList(questions: readonly string[]): string[] {
  if (!questions.length) return [];
  return ["<profil_sorulari>", ...questions.map((q, i) => `<soru sira="${i + 1}">${q.replace(/[<>]/g, "")}</soru>`), "</profil_sorulari>"];
}

/**
 * The user text of one call of the analysis: the notice (`noticeText`, the
 * facts stage's `<ilan>`), the file list, the questions and, when the files
 * are read in parts, which part this is. The files themselves go as document
 * blocks before it (deepFileTitle).
 */
export function buildDeepMessage(input: {
  noticeText: string;
  files: readonly DeepFile[];
  skipped: readonly DeepSkipped[];
  questions: readonly string[];
  part: { files: readonly DeepFile[]; no: number; count: number };
}): string {
  const { part } = input;
  return [
    input.noticeText.trim(),
    ...fileList(input.files, input.skipped, part.files),
    ...questionList(input.questions),
    ...(part.count > 1 ? [`<parti no="${part.no}" toplam="${part.count}"/>`] : []),
  ].join("\n");
}

/** The user text of the merge: the notice, the file list, the questions and each part's analysis. */
export function buildDeepMergeMessage(input: {
  noticeText: string;
  files: readonly DeepFile[];
  skipped: readonly DeepSkipped[];
  questions: readonly string[];
  parts: readonly unknown[];
}): string {
  return [
    input.noticeText.trim(),
    ...fileList(input.files, input.skipped, null),
    ...questionList(input.questions),
    `<parti_sonuclari toplam="${input.parts.length}">`,
    ...input.parts.map((output, i) => `<parti no="${i + 1}">\n${JSON.stringify(output)}\n</parti>`),
    "</parti_sonuclari>",
  ].join("\n");
}

/**
 * Every quotable text of the analysis, keyed as its quote checks record them:
 * the notice's texts as "notice:<key>" (keys as the facts stage's), a PDF's
 * page k of the n-th file as "file:<n>:p<k>", another file's text as
 * "file:<n>". A PDF without text gives none: its quotes stay unverified.
 */
export function deepQuoteSources(noticeSources: QuoteSources, files: readonly DeepFile[]): QuoteSources {
  const sources: QuoteSources = {};
  for (const [key, text] of Object.entries(noticeSources)) sources[`notice:${key}`] = text;
  for (const file of files) {
    if (file.kind === "pdf") {
      file.text.split(PAGE_BREAK).forEach((page, k) => {
        if (page.trim()) sources[`file:${file.n}:p${k + 1}`] = page;
      });
    } else if (file.text.trim()) {
      sources[`file:${file.n}`] = file.text;
    }
  }
  return sources;
}
