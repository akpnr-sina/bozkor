import type { Lot, Tender } from "@/db/schema";
import type { SourceId } from "@/sources/types";
import type { TriageNotice } from "./types";

/** Lot numbers in natural order: 1, 2, 10 rather than 1, 10, 2 (Find a Tender numbers lots 1, 2, ...). */
export const byLotNumber = (a: { lotNumber: string }, b: { lotNumber: string }): number =>
  a.lotNumber.localeCompare(b.lotNumber, undefined, { numeric: true });

/** The notice as triage reads it; the detail page uses the same to check quotes. */
export function toTriageNotice(tender: Tender, lotRows: readonly Lot[]): TriageNotice {
  return {
    source: tender.source as SourceId,
    title: tender.title,
    description: tender.description,
    buyerName: tender.buyerName,
    buyerCountry: tender.buyerCountry,
    cpvMain: tender.cpvMain,
    cpvAdditional: tender.cpvAdditional,
    valueAmount: tender.valueAmount,
    valueCurrency: tender.valueCurrency,
    valueEur: tender.valueEur,
    submissionDeadline: tender.submissionDeadline,
    procedureType: tender.procedureType,
    noticeLanguage: tender.noticeLanguage,
    lots: [...lotRows].sort(byLotNumber).map((l) => ({
      lotNumber: l.lotNumber,
      title: l.title,
      description: l.description,
      cpv: l.cpv,
      valueAmount: l.valueAmount,
      valueCurrency: l.valueCurrency,
      quantityText: l.quantityText,
    })),
    details: tender.details ?? null,
  };
}
