import type { NoticeDetails } from "@/sources/types";
import { noticeLines, piece, prepareNotice, sourcesOf, TRIAGE_INPUT_LIMITS, type Piece } from "./triage-input";
import type { QuoteSources, TriageNotice } from "./types";

// The user message of the facts call (qualification policy part XII.2): the
// notice in the same layout as triage, with the structured contract details
// as context lines and the selection criteria, performance terms and document
// descriptions as quotable sections. No profile: facts do not depend on who
// is asking. Tag names are explained in prompts/facts.v1.md; keep the two in step.

/**
 * The notice as the facts stage reads it: the triage notice plus the document
 * links' descriptions, where some buyers write the specification (FaT 096535).
 */
export type FactsNotice = TriageNotice & { documents?: { title: string | null; documentType: string | null }[] };

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
} as const;

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

/**
 * The facts user message. `sources` holds every quotable text exactly as the
 * model sees it: the notice texts (keyed as in triage), "selection:<n>" for
 * the n-th selection criterion shown (1-based, as in its `sira` attribute),
 * "performance" for the performance terms and "document:<n>" for the n-th
 * document description shown. `lotNumbers` lists the lots in the message, in
 * order, or [""] when the notice has none: the output must have one record per entry.
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

  const text = [
    ...noticeLines(notice, prepared, { info: details ? detailLines(details) : [], sections }),
    "",
    "Bu ilandaki olguları çıkar.",
  ].join("\n");
  const lotNumbers = prepared.lots.length ? prepared.lots.map(({ lot }) => lot.lotNumber) : [""];
  return { text, sources, lotNumbers };
}

/** The quotable texts of the facts input, for checking or fingerprinting stored facts. */
export function factsQuoteSources(notice: FactsNotice): QuoteSources {
  return buildFactsInput(notice).sources;
}
