import { z } from "zod";

// One notice from the TED search API, as requested with TED_FIELDS (SPEC 4.2).
// The API returns most fields as arrays, numbers as strings and texts as
// objects keyed by lowercase language code. Each field is reduced to one
// shape here. Identity fields are strict; everything else falls back to
// empty when malformed, so one odd field does not drop the whole notice.

const asText = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
};

/** Every string of a field that may hold one value or many. */
const many = z
  .unknown()
  .optional()
  .transform((v) => (Array.isArray(v) ? v : [v]).map(asText).filter((s): s is string => s !== null));

/** The first string of a field that may hold one value or many. */
const one = many.transform((values) => values[0] ?? null);

/** Texts by lowercase language code, e.g. { lav: ["Lot 1", "Lot 2"] }. */
const multilingual = z
  .unknown()
  .optional()
  .transform((v): Record<string, string[]> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const result: Record<string, string[]> = {};
    for (const [language, texts] of Object.entries(v)) {
      const list = (Array.isArray(texts) ? texts : [texts]).map(asText).filter((s): s is string => s !== null);
      if (list.length) result[language.toLowerCase()] = list;
    }
    return result;
  });

/** Yes/no values per lot; the API sends some as booleans and some as "true"/"false". */
const flags = z
  .unknown()
  .optional()
  .transform((v) =>
    (Array.isArray(v) ? v : [v]).flatMap((x) => (x === true || x === "true" ? [true] : x === false || x === "false" ? [false] : [])),
  );

export const tedNoticeSchema = z.object({
  "publication-number": z.string().trim().min(1),
  "publication-date": z.string().trim().min(1),
  "notice-identifier": one,
  "notice-version": one,
  "procedure-identifier": one,
  "change-notice-version-identifier": one,
  "change-reason-code": one,
  "notice-type": one,
  "form-type": one,
  "dispatch-date": one,
  "title-proc": multilingual,
  "description-proc": multilingual,
  "identifier-lot": many,
  "title-lot": multilingual,
  "description-lot": multilingual,
  "main-classification-proc": many,
  "additional-classification-proc": many,
  "main-classification-lot": many,
  "additional-classification-lot": many,
  "classification-cpv": many,
  "buyer-name": multilingual,
  "buyer-country": many,
  "buyer-country-sub": many,
  "place-of-performance-subdiv-proc": many,
  "place-of-performance-subdiv-lot": many,
  "estimated-value-proc": one,
  "estimated-value-cur-proc": one,
  "estimated-value-lot": many,
  "estimated-value-cur-lot": many,
  "deadline-receipt-tender-date-lot": many,
  "deadline-receipt-tender-time-lot": many,
  "deadline-receipt-request-date-lot": many,
  "deadline-receipt-request-time-lot": many,
  "deadline-receipt-answers-date-lot": many,
  "deadline-receipt-answers-time-lot": many,
  "procedure-type": one,
  "legal-basis": many,
  "contract-nature-main-proc": one,
  "official-language": many,
  "document-url-lot": many,
  "submission-url-lot": many,
  "duration-period-value-lot": many,
  "duration-period-unit-lot": many,
  "contract-duration-start-date-lot": many,
  "contract-duration-end-date-lot": many,
  "framework-agreement-lot": many,
  "electronic-ordering-lot": flags,
  "gpa-lot": flags,
  "award-criterion-type-lot": many,
  "award-criterion-name-lot": multilingual,
  "award-criterion-description-lot": multilingual,
  "award-criterion-number-lot": many,
  "award-criterion-number-weight-lot": many,
  "selection-criterion-lot": many,
  "selection-criterion-name-lot": multilingual,
  "selection-criterion-description-lot": multilingual,
  "guarantee-required-lot": flags,
  "term-performance-lot": multilingual,
  "submission-language": many,
});

export type TedNotice = z.infer<typeof tedNoticeSchema>;
