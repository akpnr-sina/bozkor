// What we ask the TED search API for (SPEC 4.2). The response carries these
// fields per notice; that object, minus the generated link lists, is the raw
// payload we store and normalize.

export const TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search";

/**
 * Competition and planning notices for supplies only. Services and works are
 * out of scope by the team's decision (14 October 2026); the API filters them
 * server side, so they are never fetched or stored.
 */
export const TED_BASE_QUERY = "form-type IN (competition planning) AND contract-nature-main-proc=supplies";

export const TED_FIELDS = [
  // Identity and grouping
  "publication-number",
  "notice-identifier",
  "notice-version",
  "procedure-identifier",
  "change-notice-version-identifier",
  "change-reason-code",
  "change-description",
  "notice-type",
  "form-type",
  "publication-date",
  "dispatch-date",
  // Content, in the notice's own language(s)
  "title-proc",
  "description-proc",
  "identifier-lot",
  "title-lot",
  "description-lot",
  "main-classification-proc",
  "additional-classification-proc",
  "main-classification-lot",
  "additional-classification-lot",
  "classification-cpv",
  // Buyer and place
  "buyer-name",
  "buyer-country",
  "buyer-country-sub",
  "place-of-performance-country-proc",
  "place-of-performance-subdiv-proc",
  "place-of-performance-country-lot",
  "place-of-performance-subdiv-lot",
  // Value
  "estimated-value-proc",
  "estimated-value-cur-proc",
  "estimated-value-lot",
  "estimated-value-cur-lot",
  // Deadlines: tenders (BT-131), requests to participate (BT-1311), questions (BT-13)
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-tender-time-lot",
  "deadline-receipt-request-date-lot",
  "deadline-receipt-request-time-lot",
  "deadline-receipt-answers-date-lot",
  "deadline-receipt-answers-time-lot",
  // Procedure
  "procedure-type",
  "legal-basis",
  "contract-nature-main-proc",
  "official-language",
  "document-url-lot",
  "submission-url-lot",
  // Contract details for the qualification policy (docs/qualification-policy-v1.md).
  // Duration as a period (BT-36) or as start and end dates (BT-536, BT-537).
  "duration-period-value-lot",
  "duration-period-unit-lot",
  "contract-duration-start-date-lot",
  "contract-duration-end-date-lot",
  "framework-agreement-lot",
  "electronic-ordering-lot",
  "gpa-lot",
  // Award criteria (BT-539, BT-734, BT-540); the number (BT-541) and how it weighs (BT-5421).
  "award-criterion-type-lot",
  "award-criterion-name-lot",
  "award-criterion-description-lot",
  "award-criterion-number-lot",
  "award-criterion-number-weight-lot",
  // Selection criteria (BT-747, BT-749, BT-750).
  "selection-criterion-lot",
  "selection-criterion-name-lot",
  "selection-criterion-description-lot",
  "guarantee-required-lot",
  "term-performance-lot",
  "submission-language",
] as const;

/** TED publication dates are days; the API takes them as YYYYMMDD. */
export function tedDateRange(fromDay: string, toDay: string): string {
  return `publication-date>=${fromDay.replaceAll("-", "")} AND publication-date<=${toDay.replaceAll("-", "")}`;
}
