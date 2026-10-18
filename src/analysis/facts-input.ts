import type { NoticeDetails } from "@/sources/types";
import { noticeLines, piece, prepareNotice, sourcesOf, TRIAGE_INPUT_LIMITS, type Piece } from "./triage-input";
import type { QuoteSources, TriageNotice } from "./types";

// The user message of the facts call (qualification policy part XII.2): the
// notice in the same layout as triage, with the structured contract details
// as context lines and the selection criteria, performance terms and document
// descriptions as quotable sections, then the text of the tender's files. No
// profile: facts do not depend on who is asking. Tag names are explained in
// the facts prompt (prompts/facts.v*.md); keep the two in step.

/** A tender file the facts stage reads: its text, a PDF's page by page (`pages[k - 1]` is page k). */
export type FactsFile = { name: string; kind: "pdf" | "docx" | "xlsx"; pages: string[]; truncated: boolean };

/** A file that may go into the facts input: one the deep analysis reads too (analysisInputIds). */
export type FactsFileCandidate = {
  id: string;
  name: string;
  kind: "pdf" | "docx" | "xlsx";
  documentType: string | null;
  origin: "auto" | "manual";
  /** The stored text: a PDF's pages separated by form feeds (src/documents/extract.ts). */
  text: string;
  /** The text was cut when the file was read. */
  truncated: boolean;
  createdAt: Date;
};

/**
 * The notice as the facts stage reads it: the triage notice plus the document
 * links' descriptions, where some buyers write the specification (FaT 096535),
 * and the files chosen by selectFactsFiles with the number it left out.
 */
export type FactsNotice = TriageNotice & {
  documents?: { title: string | null; documentType: string | null }[];
  files?: FactsFile[];
  filesOmitted?: number;
};

/** Notice limits as in triage, with room left for the details sections. */
export const FACTS_INPUT_LIMITS = {
  notice: { ...TRIAGE_INPUT_LIMITS, noticeTexts: 30_000 },
  selectionItems: 10,
  selectionItem: 1_500,
  /** All selection criteria texts together. */
  selectionTexts: 6_000,
  performance: 2_000,
  awardCriteria: 10,
  awardName: 200,
  awardDescription: 300,
  documents: 10,
  document: 1_500,
  /** All document descriptions together. */
  documentTexts: 4_000,
  /**
   * The tender's files: how many, the text of one and of all together, about
   * 60,000 tokens at most. Cyrillic and Greek text, which takes about twice
   * the tokens per character, counts double against both character limits.
   */
  files: { count: 12, fileChars: 60_000, totalChars: 240_000 },
} as const;

/** Separates a PDF's pages in its stored text, as src/documents/extract.ts writes it. */
const PAGE_BREAK = "\f";

/** A file is left out rather than shown with less text than this. */
const MIN_FILE_CHARS = 1_000;

const yesNo = (value: boolean | null, yes = "evet", no = "hayır") => (value === null ? null : value ? yes : no);

const AWARD_TYPE: Record<string, string> = { price: "fiyat", quality: "kalite", cost: "maliyet" };

/** A text cut to `max` and kept on one line, as context lines are. */
const inline = (value: string | null, max: number) => piece(value, max)?.text.replace(/\s+/g, " ") ?? null;

