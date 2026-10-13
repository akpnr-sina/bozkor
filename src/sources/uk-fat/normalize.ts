import { countryNameToAlpha2, normalizeAlpha2 } from "@/lib/countries";
import { parseTimestamp } from "@/lib/time";
import type {
  NormalizedDocument,
  NormalizedLot,
  NormalizedNotice,
  NoticeStage,
  RawNoticeKeys,
  Regime,
} from "../types";
import { fatReleaseSchema, type FatRelease } from "./schema";

/** Find a Tender reads and writes wall-clock times in UK local time. */
export const FAT_TIMEZONE = "Europe/London";
const NOTICE_BASE_URL = "https://www.find-tender.service.gov.uk/Notice/";

type Tender = NonNullable<FatRelease["tender"]>;
type Item = NonNullable<Tender["items"]>[number];
type Lot = NonNullable<Tender["lots"]>[number];
type Doc = NonNullable<Tender["documents"]>[number];
type Party = NonNullable<FatRelease["parties"]>[number];
type Value = Lot["value"];

/** Stage from OCDS release tags, e.g. ["tenderUpdate"] -> tender, ["award", "contract"] -> award. */
export function noticeStage(tags: readonly string[]): NoticeStage | null {
  if (tags.some((t) => t.startsWith("tender"))) return "tender";
  if (tags.some((t) => t.startsWith("planning"))) return "planning";
  if (tags.some((t) => t.startsWith("award") || t.startsWith("contract"))) return "award";
  return null;
}

/** Identity for storing a raw release. Every stage is stored (CLAUDE.md rule 2). */
export function fatNoticeKeys(raw: unknown): RawNoticeKeys | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, ocid } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof ocid !== "string" || !ocid) return null;
  return { externalId: id, procedureKey: ocid };
}

const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;
const unique = <T>(values: T[]): T[] => [...new Set(values)];

