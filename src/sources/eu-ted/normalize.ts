import { alpha3ToAlpha2 } from "@/lib/countries";
import { languageToAlpha2 } from "@/lib/languages";
import { zonedLocalToUtc } from "@/lib/time";
import type {
  ContractNature,
  NormalizedDocument,
  NormalizedLot,
  NormalizedNotice,
  NoticeStage,
  RawNoticeKeys,
  Regime,
} from "../types";
import { TED_TIMEZONE } from "./client";
import { tedNoticeSchema, type TedNotice } from "./schema";

const NOTICE_BASE_URL = "https://ted.europa.eu/en/notice/-/detail/";

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/**
 * Form type to notice stage; result notices are not fetched (SPEC 4.2).
 * Qualification systems (qu-sy) come as competition notices but are standing
 * supplier lists of utilities, open for years, not purchases to bid on.
 */
function stageOf(formType: string | null, noticeType: string | null): NoticeStage | null {
  if (noticeType === "qu-sy") return null;
  if (formType === "competition") return "tender";
  if (formType === "planning") return "planning";
  return null;
}

// Change reasons (BT-140) that end the procedure. None revokes a cancellation;
// a suspension after a complaint (susp-review) is not one.
const CANCELLING_CHANGES = new Set(["cancel", "cancel-intent"]);

// Legal basis (BT-01) as a CELEX number.
const REGIME_BY_LEGAL_BASIS: Record<string, Regime> = {
  "32014L0024": "covered", // public procurement directive
  "32014L0023": "covered", // concessions directive
  "32014L0025": "utilities",
  "32009L0081": "defence",
  // EU institutions buying under the Financial Regulation (2018 and 2024 versions).
  "32018R1046": "covered",
  "32024R2509": "covered",
};

function regimeOf(legalBasis: string[]): Regime | null {
  if (!legalBasis.length) return null;
  for (const basis of legalBasis) {
    const regime = REGIME_BY_LEGAL_BASIS[basis.toUpperCase()];
    if (regime) return regime;
  }
  // "other": national rules, often below the EU thresholds, but not stated.
  return "unknown";
}

function natureOf(nature: string | null): ContractNature | null {
  if (nature === "supplies") return "goods";
  if (nature === "services" || nature === "works") return nature;
  return null;
}

const PROCEDURE_TYPES: Record<string, string> = {
  open: "Open procedure",
  restricted: "Restricted procedure",
  "neg-w-call": "Competitive procedure with negotiation",
  "neg-wo-call": "Negotiated procedure without prior call for competition",
  "comp-dial": "Competitive dialogue",
  innovation: "Innovation partnership",
  "oth-single": "Other single stage procedure",
  "oth-mult": "Other multiple stage procedure",
  // Public passenger transport (Regulation 1370/2007).
  "comp-tend": "Competitive tendering",
  "exp-int-rail": "Expression of interest (rail)",
};

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Combines a TED date ("2026-11-12+02:00") with its time ("10:00:00+02:00").
 * Without a time the deadline is the end of that day; without an offset the
 * values are Brussels time.
 */