function detailLines(details: NoticeDetails): string[] {
  const lines: string[] = [];
  const add = (label: string, value: string | null) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  add("Sözleşme süresi", details.durationMonths === null ? null : `${details.durationMonths} ay`);
  add("Çerçeve anlaşma", yesNo(details.framework));
  add("Elektronik sipariş", yesNo(details.electronicOrdering));
  add("GPA kapsamında", yesNo(details.gpaCovered));
  add("Teminat", yesNo(details.guaranteeRequired, "isteniyor", "istenmiyor"));
  add("Teklif dilleri", details.submissionLanguages.join(", "));
  const criteria = details.awardCriteria
    .map((c) => {
      const label = [
        inline(c.name, FACTS_INPUT_LIMITS.awardName),
        c.type && AWARD_TYPE[c.type],
        c.weight === null ? null : `ağırlık ${c.weight}`,
      ]
        .filter(Boolean)
        .join(", ");
      return [label, inline(c.description, FACTS_INPUT_LIMITS.awardDescription)].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  // Lots with distinct criteria can list dozens; like the sections, say how many are left out.
  const shown = criteria.slice(0, FACTS_INPUT_LIMITS.awardCriteria);
  const omitted = criteria.length - shown.length;
  add(
    `Değerlendirme kriterleri${omitted ? ` (toplam ${criteria.length}, gösterilmeyen ${omitted})` : ""}`,
    shown.join("; "),
  );
  return lines;
}

type Item = { type: string | null; text: Piece };

/**
 * Non-empty texts in notice order, each cut to `itemMax`, at most `maxItems`;
 * the first one that would pass `budget` ends the list.
 */
function itemPieces(
  entries: readonly { type: string | null; text: string | null }[],
  maxItems: number,
  itemMax: number,
  budget: number,
): { shown: Item[]; total: number } {
  const present = entries.filter((e) => e.text?.trim());
  const shown: Item[] = [];
  let used = 0;
  for (const entry of present.slice(0, maxItems)) {
    const text = piece(entry.text, itemMax);
    if (!text) continue;
    if (used + text.text.length > budget) break;
    used += text.text.length;
    shown.push({ type: entry.type, text });
  }
  return { shown, total: present.length };
}

const cut = (p: Piece) => (p.truncated ? ' kisaltildi="evet"' : "");

/** A quotable list section; adds each text to `sources` as `<key>:<n>`, 1-based like `sira`. */
function itemSection(
  listTag: string,
  itemTag: string,
  key: string,
  { shown, total }: { shown: Item[]; total: number },
  sources: QuoteSources,
): string[] {
  if (!shown.length) return [];
  const omitted = total - shown.length;
  return [
    `<${listTag} toplam="${total}"${omitted ? ` gosterilmeyen="${omitted}"` : ""}>`,
    ...shown.map(({ type, text }, i) => {
      sources[`${key}:${i + 1}`] = text.text;
      return `<${itemTag} sira="${i + 1}"${type ? ` tur="${type}"` : ""}${cut(text)}>${text.text}</${itemTag}>`;
    }),
    `</${listTag}>`,
  ];
}

// ---------------------------------------------------------------------------
// Tender files

/** documentType order of factsDocumentOrder (src/analysis/facts.ts); other types and none come after. */
const DOCUMENT_TYPES = ["technicalSpecifications", "biddingDocuments", "eligibilityCriteria", "evaluationCriteria", "contractDraft", "billOfQuantity"];

/**
 * Lower case without accents (Turkish dotless i and Greek final sigma
 * included), words of any script separated by single spaces, padded with one.
 */
const foldName = (name: string) =>
  ` ${name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replaceAll("ı", "i")
    .toLowerCase()
    .replaceAll("ς", "σ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;

/**
 * Words in a file name that tell its role, most useful first: specification,
 * instructions to tenderers, contract, price schedule. Stems are matched at
 * the start of a word of the folded name (so "spec" is not found in
 * "inspection"), acronyms only as whole words.
 */
const NAME_GROUPS = [
  {
    words: ["şartname", "teknik", "spec", "technical", "tehničn", "technisch", "caderno", "cahier", "техническ", "спецификаци", "τεχνικ", "προδιαγραφ"],
    acronyms: ["cctp", "sow"],
  },
  {
    words: ["teklif talimat", "razpis", "instructions", "pogoji", "conditions", "документаци", "услови", "διακήρυξ"],
    acronyms: ["itt", "rfq", "ccap", "rc"],
  },
  { words: ["sözleşme", "contract", "pogodba", "vertrag", "договор", "σύμβασ"], acronyms: [] },
  { words: ["fiyat", "price", "predračun", "bordereau", "цени", "ценов", "τιμολόγι"], acronyms: ["boq", "bpu", "dpgf"] },
].map(({ words, acronyms }) => ({ words: words.map((w) => foldName(w).trimEnd()), acronyms: acronyms.map(foldName) }));

function nameRank(name: string): number {
  const folded = foldName(name);
  const rank = NAME_GROUPS.findIndex(({ words, acronyms }) => words.some((word) => folded.includes(word)) || acronyms.some((acronym) => folded.includes(acronym)));
  return rank === -1 ? NAME_GROUPS.length : rank;
}

/** Characters looked at to tell a file's script. */
const SCRIPT_SAMPLE = 5_000;

/**
 * What one character of the file costs against the character limits: 2 when
 * most letters at its start are Cyrillic or Greek, 1 otherwise.
 */
function charCost(text: string): number {
  const sample = text.slice(0, SCRIPT_SAMPLE);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  const dense = sample.match(/[\p{Script=Cyrillic}\p{Script=Greek}]/gu)?.length ?? 0;
  return letters && dense / letters > 0.5 ? 2 : 1;
}

function typeRank(documentType: string | null): number {
  const rank = documentType ? DOCUMENT_TYPES.indexOf(documentType) : -1;
  return rank === -1 ? DOCUMENT_TYPES.length : rank;
}

/** Uploads first (the team picked them), then by the notice's document type, the name, and age. */
function compareCandidates(a: FactsFileCandidate, b: FactsFileCandidate): number {
  return (
    Number(a.origin !== "manual") - Number(b.origin !== "manual") ||
    typeRank(a.documentType) - typeRank(b.documentType) ||
    nameRank(a.name) - nameRank(b.name) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/**
 * As much of a file as `budget` characters hold: a PDF's pages from the first,
 * whole (only a first page longer than the budget is cut), other files cut at
 * a word boundary. Null when the file has no text.
 */
function fitFile(candidate: FactsFileCandidate, budget: number): { file: FactsFile; chars: number } | null {
  const { name, kind } = candidate;
  if (kind !== "pdf") {
    const text = piece(candidate.text, budget);
    if (!text) return null;
    return { file: { name, kind, pages: [text.text], truncated: candidate.truncated || text.truncated }, chars: text.text.length };
  }
  const all = candidate.text.split(PAGE_BREAK).map((page) => page.trim());
  const pages: string[] = [];
  let chars = 0;
  for (const page of all) {
    if (chars + page.length > budget) {
      if (chars === 0) {
        const first = piece(page, budget)!;
        pages.push(first.text);
        chars += first.text.length;
      }
      break;
    }
    pages.push(page);
    chars += page.length;
  }
  if (!chars) return null;
  const truncated = candidate.truncated || all.slice(pages.length).some(Boolean) || pages.at(-1) !== all[pages.length - 1];
  return { file: { name, kind, pages, truncated }, chars };
}

/**
 * The files of a tender the facts stage reads, in the order it reads them, and
 * their ids in the same order: at most FACTS_INPUT_LIMITS.files.count, each
 * cut to fileChars and all to totalChars, Cyrillic and Greek counting double.
 * `omitted`: files with text that did not fit.
 */
export function selectFactsFiles(candidates: readonly FactsFileCandidate[]): { files: FactsFile[]; ids: string[]; omitted: number } {
  const limits = FACTS_INPUT_LIMITS.files;
  const withText = candidates.filter((c) => c.text.replaceAll(PAGE_BREAK, "").trim());
  const files: FactsFile[] = [];
  const ids: string[] = [];
  let left = limits.totalChars;
  for (const candidate of [...withText].sort(compareCandidates)) {
    if (files.length >= limits.count || left < MIN_FILE_CHARS) break;
    const cost = charCost(candidate.text);
    const budget = Math.floor(Math.min(limits.fileChars, left) / cost);
    if (budget < MIN_FILE_CHARS) continue;
    const fitted = fitFile(candidate, budget);
    if (!fitted) continue;
    files.push(fitted.file);
    ids.push(candidate.id);
    left -= fitted.chars * cost;
  }
  return { files, ids, omitted: withText.length - files.length };
}

/** A file name as an attribute value: one line, no quotes or angle brackets, no em dash. */
const attribute = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replaceAll('"', "'")
    .replace(/[<>]/g, "")
    .replaceAll(String.fromCharCode(0x2014), "-")
    .trim()
    .slice(0, 200);

/**
 * The `<dosyalar>` block. Quotable texts go to `sources`: a PDF's page k of the
 * n-th file as "file:<n>:p<k>", the text of another file as "file:<n>". Empty
 * pages are left out; page numbers stay those of the file.
 */
function fileLines(files: readonly FactsFile[], omitted: number, sources: QuoteSources): string[] {
  if (!files.length) return [];
  return [
    `<dosyalar toplam="${files.length + omitted}"${omitted ? ` gosterilmeyen="${omitted}"` : ""}>`,
    ...files.flatMap((file, i) => {
      const n = i + 1;
      const open = `<dosya sira="${n}" ad="${attribute(file.name)}" tur="${file.kind}"${file.truncated ? ' kesildi="evet"' : ""}>`;
      if (file.kind !== "pdf") {
        const text = file.pages[0] ?? "";
        sources[`file:${n}`] = text;
        return [open, text, "</dosya>"];
      }
      const pages = file.pages.flatMap((page, k) => {
        if (!page) return [];
        sources[`file:${n}:p${k + 1}`] = page;
        return [`<sayfa no="${k + 1}">${page}</sayfa>`];
      });
      return [open, ...pages, "</dosya>"];
    }),
    "</dosyalar>",
  ];
}

/**
 * The facts user message. `sources` holds every quotable text exactly as the
 * model sees it: the notice texts (keyed as in triage), "selection:<n>" for
 * the n-th selection criterion shown (1-based, as in its `sira` attribute),
 * "performance" for the performance terms, "document:<n>" for the n-th
 * document description shown, and the files' texts (see fileLines). `lotNumbers`
 * lists the lots in the message, in order, or [""] when the notice has none:
 * the output must have one record per entry.
 */
export function buildFactsInput(notice: FactsNotice): { text: string; sources: QuoteSources; lotNumbers: string[] } {
  const limits = FACTS_INPUT_LIMITS;
  const prepared = prepareNotice(notice, limits.notice);
  const sources = sourcesOf(prepared);
  const details = notice.details ?? null;
  const sections: string[] = [];

  if (details) {
    const selection = details.selectionCriteria.map((c) => ({ type: c.type, text: c.description }));
    sections.push(
      ...itemSection(
        "secim_kriterleri",
        "secim_kriteri",
        "selection",
        itemPieces(selection, limits.selectionItems, limits.selectionItem, limits.selectionTexts),
        sources,
      ),
    );
    const performance = piece(details.performanceTerms, limits.performance);
    if (performance) {
      sections.push(`<ifa_kosullari${cut(performance)}>${performance.text}</ifa_kosullari>`);
      sources.performance = performance.text;
    }
  }

  const documents = (notice.documents ?? []).map((d) => ({ type: d.documentType, text: d.title }));
  sections.push(
    ...itemSection(
      "dokumanlar",
      "dokuman",
      "document",
      itemPieces(documents, limits.documents, limits.document, limits.documentTexts),
      sources,
    ),
  );

  // After the notice, not in it: the files are the tender's documents.
  const files = fileLines(notice.files ?? [], notice.filesOmitted ?? 0, sources);
  const text = [
    ...noticeLines(notice, prepared, { info: details ? detailLines(details) : [], sections }),
    ...files,
    "",
    files.length ? "Bu ilandaki ve ihale dosyalarındaki olguları çıkar." : "Bu ilandaki olguları çıkar.",
  ].join("\n");
  const lotNumbers = prepared.lots.length ? prepared.lots.map(({ lot }) => lot.lotNumber) : [""];
  return { text, sources, lotNumbers };
}

/** The quotable texts of the facts input, for checking or fingerprinting stored facts. */
export function factsQuoteSources(notice: FactsNotice): QuoteSources {
  return buildFactsInput(notice).sources;
}
