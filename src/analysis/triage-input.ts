import { SOURCE_LABELS } from "@/lib/format";
import type { QuoteSources, TriageNotice, TriageProfile } from "./types";

// The user message of the triage call (SPEC 7.1) and the notice texts a quote
// may come from. Deterministic: the same notice and profile always give the
// same message, and what gets cut never depends on the profile, so
// noticeQuoteSources works without one. Tag names are explained in
// prompts/triage.v1.md; keep the two in step.

/**
 * Character limits for the notice texts. With tags and context lines a notice
 * stays under ~38,000 characters; the profile comes on top, usually well under 2,000.
 */
export const TRIAGE_INPUT_LIMITS = {
  title: 1_000,
  description: 6_000,
  lots: 30,
  lotTitle: 500,
  lotDescription: 1_000,
  lotQuantity: 500,
  /** Title, description and lot texts together; lots that do not fit are left out. */
  noticeTexts: 34_000,
} as const;

export type InputLimits = { [K in keyof typeof TRIAGE_INPUT_LIMITS]: number };

/** A notice text as the model sees it. */
export type Piece = { text: string; truncated: boolean };

export type PreparedLot = {
  lot: TriageNotice["lots"][number];
  title: Piece | null;
  description: Piece | null;
  quantity: Piece | null;
};

export type PreparedNotice = {
  title: Piece | null;
  description: Piece | null;
  lots: PreparedLot[];
  /** Lots beyond the lot limit or the text budget. */
  omittedLots: number;
};

/** Trims the text and cuts it at a word boundary near `max` when it is longer. */
export function piece(value: string | null | undefined, max: number): Piece | null {
  const text = value?.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  for (let i = max; i > max * 0.8; i--) {
    if (/\s/.test(text[i] ?? "")) {
      end = i;
      break;
    }
  }
  // Never split a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return { text: text.slice(0, end).trimEnd(), truncated: true };
}

const size = (...pieces: (Piece | null)[]) => pieces.reduce((total, p) => total + (p?.text.length ?? 0), 0);

/** Cuts the notice texts to the limits; what gets cut depends only on the notice. */
export function prepareNotice(notice: TriageNotice, limits: InputLimits = TRIAGE_INPUT_LIMITS): PreparedNotice {
  const title = piece(notice.title, limits.title);
  const description = piece(notice.description, limits.description);
  let used = size(title, description);
  const lots: PreparedLot[] = [];
  for (const lot of notice.lots.slice(0, limits.lots)) {
    const prepared: PreparedLot = {
      lot,
      title: piece(lot.title, limits.lotTitle),
      description: piece(lot.description, limits.lotDescription),
      quantity: piece(lot.quantityText, limits.lotQuantity),
    };
    const lotSize = size(prepared.title, prepared.description, prepared.quantity);
    // Lots stay in notice order: the first one that does not fit ends the list.
    if (used + lotSize > limits.noticeTexts) break;
    used += lotSize;
    lots.push(prepared);
  }
  return { title, description, lots, omittedLots: notice.lots.length - lots.length };
}

export function sourcesOf(prepared: PreparedNotice): QuoteSources {
  const sources: QuoteSources = {};
  if (prepared.title) sources.title = prepared.title.text;
  if (prepared.description) sources.description = prepared.description.text;
  for (const { lot, title, description, quantity } of prepared.lots) {
    if (title) sources[`lot:${lot.lotNumber}:title`] = title.text;
    if (description) sources[`lot:${lot.lotNumber}:description`] = description.text;
    if (quantity) sources[`lot:${lot.lotNumber}:quantity`] = quantity.text;
  }
  return sources;
}

/** The notice texts the triage prompt shows, keyed as in QuoteSources, with the same cuts. */
export function noticeQuoteSources(notice: TriageNotice): QuoteSources {
  return sourcesOf(prepareNotice(notice));
}

export function textTag(name: string, value: Piece | null): string[] {
  if (!value) return [];
  return [`<${name}${value.truncated ? ' kisaltildi="evet"' : ""}>${value.text}</${name}>`];
}

const money = (amount: number | null, currency: string | null) =>
  amount === null ? null : currency ? `${amount} ${currency}` : String(amount);

