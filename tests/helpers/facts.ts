import { factsOutputSchema, type FactsOutput, type LotFacts } from "@/analysis/facts-schema";
import type { NoticeDetails } from "@/sources/types";

// Builders for facts as the facts stage answers them, and for notice details.

export function lot(fields: Partial<LotFacts> & Pick<LotFacts, "productTr" | "category">): LotFacts {
  return {
    lotNumber: "",
    objectType: "GOODS",
    categoryQuote: "",
    productNature: "UNKNOWN",
    natureQuote: "",
    quantity: { text: "", kind: "UNKNOWN", quote: "" },
    ...fields,
  };
}

type Obligation = "installation" | "commissioningTraining" | "localService";
type FactsFields = Omit<Partial<FactsOutput>, Obligation> & Pick<FactsOutput, "lots"> & {
  [K in Obligation]?: Omit<FactsOutput[K], "lots"> & { lots?: string[] };
};

/**
 * Facts with everything unknown except what is given; checked against the
 * model's schema. Obligations without `lots` apply to the whole tender.
 */
export function facts(fields: FactsFields): FactsOutput {
  const obligation = <K extends Obligation>(key: K) => (fields[key] ? { lots: [], ...fields[key] } : undefined);
  return factsOutputSchema.parse({
    summaryTr: "",
    installation: { value: "UNKNOWN", detail: "", quote: "", lots: [] },
    commissioningTraining: { value: "UNKNOWN", detail: "", quote: "", lots: [] },
    localService: { value: "UNKNOWN", detail: "", quote: "", lots: [] },
    warranty: { years: null, detail: "", quote: "" },
    deliveryPattern: { value: "UNKNOWN", detail: "", quote: "" },
    deliveryPoints: { value: "UNKNOWN", detail: "", quote: "" },
    contractDuration: { months: null, quote: "" },
    framework: { value: "UNKNOWN", quote: "" },
    brand: { value: "UNKNOWN", detail: "", quote: "" },
    certifications: [],
    pastPerformance: { value: "UNKNOWN", detail: "", quote: "" },
    turnover: { value: "UNKNOWN", detail: "", quote: "" },
    samples: { value: "UNKNOWN", quote: "" },
    siteVisit: { value: "UNKNOWN", quote: "" },
    restrictedProduct: { value: "UNKNOWN", detail: "", quote: "" },
    awardCriteria: { value: "UNKNOWN", detail: "", quote: "" },
    documentsToCheck: [],
    ...fields,
    ...(fields.installation ? { installation: obligation("installation") } : {}),
    ...(fields.commissioningTraining ? { commissioningTraining: obligation("commissioningTraining") } : {}),
    ...(fields.localService ? { localService: obligation("localService") } : {}),
  });
}

export function details(fields: Partial<NoticeDetails>): NoticeDetails {
  return {
    durationMonths: null,
    framework: null,
    electronicOrdering: null,
    gpaCovered: null,
    awardCriteria: [],
    selectionCriteria: [],
    guaranteeRequired: null,
    performanceTerms: null,
    submissionLanguages: [],
    ...fields,
  };
}
