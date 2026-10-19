import { z } from "zod";
import type { DocumentListing, JsonResult, ListedDocument } from "../types";

// TenderNed (NL) lists a notice's documents in its TNS web service: keyless
// JSON, named as an access route on TenderNed's open data page
// (data.overheid.nl; notices under CC0 1.0). The service has no published
// schema, and "deze Webservice [kan] zonder voorafgaande kennisgeving
// gewijzigd worden": every answer is checked, and one of another shape fails
// with a message instead of listing nothing. Read on 19 October 2026; see
// SPEC 4.4.

const SITE = "https://www.tenderned.nl";
const TNS = `${SITE}/papi/tenderned-rs-tns/v2`;

/**
 * A publication's pages: the public one, which TED notices link to (BT-15),
 * and the buyer's and the supplier's views TenderNed itself links to.
 */
const PUBLICATION_PATH =
  /^\/(?:aankondigingen\/overzicht|aanbestedende-dienst\/aankondigingen|ondernemersplatform\/aankondigingen)\/(\d{1,12})(?:\/|$)/i;

/** The TenderNed publication a notice's link is to, or null for any other link. */
export function tenderNedPublicationId(url: string): string | null {
  const parsed = tenderNedUrl(url);
  return (parsed && PUBLICATION_PATH.exec(parsed.pathname)?.[1]) ?? null;
}

/** A TNS download: /publicaties/{publication}/documenten/{download number}/content. */
const DOWNLOAD_PATH = /^\/papi\/tenderned-rs-tns\/v2\/publicaties\/\d{1,12}\/documenten\/([^/]+)\/content$/;
/** The publication's page, where a document without a download address is listed (see listed()). */
const DOCUMENT_PAGE = /^\/aankondigingen\/overzicht\/\d{1,12}$/;

/**
 * What names a listed document whichever publication of its procedure lists
 * it, to tell a document already taken from a new one. TNS lists a document
 * under each publication's path with the same download number (seen on
 * 19 October 2026 for publications 443706 and 444310). That number is not
 * the listing's documentId, a hexadecimal one of its own, which names a
 * document listed without a download address (#document-{documentId}). The
 * two never match: such a document was never downloaded, and is to be once
 * it has an address. Null for any other link.
 */
export function tenderNedDocumentKey(url: string): string | null {
  const parsed = tenderNedUrl(url);
  if (!parsed) return null;
  const download = DOWNLOAD_PATH.exec(parsed.pathname)?.[1];
  if (download) return documentKey("", download);
  const documentId = /^#document-(.+)$/.exec(parsed.hash)?.[1];
  return documentId && DOCUMENT_PAGE.test(parsed.pathname) ? documentKey("document:", documentId) : null;
}

function documentKey(kind: string, encoded: string): string | null {
  try {
    return `tenderned:${kind}${decodeURIComponent(encoded)}`;
  } catch {
    return null;
  }
}

/** The address, parsed, when it is TenderNed's. */
function tenderNedUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.replace(/\.$/, "");
  return host === "tenderned.nl" || host === "www.tenderned.nl" ? parsed : null;
}

/** A publication number: a number in a publication, a string in a listing. */
const publicationNumber = z.union([z.number().int().positive(), z.string().regex(/^\d{1,12}$/)]).transform(String);

const publication = z.object({
  publicatieId: publicationNumber,
  /** The procedure's latest rectification: another publication, or this one when it is that rectification. */
  publicatieIDLaatsteRectificatie: publicationNumber.nullish(),
});

