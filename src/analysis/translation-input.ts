import { piece, type Piece } from "./triage-input";
import type { TriageNotice } from "./types";

// The user message of the translation call: only the notice's own texts.
// Lots come in the notice's natural order (toTriageNotice), and lotNumbers
// lists exactly the ones sent so the answer can be checked against them. Tag
// names are explained in the translation prompt (prompts/translate.v*.md); keep the two in step.

/**
 * Character limits. A Turkish translation is about as long as the original;
 * the limits keep the answer well inside the output limit of a non-streaming call.
 */
export const TRANSLATION_INPUT_LIMITS = {
  title: 1_000,
  description: 8_000,
  lots: 30,
  lotTitle: 500,
  lotDescription: 1_500,
  /** Title, description and lot texts together; lots that do not fit are left out. */
  texts: 30_000,
} as const;

function textTag(name: string, value: Piece | null): string[] {
  if (!value) return [];
  return [`<${name}${value.truncated ? ' kisaltildi="evet"' : ""}>${value.text}</${name}>`];
}

const size = (...pieces: (Piece | null)[]) => pieces.reduce((total, p) => total + (p?.text.length ?? 0), 0);

/** The message, the lot numbers sent (in order), and whether anything was cut or left out. */
export function buildTranslationInput(notice: TriageNotice): { text: string; lotNumbers: string[]; truncated: boolean } {
  const limits = TRANSLATION_INPUT_LIMITS;
  const title = piece(notice.title, limits.title);
  const description = piece(notice.description, limits.description);
  let used = size(title, description);
  const lots: { lotNumber: string; title: Piece | null; description: Piece | null }[] = [];
  for (const lot of notice.lots.slice(0, limits.lots)) {
    const prepared = { lotNumber: lot.lotNumber, title: piece(lot.title, limits.lotTitle), description: piece(lot.description, limits.lotDescription) };
    const lotSize = size(prepared.title, prepared.description);
    // Lots stay in order: the first one that does not fit ends the list.
    if (used + lotSize > limits.texts) break;
    used += lotSize;
    lots.push(prepared);
  }
  const omitted = notice.lots.length - lots.length;
  const truncated = Boolean(title?.truncated || description?.truncated || omitted > 0 || lots.some((l) => l.title?.truncated || l.description?.truncated));

  const lines = [
    `<ilan${notice.noticeLanguage ? ` dil="${notice.noticeLanguage}"` : ""}>`,
    ...textTag("baslik", title),
    ...textTag("aciklama", description),
  ];
  if (lots.length) {
    lines.push(`<lotlar toplam="${notice.lots.length}"${omitted > 0 ? ` gosterilmeyen="${omitted}"` : ""}>`);
    for (const lot of lots) {
      lines.push(`<lot numara="${lot.lotNumber}">`, ...textTag("lot_basligi", lot.title), ...textTag("lot_aciklamasi", lot.description), "</lot>");
    }
    lines.push("</lotlar>");
  }
  lines.push("</ilan>", "", "Yukarıdaki ilanı Türkçeye çevir.");
  return { text: lines.join("\n"), lotNumbers: lots.map((l) => l.lotNumber), truncated };
}
