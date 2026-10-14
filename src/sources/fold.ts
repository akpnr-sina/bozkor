import type { NoticeCategory, NormalizedDocument, NormalizedLot, NormalizedNotice } from "./types";

export type FoldedTender = Omit<NormalizedNotice, "lots" | "regime" | "status" | "title" | "noticeType"> & {
  noticeType: NoticeCategory;
  regime: NonNullable<NormalizedNotice["regime"]>;
  status: NonNullable<NormalizedNotice["status"]>;
  title: string;
  lots: NonNullable<NormalizedNotice["lots"]>;
  noticeCount: number;
};

type Nullable<T> = { [K in keyof T]: null extends T[K] ? K : never }[keyof T];

/**
 * The latest notice with lots decides which lots exist; fields it leaves
 * empty come from earlier notices of the same lot.
 */
function foldLots(sorted: readonly NormalizedNotice[]): NormalizedLot[] {
  const latestIndex = sorted.findLastIndex((n) => n.lots !== null && n.lots.length > 0);
  const latestLots = sorted[latestIndex]?.lots;
  if (!latestLots) return [];
  return latestLots.map((lot) => {
    const merged = { ...lot };
    for (let i = latestIndex - 1; i >= 0; i--) {
      const earlier = sorted[i]?.lots?.find((l) => l.lotNumber === lot.lotNumber);
      if (!earlier) continue;
      merged.title ??= earlier.title;
      merged.description ??= earlier.description;
      merged.quantityText ??= earlier.quantityText;
      if (!merged.cpv.length) merged.cpv = earlier.cpv;
      if (merged.valueAmount === null && earlier.valueAmount !== null) {
        merged.valueAmount = earlier.valueAmount;
        merged.valueCurrency = earlier.valueCurrency;
      }
    }
    return merged;
  });
}

/**
 * Merges every notice of one procedure into the current tender state.
 * Order-independent: notices are sorted by publication time, and for each
 * field the latest notice that states it wins. Tender CPVs come as a set
 * from the latest notice that has them, so a correction can remove codes.
 * Document links accumulate across notices.
 *
 * Identity (external id, notice link, published date) comes from planning and
 * tender notices only. Award and contract notices keep arriving for years
 * after an award; they update the status but do not count as a change.
 */
export function foldNotices(notices: readonly NormalizedNotice[]): FoldedTender {
  const sorted = [...notices].sort(
    (a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.externalId.localeCompare(b.externalId),
  );
  const opportunity = sorted.filter((n) => n.noticeType !== "award");
  const latest = opportunity.at(-1);
  if (!latest) throw new Error("foldNotices needs at least one planning or tender notice");

  const latestValue = <K extends Nullable<NormalizedNotice>>(key: K): NormalizedNotice[K] | null => {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const value = sorted[i]?.[key];
      if (value !== null && value !== undefined) return value;
    }
    return null;
  };

  const withCpv = sorted.findLast((n) => n.cpvMain !== null || n.cpvAdditional.length > 0);
  // TED has no change notice that revokes a cancellation, so a later
  // correction of the cancelled notice must not reopen the tender.
  const tedCancelled = sorted.some((n) => n.source === "eu_ted" && n.status === "cancelled");
  // The value and its currency must come from the same notice.
  const withValue = sorted.findLast((n) => n.valueAmount !== null);
  const firstTenderNotice = opportunity.find((n) => n.noticeType === "tender");

  const documents = new Map<string, NormalizedDocument>();
  for (const notice of sorted) {
    for (const doc of notice.documents) documents.set(doc.url, doc);
  }

  return {
    source: latest.source,
    procedureKey: latest.procedureKey,
    externalId: latest.externalId,
    noticeCount: sorted.length,
    // A planning record becomes a tender once a call for competition is published.
    noticeType: firstTenderNotice ? "tender" : "planning",
    noticeCode: latestValue("noticeCode"),
    publishedAt: (firstTenderNotice ?? opportunity[0] ?? latest).publishedAt,
    regime: latestValue("regime") ?? "unknown",
    contractNature: latestValue("contractNature"),
    status: tedCancelled ? "cancelled" : (latestValue("status") ?? "open"),
    title: latestValue("title") ?? latest.externalId,
    description: latestValue("description"),
    buyerName: latestValue("buyerName"),
    buyerCountry: latestValue("buyerCountry"),
    nutsCode: latestValue("nutsCode"),
    cpvMain: withCpv?.cpvMain ?? null,
    cpvAdditional: withCpv?.cpvAdditional ?? [],
    valueAmount: withValue?.valueAmount ?? null,
    valueCurrency: withValue?.valueCurrency ?? null,
    submissionDeadline: latestValue("submissionDeadline"),
    clarificationDeadline: latestValue("clarificationDeadline"),
    procedureType: latestValue("procedureType"),
    noticeLanguage: latestValue("noticeLanguage"),
    noticeUrl: latestValue("noticeUrl"),
    documentsPortalUrl: latestValue("documentsPortalUrl"),
    lots: foldLots(sorted),
    documents: [...documents.values()],
  };
}