const isWebAddress = (href: string) => {
  try {
    const { protocol } = new URL(href, SITE);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const tnsDocument = z.object({
  documentId: z.string().min(1),
  documentNaam: z.string(),
  /** ANK (aankondiging, the notice), NVI (nota van inlichtingen), DOC. */
  publicatieCategorie: z.object({ code: z.string() }).nullish(),
  typeDocument: z.object({ code: z.string() }).nullish(),
  grootte: z.number().int().nonnegative().nullish(),
  virusIndicatie: z.boolean().nullish(),
  links: z.object({ download: z.object({ href: z.string().refine(isWebAddress) }).nullish() }).nullish(),
});

const documentList = z.object({ documenten: z.array(tnsDocument) });

const VIRUS = "Virüs taramasında işaretli; indirilmedi.";
const NO_DOWNLOAD = "TenderNed bu dosyanın indirme bağlantısını vermedi; indirilmedi.";

/**
 * The documents TenderNed lists for a publication: those of the procedure's
 * latest rectification first, when that is another publication (a
 * rectification may add documents), then the publication's own that it does
 * not list. Each document once (by its documentId or its download number),
 * in the order TNS lists them, without the notice's own PDFs. A blocked or failed request is passed on as it came, and
 * nothing more is asked; an answer of another shape fails for good. `getJson`
 * is fetchJson with the run's guard and pacing.
 */
export async function listTenderNedDocuments(publicationId: string, getJson: (url: string) => Promise<JsonResult>): Promise<DocumentListing> {
  if (!/^\d{1,12}$/.test(publicationId)) return failure(`Geçersiz TenderNed yayın numarası: "${publicationId.slice(0, 40)}".`);
  const detail = await read(getJson, `${TNS}/publicaties/${publicationId}`, publication, "yayın bilgisi");
  if (detail.kind !== "read") return detail.result;
  // The latest rectification first. A tender's notice and its rectifications
  // each link to TenderNed, and every link must give a document they share
  // the same address: the latest rectification's. What only an older
  // publication lists keeps that one's address.
  const latest = detail.value.publicatieIDLaatsteRectificatie;
  const publications = latest && latest !== publicationId ? [latest, publicationId] : [publicationId];

  const documents: ListedDocument[] = [];
  const seen = new Set<string>();
  for (const id of publications) {
    const list = await read(getJson, `${TNS}/publicaties/${id}/documenten`, documentList, "doküman listesi");
    if (list.kind !== "read") return list.result;
    for (const document of list.value.documenten) {
      // The notice itself, a PDF of each of its versions: its text comes from TED.
      if (document.publicatieCategorie?.code === "ANK") continue;
      const entry = listed(document, id);
      // Once, whether another publication lists it with the same documentId or the same download number.
      const names = [`id:${document.documentId}`, tenderNedDocumentKey(entry.url)].filter((name) => name !== null);
      const known = names.some((name) => seen.has(name));
      for (const name of names) seen.add(name);
      if (!known) documents.push(entry);
    }
  }
  return { kind: "documents", documents };
}

type Stopped = Exclude<DocumentListing, { kind: "documents" }>;

const failure = (error: string): Stopped => ({ kind: "failed", error, status: null, retryable: false, retryAfterMs: null });

/** One TNS answer, checked against what it should look like. */
async function read<S extends z.ZodType>(
  getJson: (url: string) => Promise<JsonResult>,
  url: string,
  schema: S,
  what: string,
): Promise<{ kind: "read"; value: z.output<S> } | { kind: "stopped"; result: Stopped }> {
  const answer = await getJson(url);
  if (answer.kind !== "json") return { kind: "stopped", result: answer };
  const parsed = schema.safeParse(answer.value);
  if (parsed.success) return { kind: "read", value: parsed.data };
  const field = parsed.error.issues[0]?.path.map(String).join(".");
  return { kind: "stopped", result: failure(`TenderNed ${what} beklenen biçimde değil${field ? ` (alan: ${field})` : ""}; servis değişmiş olabilir.`) };
}

function listed(document: z.output<typeof tnsDocument>, publicationId: string): ListedDocument {
  const href = document.links?.download?.href;
  return {
    // Without an address of its own, the publication's page, where the team can
    // look for it; marked with the document, so each such address is its own.
    url: href ? new URL(href, SITE).href : `${SITE}/aankondigingen/overzicht/${publicationId}#document-${encodeURIComponent(document.documentId)}`,
    name: fileName(document.documentNaam, document.typeDocument?.code, document.documentId),
    sizeBytes: document.grootte ?? null,
    skip: document.virusIndicatie ? VIRUS : href ? null : NO_DOWNLOAD,
  };
}

/**
 * The listed name as a file name: with its type's extension, which TNS often
 * leaves out or writes apart ("Prijzenblad versie 1.0 xlsx"), without folders
 * or control characters, at most 200 characters.
 */
function fileName(name: string, type: string | null | undefined, documentId: string): string {
  const extension = type && /^[a-z0-9]{1,10}$/i.test(type) ? type.toLowerCase() : null;
  let base = name
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\\/]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (extension) base = base.replace(new RegExp(`(?:\\.|\\s)${extension}$`, "i"), "").trim();
  base ||= documentId;
  if (!extension) return base.slice(0, 200);
  return `${base.slice(0, 200 - extension.length - 1)}.${extension}`;
}
