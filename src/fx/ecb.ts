import { z } from "zod";
import { fetchText, USER_AGENT, type RetryOptions } from "@/sources/http";

/** Rates of the latest ECB working day; a new day appears around 16:00 CET. */
export const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
/** Rates of the last 90 calendar days (about 64 working days). */
export const ECB_HIST_90D_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

/** One ECB euro reference rate: 1 EUR buys `ratePerEur` units of `currency` on `date`. */
export type EcbRate = { date: string; currency: string; ratePerEur: number };

const rateSchema = z.object({
  date: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/, "expected an ISO 4217 code"),
  ratePerEur: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/, "expected a decimal number")
    .transform(Number)
    .pipe(z.number().positive()),
});

// The daily file quotes attributes with ' and the history files with ",
// so both are accepted.
const CUBE_TAG = /<Cube\b([^>]*)>/g;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENVELOPE_OPEN = /<(?:\w+:)?Envelope\b/;
const ENVELOPE_CLOSE = /<\/(?:\w+:)?Envelope>$/;

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [, name, doubleQuoted, singleQuoted] of source.matchAll(ATTRIBUTE)) {
    if (name) result[name] = doubleQuoted ?? singleQuoted ?? "";
  }
  return result;
}

const snippet = (text: string) => text.replace(/\s+/g, " ").slice(0, 120);

/**
 * Parses a eurofxref XML file (daily or history):
 * `<Cube time="..."><Cube currency="USD" rate="1.0812"/>...</Cube>`.
 * Throws on an empty, cut-off or unexpected document, so an error page that
 * came back with status 200 is never read as "no rates".
 */
export function parseEcbXml(xml: string): EcbRate[] {
  const text = xml.trim();
  if (!text) throw new Error("ECB response is empty");
  if (!ENVELOPE_OPEN.test(text) || !ENVELOPE_CLOSE.test(text)) {
    throw new Error(`ECB response is not a complete eurofxref document: ${snippet(text)}`);
  }

  const rows: Record<string, string>[] = [];
  let date: string | undefined;
  for (const [, source = ""] of text.matchAll(CUBE_TAG)) {
    const attrs = attributes(source);
    if (attrs.time !== undefined) {
      date = attrs.time;
    } else if (attrs.currency !== undefined || attrs.rate !== undefined) {
      if (date === undefined) throw new Error(`ECB response has a rate outside a dated Cube: <Cube${source}>`);
      rows.push({ date, currency: attrs.currency ?? "", ratePerEur: attrs.rate ?? "" });
    }
  }
  if (!rows.length) throw new Error(`ECB response contains no rates: ${snippet(text)}`);

  return rows.map((row) => {
    const parsed = rateSchema.safeParse(row);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ");
      throw new Error(`ECB response has an invalid rate ${JSON.stringify(row)}: ${issues}`);
    }
    return parsed.data;
  });
}

/** Downloads and parses one eurofxref file with the shared timeout, 429 and backoff handling. */
export async function fetchEcbRates(url: string, options: RetryOptions = {}): Promise<EcbRate[]> {
  const xml = await fetchText(
    url,
    { headers: { Accept: "application/xml, text/xml", "User-Agent": USER_AGENT } },
    options,
  );
  try {
    return parseEcbXml(xml);
  } catch (error) {
    throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