const utc = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function contextLines(notice: TriageNotice): string[] {
  const lines = [`Kaynak: ${SOURCE_LABELS[notice.source]}`];
  const add = (label: string, value: string | null | undefined) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  add("Alıcı", notice.buyerName);
  add("Alıcı ülkesi", notice.buyerCountry);
  add("İlan dili", notice.noticeLanguage);
  add("Usul", notice.procedureType);
  add("Ana CPV", notice.cpvMain);
  add("Ek CPV", notice.cpvAdditional.join(", "));
  const value = money(notice.valueAmount, notice.valueCurrency);
  const inEur =
    value && notice.valueEur !== null && notice.valueCurrency !== "EUR"
      ? ` (yaklaşık ${Math.round(notice.valueEur)} EUR)`
      : "";
  add("Tahmini değer", value && `${value}${inEur}`);
  add("Son teklif tarihi", notice.submissionDeadline && utc(notice.submissionDeadline));
  return lines;
}

function lotLines({ lot, title, description, quantity }: PreparedLot): string[] {
  const value = money(lot.valueAmount, lot.valueCurrency);
  const context = [lot.cpv.length ? `CPV: ${lot.cpv.join(", ")}` : null, value ? `Tahmini değer: ${value}` : null].filter(
    (part): part is string => part !== null,
  );
  return [
    `<lot numara="${lot.lotNumber}">`,
    ...(context.length ? [`<lot_bilgileri>${context.join("; ")}</lot_bilgileri>`] : []),
    ...textTag("lot_basligi", title),
    ...textTag("lot_aciklamasi", description),
    ...textTag("lot_miktari", quantity),
    "</lot>",
  ];
}

/** The `<ilan>` block; `extra` adds context lines to `<bilgiler>` and sections after the lots. */
export function noticeLines(
  notice: TriageNotice,
  prepared: PreparedNotice,
  extra: { info?: string[]; sections?: string[] } = {},
): string[] {
  const lots = notice.lots.length
    ? [
        `<lotlar toplam="${notice.lots.length}"${prepared.omittedLots ? ` gosterilmeyen="${prepared.omittedLots}"` : ""}>`,
        ...prepared.lots.flatMap(lotLines),
        "</lotlar>",
      ]
    : [];
  return [
    "<ilan>",
    "<bilgiler>",
    ...contextLines(notice),
    ...(extra.info ?? []),
    "</bilgiler>",
    ...textTag("baslik", prepared.title),
    ...textTag("aciklama", prepared.description),
    ...lots,
    ...(extra.sections ?? []),
    "</ilan>",
  ];
}

const cleanList = (values: readonly string[] | undefined) => (values ?? []).map((v) => v.trim()).filter(Boolean);

function listTag(name: string, values: string[], numbered = false): string[] {
  if (!values.length) return [];
  return [`<${name}>`, ...values.map((v, i) => (numbered ? `${i + 1}. ${v}` : `- ${v}`)), `</${name}>`];
}

function profileLines(profile: TriageProfile): string[] {
  const description = profile.description.trim();
  return [
    "<profil>",
    `<profil_adi>${profile.name.trim()}</profil_adi>`,
    `<profil_aciklamasi>${description || "(boş)"}</profil_aciklamasi>`,
    ...listTag("profil_kategorileri", cleanList(profile.categories)),
    ...listTag("profil_anahtar_kelimeleri", cleanList(profile.keywords)),
    ...listTag("profil_istenmeyen_kelimeleri", cleanList(profile.excludedKeywords)),
    ...listTag("profil_sorulari", cleanList(profile.questions), true),
    "</profil>",
  ];
}

/**
 * The triage user message: the notice first (it is the long part), then the
 * profile and the request. `sources` holds exactly the notice texts in it,
 * for checking the model's quotes (see quotes.ts).
 */
export function buildTriageInput(notice: TriageNotice, profile: TriageProfile): { text: string; sources: QuoteSources } {
  const prepared = prepareNotice(notice);
  const text = [
    ...noticeLines(notice, prepared),
    "",
    ...profileLines(profile),
    "",
    "Yukarıdaki ilanı bu profile göre değerlendir.",
  ].join("\n");
  return { text, sources: sourcesOf(prepared) };
}
