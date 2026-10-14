import type { contractNature, regime, tenderStatus } from "@/db/schema";

export type SourceId = "uk_fat" | "eu_ted";
export type Regime = (typeof regime.enumValues)[number];
export type TenderStatus = (typeof tenderStatus.enumValues)[number];

/** Stage of a tender; profiles filter on this (SPEC section 6, `noticeTypes`). */
export type NoticeCategory = "planning" | "tender";

/**
 * Stage of a single notice. Award and contract notices only carry a status
 * for an existing tender; they never create one.
 */
export type NoticeStage = NoticeCategory | "award";

/** Main nature of the contract (OCDS mainProcurementCategory, eForms BT-23). */
export type ContractNature = (typeof contractNature.enumValues)[number];

export type NormalizedLot = {
  lotNumber: string;
  title: string | null;
  description: string | null;
  cpv: string[];
  valueAmount: number | null;
  valueCurrency: string | null;
  quantityText: string | null;
};

export type NormalizedDocument = {
  url: string;
  title: string | null;
  documentType: string | null;
};

/**
 * One notice mapped to platform fields. Null means "this notice does not say";
 * folding keeps the value from an earlier notice of the same procedure.
 * A notice is partial when it only states changes (old-regime corrections)
 * or only a status (award stage); partial notices never create a tender.
 */
export type NormalizedNotice = {
  source: SourceId;
  externalId: string;
  procedureKey: string;
  publishedAt: Date;
  noticeType: NoticeStage;
  /** Source-specific notice form, e.g. "UK4". */
  noticeCode: string | null;
  regime: Regime | null;
  contractNature: ContractNature | null;
  /** Lifecycle from the payload only; "closed" is derived from the deadline at query time. */
  status: Exclude<TenderStatus, "closed"> | null;
  title: string | null;
  description: string | null;
  buyerName: string | null;
  buyerCountry: string | null;
  nutsCode: string | null;
  cpvMain: string | null;
  cpvAdditional: string[];
  valueAmount: number | null;
  valueCurrency: string | null;
  submissionDeadline: Date | null;
  clarificationDeadline: Date | null;
  procedureType: string | null;
  noticeLanguage: string | null;
  noticeUrl: string | null;
  documentsPortalUrl: string | null;
  /** Null when the notice carries no lot information. */
  lots: NormalizedLot[] | null;
  documents: NormalizedDocument[];
};

/** A planning or tender notice with a stated status; only these can create a tender. */
export function isFullNotice(notice: NormalizedNotice): boolean {
  return notice.noticeType !== "award" && notice.status !== null;
}

/** Fields extracted before normalization so raw payloads can be stored and grouped. */
export type RawNoticeKeys = {
  externalId: string;
  procedureKey: string;
};

export type SyncWindow = { from: Date; to: Date };

export type SourceAdapter = {
  id: SourceId;
  /** Raw notices in the window, one array per API page. */
  pages(window: SyncWindow): AsyncIterable<unknown[]>;
  /** Keys for storing a raw notice, or null when the payload has no identity. Every stage is stored. */
  keys(raw: unknown): RawNoticeKeys | null;
  /** Throws on malformed payloads; returns null for notices that carry nothing for a tender. */
  normalize(raw: unknown): NormalizedNotice | null;
};
