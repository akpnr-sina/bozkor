import { z } from "zod";

// Subset of the Find a Tender OCDS release that the normalizer reads.
// Identity fields are strict; everything else falls back to null when
// malformed, so one odd field does not drop the whole notice.

const str = z.string().nullish().catch(null);
const bool = z.boolean().nullish().catch(null);
const num = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
    z.number().finite().nullish(),
  )
  .catch(null);
const list = <T extends z.ZodType>(item: T) => z.array(item).nullish().catch(null);

const classification = z.object({ scheme: str, id: str });

const value = z.object({ amount: num, amountGross: num, currency: str });

const address = z.object({ country: str, countryName: str, region: str });

const document = z.object({
  id: str,
  documentType: str,
  noticeType: str,
  title: str,
  description: str,
  url: str,
});

const period = z.object({ endDate: str });

// Contract details for the qualification policy (OCDS lots, award and
// selection criteria, techniques, coveredBy, submission and contract terms).
const contractPeriod = z.object({ startDate: str, endDate: str, durationInDays: num }).nullish().catch(null);

const awardCriteria = z
  .object({
    weightingDescription: str,
    criteria: list(
      z.object({ type: str, name: str, description: str, numbers: list(z.object({ number: num, weight: str })) }),
    ),
  })
  .nullish()
  .catch(null);

const selectionCriteria = z
  .object({ criteria: list(z.object({ type: str, description: str })) })
  .nullish()
  .catch(null);

const item = z.object({
  id: str,
  relatedLot: str,
  classification: classification.nullish().catch(null),
  additionalClassifications: list(classification),
  deliveryAddresses: list(address),
  quantity: num,
  unit: z.object({ name: str }).nullish().catch(null),
});

const lot = z.object({
  id: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim() || null)
    .nullish()
    .catch(null),
  title: str,
  description: str,
  status: str,
  value: value.nullish().catch(null),
  contractPeriod,
  awardCriteria,
  selectionCriteria,
});

const tender = z.object({
  id: str,
  title: str,
  description: str,
  status: str,
  legalBasis: z.object({ scheme: str, id: str }).nullish().catch(null),
  specialRegime: list(z.string()),
  aboveThreshold: bool,
  classification: classification.nullish().catch(null),
  items: list(item),
  lots: list(lot),
  value: value.nullish().catch(null),
  procurementMethod: str,
  procurementMethodDetails: str,
  mainProcurementCategory: str,
  submissionMethodDetails: str,
  tenderPeriod: period.nullish().catch(null),
  enquiryPeriod: period.nullish().catch(null),
  expressionOfInterestDeadline: str,
  documents: list(document),
  /** Only presence matters: an update that lists amendments but no status is partial. */
  amendments: list(z.unknown()),
  contractPeriod,
  techniques: z.object({ hasFrameworkAgreement: bool }).nullish().catch(null),
  coveredBy: list(z.string()),
  submissionTerms: z.object({ languages: list(z.string()) }).nullish().catch(null),
  contractTerms: z.object({ performanceTerms: str, hasElectronicOrdering: bool }).nullish().catch(null),
  selectionCriteria,
  otherRequirements: z.object({ requiresStaffNamesAndQualifications: bool }).nullish().catch(null),
});

const party = z.object({
  id: str,
  name: str,
  roles: list(z.string()),
  address: address.nullish().catch(null),
});

export const fatReleaseSchema = z.object({
  id: z.string().min(1),
  ocid: z.string().min(1),
  date: z.string().min(1),
  tag: z.array(z.string()),
  language: str,
  buyer: z.object({ id: str, name: str }).nullish().catch(null),
  parties: list(party),
  planning: z
    .object({
      documents: list(document),
      milestones: list(z.object({ description: str })),
    })
    .nullish()
    .catch(null),
  tender: tender.nullish().catch(null),
});

export type FatRelease = z.infer<typeof fatReleaseSchema>;

export const fatPackageSchema = z.object({
  releases: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).nullish(),
});