function clean(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

const CPV_CODE = /^(\d{8})(?:-\d)?$/;

function cpvOf(c: { scheme?: string | null; id?: string | null } | null | undefined): string | null {
  if (!c?.id) return null;
  if (c.scheme && c.scheme.toUpperCase() !== "CPV") return null;
  return CPV_CODE.exec(c.id.trim())?.[1] ?? null;
}

function itemCpvs(item: Item): string[] {
  return [item.classification, ...(item.additionalClassifications ?? [])].map(cpvOf).filter(isPresent);
}

/** Net value when given, otherwise gross; zero means "not disclosed". */
function amountOf(value: Value): { amount: number; currency: string | null } | null {
  const net = value?.amount && value.amount > 0 ? value.amount : null;
  const gross = value?.amountGross && value.amountGross > 0 ? value.amountGross : null;
  const amount = net ?? gross;
  if (amount === null) return null;
  return { amount, currency: clean(value?.currency)?.toUpperCase() ?? null };
}

function sumLotValues(lots: NormalizedLot[] | null): { amount: number; currency: string | null } | null {
  if (!lots?.length || lots.some((l) => l.valueAmount === null)) return null;
  const currencies = unique(lots.map((l) => l.valueCurrency));
  if (currencies.length !== 1) return null;
  return { amount: lots.reduce((sum, l) => sum + (l.valueAmount ?? 0), 0), currency: currencies[0] ?? null };
}

function regimeOf(t: Tender | null): Regime | null {
  if (!t) return null;
  const special = t.specialRegime ?? [];
  if (special.includes("defenceSecurity")) return "defence";
  if (special.includes("utilities")) return "utilities";
  if (t.legalBasis?.scheme?.toUpperCase() === "CELEX") {
    if (t.legalBasis.id === "32009L0081") return "defence";
    if (t.legalBasis.id === "32014L0025") return "utilities";
    // Notices under the pre-2025 regulations only reached Find a Tender above threshold.
    return "covered";
  }
  if (t.aboveThreshold === true) return "covered";
  if (t.aboveThreshold === false) return "below_threshold";
  return null;
}

function statusOf(tags: readonly string[], t: Tender | null): NormalizedNotice["status"] {
  if (tags.some((tag) => tag.endsWith("Cancellation"))) {
    // Termination notices say "cancelled" or "complete" when the whole
    // procurement ends (awards are marked cancelled either way). "active"
    // means only some lots ended, so the tender itself stays open.
    return t?.status === "active" ? null : "cancelled";
  }
  switch (t?.status) {
    case "cancelled":
    case "withdrawn":
    case "unsuccessful":
      return "cancelled";
    case "complete":
      return "awarded";
    case "active":
    case "planning":
    case "planned":
      return "open";
    default:
      return null;
  }
}

function allDocuments(r: FatRelease): Doc[] {
  return [...(r.planning?.documents ?? []), ...(r.tender?.documents ?? [])];
}

/** Links to Find a Tender notice pages, as opposed to procurement documents. */
function isNoticeDocument(d: Doc): boolean {
  return Boolean(d.noticeType) || /Notice$/.test(d.documentType ?? "");
}

function ownNoticeDocument(r: FatRelease): Doc | null {
  return (
    allDocuments(r).find(
      (d) => isNoticeDocument(d) && (d.id === r.id || Boolean(d.url?.endsWith(`/${r.id}`))),
    ) ?? null
  );
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const BARE_DOMAIN = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

/** First URL in free text; bare domains such as "www.example.co.uk" get https://. */
export function extractUrl(text: string | null | undefined): string | null {
  const trimmed = clean(text);
  if (!trimmed) return null;
  const match = URL_IN_TEXT.exec(trimmed);
  if (match) return match[0].replace(/[.,;)]+$/, "");
  return BARE_DOMAIN.test(trimmed) ? `https://${trimmed}` : null;
}

function httpUrl(text: string | null | undefined): string | null {
  const url = clean(text);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function documentsOf(r: FatRelease): NormalizedDocument[] {
  const byUrl = new Map<string, NormalizedDocument>();
  for (const d of allDocuments(r)) {
    if (isNoticeDocument(d)) continue;
    const raw = clean(d.url);
    const url = raw && /^https?:\/\//i.test(raw) ? raw : extractUrl(raw);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, { url, title: clean(d.title) ?? clean(d.description), documentType: clean(d.documentType) });
  }
  return [...byUrl.values()];
}

function quantityOf(items: Item[]): string | null {
  const parts = items
    .filter((i) => isPresent(i.quantity))
    .map((i) => [i.quantity, clean(i.unit?.name)].filter(isPresent).join(" "));
  return parts.length ? parts.join("; ") : null;
}

// The Find a Tender form defaults the lot currency to AED (first in its list).
// Lots then carry the tender's GBP amount labelled AED, so trust the tender currency.
const FORM_DEFAULT_CURRENCY = "AED";

function lotsOf(t: Tender, tenderCurrency: string | null): NormalizedLot[] | null {
  const lots = t.lots ?? [];
  if (!lots.length) return null;
  const items = t.items ?? [];
  const seen = new Set<string>();
  const result: NormalizedLot[] = [];
  for (const lot of lots) {
    if (!lot.id || seen.has(lot.id)) continue;
    seen.add(lot.id);
    const related = items.filter((i) => i.relatedLot === lot.id);
    const lotItems = related.length ? related : lots.length === 1 ? items : [];
    const value = amountOf(lot.value);
    const currency =
      value?.currency === FORM_DEFAULT_CURRENCY && tenderCurrency && tenderCurrency !== FORM_DEFAULT_CURRENCY
        ? tenderCurrency
        : (value?.currency ?? null);
    result.push({
      lotNumber: lot.id,
      title: clean(lot.title),
      description: clean(lot.description),
      cpv: unique(lotItems.flatMap(itemCpvs)),
      valueAmount: value?.amount ?? null,
      valueCurrency: value ? currency : null,
      quantityText: quantityOf(lotItems),
    });
  }
  // Termination notices list lots by number and status only; such a list
  // says nothing about which lots exist, so it must not replace the real one.
  const thin = result.every((l) => !l.title && !l.description && !l.cpv.length && l.valueAmount === null);
  return result.length && !thin ? result : null;
}

function buyerParty(r: FatRelease): Party | null {
  const parties = r.parties ?? [];
  const buyerId = r.buyer?.id;
  return (
    (buyerId ? parties.find((p) => p.id === buyerId) : undefined) ??
    parties.find((p) => p.roles?.includes("buyer")) ??
    null
  );
}

function milestoneText(r: FatRelease): string | null {
  const texts = (r.planning?.milestones ?? []).map((m) => clean(m.description)).filter(isPresent);
  return texts.length ? texts.join("\n\n") : null;
}

function awardStageStatus(tags: readonly string[], t: Tender | null): "awarded" | "cancelled" {
  const ended = t?.status === "unsuccessful" || t?.status === "cancelled" || t?.status === "withdrawn";
  // Contract changes and terminations come after an award was made.
  const laterContractEvent = tags.some((tag) => tag === "contractAmendment" || tag === "contractTermination");
  return ended && !laterContractEvent ? "cancelled" : "awarded";
}

/** Award and contract notices only report the outcome; every other field is left to the tender notices. */
function statusOnlyNotice(r: FatRelease, publishedAt: Date): NormalizedNotice {
  return {
    source: "uk_fat",
    externalId: r.id,
    procedureKey: r.ocid,
    publishedAt,
    noticeType: "award",
    noticeCode: null,
    regime: null,
    status: awardStageStatus(r.tag, r.tender ?? null),
    title: null,
    description: null,
    buyerName: null,
    buyerCountry: null,
    nutsCode: null,
    cpvMain: null,
    cpvAdditional: [],
    valueAmount: null,
    valueCurrency: null,
    submissionDeadline: null,
    clarificationDeadline: null,
    procedureType: null,
    noticeLanguage: null,
    noticeUrl: null,
    documentsPortalUrl: null,
    lots: null,
    documents: [],
  };
}

/**
 * Maps one Find a Tender OCDS release. Award and contract releases become
 * status-only notices; returns null for releases without a known stage.
 * Throws when identity fields are missing or malformed.
 */
export function normalizeFatRelease(raw: unknown): NormalizedNotice | null {
  const r = fatReleaseSchema.parse(raw);
  const noticeType = noticeStage(r.tag);
  if (!noticeType) return null;

  const publishedAt = parseTimestamp(r.date, FAT_TIMEZONE);
  if (!publishedAt) throw new Error(`Unreadable release date "${r.date}" in ${r.id}`);
  if (noticeType === "award") return statusOnlyNotice(r, publishedAt);

  const t = r.tender ?? null;
  // Old-regime corrections list their amendments as free text and repeat
  // only fragments of the notice (the description is the correction itself).
  // Their description, CPVs, lots and value must not replace the original's.
  const partial = Boolean(t?.amendments?.length) && !clean(t?.status);
  const items = partial ? [] : (t?.items ?? []);
  const tenderCpv = partial ? null : cpvOf(t?.classification);
  const cpvs = unique([tenderCpv, ...items.flatMap(itemCpvs)].filter(isPresent));
  const cpvMain = tenderCpv ?? cpvs[0] ?? null;
  const tenderValue = partial ? null : amountOf(t?.value);
  const lots = t && !partial ? lotsOf(t, tenderValue?.currency ?? null) : null;
  const value = tenderValue ?? sumLotValues(lots);
  const documents = documentsOf(r);
  const own = ownNoticeDocument(r);
  const buyer = buyerParty(r);
  const deliveryRegion = (t?.items ?? [])
    .flatMap((i) => i.deliveryAddresses ?? [])
    .map((a) => clean(a.region))
    .find(isPresent);

  return {
    source: "uk_fat",
    externalId: r.id,
    procedureKey: r.ocid,
    publishedAt,
    noticeType,
    noticeCode: clean(own?.noticeType),
    regime: regimeOf(t),
    status: statusOf(r.tag, t),
    title: clean(t?.title),
    description: partial ? null : (clean(t?.description) ?? milestoneText(r)),
    buyerName: clean(r.buyer?.name) ?? clean(buyer?.name),
    // Find a Tender only carries UK contracting authorities.
    buyerCountry:
      normalizeAlpha2(buyer?.address?.country) ?? countryNameToAlpha2(buyer?.address?.countryName) ?? "GB",
    nutsCode: deliveryRegion ?? clean(buyer?.address?.region),
    cpvMain,
    cpvAdditional: cpvs.filter((c) => c !== cpvMain),
    valueAmount: value?.amount ?? null,
    valueCurrency: value?.currency ?? null,
    // Competitive flexible procedures with a participation stage only give the
    // expression of interest deadline, which is the first one a supplier must meet.
    submissionDeadline:
      parseTimestamp(t?.tenderPeriod?.endDate, FAT_TIMEZONE) ??
      parseTimestamp(t?.expressionOfInterestDeadline, FAT_TIMEZONE),
    clarificationDeadline: parseTimestamp(t?.enquiryPeriod?.endDate, FAT_TIMEZONE),
    procedureType: clean(t?.procurementMethodDetails) ?? clean(t?.procurementMethod),
    noticeLanguage: clean(r.language)?.toUpperCase() ?? null,
    // Only http(s) links reach href attributes and, later, the document fetcher.
    noticeUrl: httpUrl(own?.url) ?? `${NOTICE_BASE_URL}${r.id}`,
    documentsPortalUrl:
      extractUrl(t?.submissionMethodDetails) ??
      documents.find((d) => d.documentType === "biddingDocuments")?.url ??
      null,
    lots,
    documents,
  };
}