export function tedTimestamp(date: string | null | undefined, time?: string | null): Date | null {
  const day = date?.trim().match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!day) return null;
  const clock = time?.trim().match(/^(\d{2}:\d{2}(?::\d{2})?)(.*)$/);
  const local = `${day[1]}T${clock?.[1] ?? "23:59:59"}`;
  const offset = OFFSET.exec(clock?.[2] ?? "")?.[1] ?? OFFSET.exec(day[2] ?? "")?.[1];
  if (!offset) return zonedLocalToUtc(local, TED_TIMEZONE);
  const ms = Date.parse(`${local}${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Publication dates are days; the notice counts as published at the start of its day. */
const startOfDay = (date: string): Date | null => tedTimestamp(date, "00:00:00");

/** Earliest deadline over the lots; times pair with dates by position, or one time for all. */
function earliestDeadline(dates: string[], times: string[]): Date | null {
  const instants = dates
    .map((date, i) => tedTimestamp(date, times.length === dates.length ? times[i] : times.length === 1 ? times[0] : null))
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  return instants.length ? new Date(Math.min(...instants)) : null;
}

/** Positive amount from a TED number string; "0" means "not stated". */
function amountOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

const CPV_CODE = /^(\d{8})(?:-\d)?$/;
const cpvCodes = (values: string[]): string[] =>
  values.map((v) => CPV_CODE.exec(v)?.[1]).filter((c): c is string => c !== undefined);

function httpUrls(values: string[]): string[] {
  return unique(values.filter((url) => /^https?:\/\//i.test(url)));
}

/** Language preference for multilingual texts: English, then the notice's own languages. */
function languageOrder(n: TedNotice): string[] {
  return unique(["eng", ...n["official-language"].map((l) => l.toLowerCase())]);
}

function textsIn(texts: Record<string, string[]>, order: string[]): string[] {
  for (const language of order) {
    const found = texts[language];
    if (found?.length) return found;
  }
  return Object.values(texts)[0] ?? [];
}

/** The value at a lot's position when the field has one value per lot, otherwise null. */
function perLot<T>(values: readonly T[], count: number, index: number): T | null {
  return values.length === count ? (values[index] ?? null) : null;
}

function lotsOf(n: TedNotice, order: string[]): NormalizedLot[] | null {
  const ids = n["identifier-lot"];
  if (!ids.length) return null;
  const count = ids.length;
  const titles = textsIn(n["title-lot"], order);
  const descriptions = textsIn(n["description-lot"], order);
  const values = n["estimated-value-lot"];
  const currencies = n["estimated-value-cur-lot"];
  const seen = new Set<string>();
  const lots: NormalizedLot[] = [];
  ids.forEach((lotNumber, i) => {
    if (seen.has(lotNumber)) return;
    seen.add(lotNumber);
    const amount = amountOf(perLot(values, count, i));
    // Lot currencies often come as a single value for every lot.
    const currency = perLot(currencies, count, i) ?? (currencies.length === 1 ? currencies[0] : null) ?? null;
    const cpv = perLot(n["main-classification-lot"], count, i);
    lots.push({
      lotNumber,
      title: perLot(titles, count, i),
      description: perLot(descriptions, count, i),
      // Additional lot codes come as one flat list and cannot be told apart by lot.
      cpv: cpv ? cpvCodes([cpv]) : [],
      valueAmount: amount,
      valueCurrency: amount === null ? null : (currency?.toUpperCase() ?? null),
      quantityText: null,
    });
  });
  return lots;
}

function sumLotValues(lots: NormalizedLot[] | null): { amount: number; currency: string | null } | null {
  if (!lots?.length || lots.some((l) => l.valueAmount === null)) return null;
  const currencies = unique(lots.map((l) => l.valueCurrency));
  if (currencies.length !== 1) return null;
  return { amount: lots.reduce((sum, l) => sum + (l.valueAmount ?? 0), 0), currency: currencies[0] ?? null };
}

// "<notice uuid>-<version>", the form a change notice uses to point at the notice it changes.
const CHANGED_NOTICE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d{2}$/i;

/**
 * Groups notices of one procedure. Competition notices and their changes share
 * the procedure identifier. Planning notices have none: a change of one is
 * grouped with the notice it changes, otherwise each stands alone.
 */
function procedureKeyOf(n: Pick<TedNotice, "procedure-identifier" | "change-notice-version-identifier" | "notice-identifier" | "publication-number">): string {
  return (
    n["procedure-identifier"] ??
    CHANGED_NOTICE.exec(n["change-notice-version-identifier"] ?? "")?.[1]?.toLowerCase() ??
    n["notice-identifier"] ??
    n["publication-number"]
  );
}

/** Identity for storing a raw notice. Every notice is stored (CLAUDE.md rule 2). */
export function tedNoticeKeys(raw: unknown): RawNoticeKeys | null {
  const parsed = tedNoticeSchema
    .pick({
      "publication-number": true,
      "procedure-identifier": true,
      "change-notice-version-identifier": true,
      "notice-identifier": true,
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  return { externalId: parsed.data["publication-number"], procedureKey: procedureKeyOf(parsed.data) };
}

/**
 * Maps one TED notice. Change notices restate the whole notice, so they are
 * full notices like the original; the fold keeps the latest. Returns null for
 * form types other than competition and planning, and for qualification
 * systems. Throws when the publication number or date is missing or malformed.
 */
export function normalizeTedNotice(raw: unknown): NormalizedNotice | null {
  const n = tedNoticeSchema.parse(raw);
  const noticeType = stageOf(n["form-type"], n["notice-type"]);
  if (!noticeType) return null;

  const externalId = n["publication-number"];
  const publishedAt = startOfDay(n["publication-date"]);
  if (!publishedAt) throw new Error(`Unreadable publication date "${n["publication-date"]}" in ${externalId}`);

  const order = languageOrder(n);
  const cpvMain = cpvCodes(n["main-classification-proc"])[0] ?? null;
  const cpvs = unique(
    cpvCodes([
      ...n["main-classification-proc"],
      ...n["additional-classification-proc"],
      ...n["main-classification-lot"],
      ...n["additional-classification-lot"],
      ...n["classification-cpv"],
    ]),
  );
  const lots = lotsOf(n, order);
  const procedureAmount = amountOf(n["estimated-value-proc"]);
  const value = procedureAmount
    ? { amount: procedureAmount, currency: n["estimated-value-cur-proc"]?.toUpperCase() ?? null }
    : sumLotValues(lots);
  const documentUrls = httpUrls(n["document-url-lot"]);
  const documents: NormalizedDocument[] = documentUrls.map((url) => ({
    url,
    title: null,
    documentType: "procurementDocuments",
  }));
  const languages = n["official-language"];

  return {
    source: "eu_ted",
    externalId,
    procedureKey: procedureKeyOf(n),
    publishedAt,
    noticeType,
    noticeCode: n["notice-type"],
    regime: regimeOf(n["legal-basis"]),
    contractNature: natureOf(n["contract-nature-main-proc"]),
    status: CANCELLING_CHANGES.has(n["change-reason-code"] ?? "") ? "cancelled" : "open",
    title: textsIn(n["title-proc"], order)[0] ?? null,
    description: textsIn(n["description-proc"], order)[0] ?? null,
    buyerName: textsIn(n["buyer-name"], order)[0] ?? null,
    buyerCountry: alpha3ToAlpha2(n["buyer-country"][0]),
    nutsCode: n["place-of-performance-subdiv-proc"][0] ?? n["place-of-performance-subdiv-lot"][0] ?? n["buyer-country-sub"][0] ?? null,
    cpvMain,
    cpvAdditional: cpvs.filter((c) => c !== cpvMain),
    valueAmount: value?.amount ?? null,
    valueCurrency: value?.currency ?? null,
    // Restricted and negotiated procedures first ask for requests to
    // participate; that is the first deadline a supplier must meet.
    submissionDeadline:
      earliestDeadline(n["deadline-receipt-tender-date-lot"], n["deadline-receipt-tender-time-lot"]) ??
      earliestDeadline(n["deadline-receipt-request-date-lot"], n["deadline-receipt-request-time-lot"]),
    clarificationDeadline: earliestDeadline(n["deadline-receipt-answers-date-lot"], n["deadline-receipt-answers-time-lot"]),
    procedureType: n["procedure-type"] ? (PROCEDURE_TYPES[n["procedure-type"]] ?? n["procedure-type"]) : null,
    // English when the notice is officially published in it, which is what the language filter cares about.
    noticeLanguage: languageToAlpha2(languages.find((l) => l.toUpperCase() === "ENG") ?? languages[0]),
    noticeUrl: `${NOTICE_BASE_URL}${externalId}`,
    documentsPortalUrl: documentUrls[0] ?? httpUrls(n["submission-url-lot"])[0] ?? null,
    lots,
    documents,
  };
}
