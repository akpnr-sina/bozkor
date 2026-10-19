import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchJson } from "../fetch";
import type { DocumentListing, JsonResult, ListedDocument } from "../types";
import { listTenderNedDocuments, tenderNedDocumentKey, tenderNedPublicationId } from "./tenderned";

// TNS answers recorded on 19 October 2026: a listing page
// (/publicaties?page=0&size=2), publication 443745 (a rectification, its
// procedure's latest) and the 22 documents TNS lists for it, three of them
// the notice's own PDFs (ANK).
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/documents/tenderned/${name}.json`, import.meta.url), "utf8"));

type TnsDocument = Record<string, unknown> & {
  documentId: string;
  publicatieCategorie: { code: string };
  typeDocument: { code: string };
  links?: { download: { href: string } };
};
const PUBLICATION = recorded("publicatie-443745") as Record<string, unknown>;
const DOCUMENTS = recorded("documenten-443745") as { documenten: TnsDocument[] };
const LISTING = recorded("publicaties") as { content: { publicatieId: string; link: { href: string } }[] };
/** What a listing keeps of them: all but the notice's own PDFs. */
const KEPT = DOCUMENTS.documenten.filter((d) => d.publicatieCategorie.code !== "ANK");

const SITE = "https://www.tenderned.nl";
const TNS = `${SITE}/papi/tenderned-rs-tns/v2`;
const publicationUrl = (id: string) => `${TNS}/publicaties/${id}`;
const documentsUrl = (id: string) => `${TNS}/publicaties/${id}/documenten`;
const downloadUrl = (d: TnsDocument) => `${SITE}${d.links!.download.href}`;

const json = (value: unknown): JsonResult => ({ kind: "json", value, finalUrl: "" });

/** TNS as fetchJson would answer it, from a table of addresses; records what was asked. */
function fakeTns(routes: Record<string, JsonResult>) {
  const asked: string[] = [];
  const getJson = async (url: string): Promise<JsonResult> => {
    asked.push(url);
    const answer = routes[url];
    if (!answer) throw new Error(`unexpected request ${url}`);
    return answer;
  };
  return { getJson, asked };
}

/** Publication 443745 with the given document list. */
const recordedTns = (documents: unknown = DOCUMENTS) => fakeTns({ [publicationUrl("443745")]: json(PUBLICATION), [documentsUrl("443745")]: json(documents) });

function documentsOf(listing: DocumentListing): ListedDocument[] {
  if (listing.kind !== "documents") throw new Error(`expected documents, got ${JSON.stringify(listing)}`);
  return listing.documents;
}

describe("tenderNedPublicationId", () => {
  it("reads the publication of a TED notice's link, and of TenderNed's own views of it", () => {
    expect(tenderNedPublicationId("https://www.tenderned.nl/aankondigingen/overzicht/443947")).toBe("443947");
    expect(tenderNedPublicationId("http://tenderned.nl/aankondigingen/overzicht/443947/documenten?tab=2#top")).toBe("443947");
    expect(tenderNedPublicationId("https://WWW.TENDERNED.NL./aankondigingen/overzicht/443947")).toBe("443947");
    expect(tenderNedPublicationId("https://www.tenderned.nl/aanbestedende-dienst/aankondigingen/443745?keepInformed=true")).toBe("443745");
    expect(tenderNedPublicationId("https://www.tenderned.nl/ondernemersplatform/aankondigingen/443745?addToTenders=true")).toBe("443745");
    // The listing links to its publications the same way.
    for (const item of LISTING.content) expect(tenderNedPublicationId(item.link.href)).toBe(item.publicatieId);
  });

  it("is null for any other link", () => {
    for (const url of [
      "https://www.tenderned.nl/aankondigingen/overzicht",
      "https://www.tenderned.nl/aankondigingen/overzicht/abc",
      "https://www.tenderned.nl/aankondigingen/overzicht/443947x",
      "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/443745",
      "https://www.tenderned.nl/cms/nl/contact",
      "https://tenderned.nl.example.com/aankondigingen/overzicht/443947",
      "https://www.nottenderned.nl/aankondigingen/overzicht/443947",
      "https://app.tenderned.nl/aankondigingen/overzicht/443947",
      "ftp://www.tenderned.nl/aankondigingen/overzicht/443947",
      "aankondigingen/overzicht/443947",
    ]) {
      expect(tenderNedPublicationId(url), url).toBeNull();
    }
  });
});

describe("tenderNedDocumentKey", () => {
  it("names a document by its download number, whichever publication lists it", () => {
    expect(tenderNedDocumentKey(`${TNS}/publicaties/443745/documenten/15004015/content`)).toBe("tenderned:15004015");
    expect(tenderNedDocumentKey(`${TNS}/publicaties/443947/documenten/15004015/content`)).toBe("tenderned:15004015");
    expect(tenderNedDocumentKey("http://TENDERNED.NL./papi/tenderned-rs-tns/v2/publicaties/443745/documenten/15004015/content")).toBe("tenderned:15004015");
    // The number is the download's, not the listing's documentId.
    const nota = DOCUMENTS.documenten[1]!;
    expect(nota.documentId).toBe("72f7afe9030ffc63ddec9068bde52103");
    expect(tenderNedDocumentKey(downloadUrl(nota))).toBe("tenderned:15004015");
    const keys = DOCUMENTS.documenten.map((d) => tenderNedDocumentKey(downloadUrl(d)));
    expect(keys.every((key) => /^tenderned:\d+$/.test(key ?? ""))).toBe(true);
    expect(new Set(keys).size).toBe(DOCUMENTS.documenten.length);
  });

  it("names a document listed without a download address by its documentId, apart from download numbers", async () => {
    const page = (publication: string, documentId: string) => `${SITE}/aankondigingen/overzicht/${publication}#document-${documentId}`;
    expect(tenderNedDocumentKey(page("443745", "72f7afe9030ffc63ddec9068bde52103"))).toBe("tenderned:document:72f7afe9030ffc63ddec9068bde52103");
    expect(tenderNedDocumentKey(page("443947", "72f7afe9030ffc63ddec9068bde52103"))).toBe("tenderned:document:72f7afe9030ffc63ddec9068bde52103");
    expect(tenderNedDocumentKey(page("443745", "g%20h%2Fi"))).toBe("tenderned:document:g h/i");

    // Every address a listing gives has its key, and no two the same.
    const answer = structuredClone(DOCUMENTS);
    delete answer.documenten[2]!.links;
    delete answer.documenten[3]!.links;
    const documents = documentsOf(await listTenderNedDocuments("443745", recordedTns(answer).getJson));
    const keys = documents.map((d) => tenderNedDocumentKey(d.url));
    expect(keys.slice(0, 3)).toEqual([
      "tenderned:15004015",
      `tenderned:document:${answer.documenten[2]!.documentId}`,
      `tenderned:document:${answer.documenten[3]!.documentId}`,
    ]);
    expect(keys.every((key) => key !== null)).toBe(true);
    expect(new Set(keys).size).toBe(documents.length);
  });

  it("is null for any other link", () => {
    for (const url of [
      `${SITE}/aankondigingen/overzicht/443745`,
      `${SITE}/aankondigingen/overzicht/443745#documenten`,
      `${SITE}/aankondigingen/overzicht/443745#document-`,
      `${SITE}/aankondigingen/overzicht/443745/documenten#document-72f7afe9`,
      `${SITE}/aankondigingen/overzicht/443745#document-%E0%A4%A`,
      `${TNS}/publicaties/443745/pdf`,
      `${TNS}/publicaties/443745/documenten/zip`,
      `${TNS}/publicaties/443745/documenten/15004015`,
      `${TNS}/publicaties/443745/documenten/%E0%A4%A/content`,
      "https://tenderned.nl.example.com/papi/tenderned-rs-tns/v2/publicaties/443745/documenten/15004015/content",
      "https://files.example.com/papi/tenderned-rs-tns/v2/publicaties/443745/documenten/15004015/content",
      "ftp://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties/443745/documenten/15004015/content",
      "not a url",
    ]) {
      expect(tenderNedDocumentKey(url), url).toBeNull();
    }
  });
});

describe("listTenderNedDocuments", () => {
  it("lists a publication's documents with their names, sizes and download addresses", async () => {
    const { getJson, asked } = recordedTns();
    const documents = documentsOf(await listTenderNedDocuments("443745", getJson));
    expect(documents).toHaveLength(19);
    expect(documents[0]).toEqual({
      url: `${TNS}/publicaties/443745/documenten/15004015/content`,
      name: "Nota van inlichtingen 2026-10-07-1.pdf",
      sizeBytes: 897597,
      skip: null,
    });
    // TNS writes some names with their type apart, and with double spaces.
    expect(documents[1]).toEqual({
      url: `${TNS}/publicaties/443745/documenten/15004004/content`,
      name: "Bijlage 9b.Prijzenblad Boorbuizen 2026-32 versie 1.0.xlsx",
      sizeBytes: 12487,
      skip: null,
    });
    expect(documents.find((d) => d.url.endsWith("/14737126/content"))?.name).toBe("Bijlage 10b Concept-Raamovereenkomst Perceel 2 Boorbuizen 2026-32 versie 1.0.docx");
    expect(documents.map((d) => d.name.split(".").at(-1))).toEqual(KEPT.map((d) => d.typeDocument.code));
    expect(documents.map((d) => d.url)).toEqual(KEPT.map(downloadUrl));
    expect(documents.every((d) => d.skip === null)).toBe(true);
    // 443745 is its procedure's latest rectification: there is nothing more to ask.
    expect(asked).toEqual([publicationUrl("443745"), documentsUrl("443745")]);
  });

  it("leaves out the notice's own PDFs, whose text comes from TED", async () => {
    const notices = DOCUMENTS.documenten.filter((d) => d.publicatieCategorie.code === "ANK");
    expect(notices.map((d) => d.links!.download.href.split("/").at(-2))).toEqual(["15013552", "14953463", "14737144"]);
    const urls = documentsOf(await listTenderNedDocuments("443745", recordedTns().getJson)).map((d) => d.url);
    expect(urls).toHaveLength(DOCUMENTS.documenten.length - 3);
    for (const notice of notices) expect(urls).not.toContain(downloadUrl(notice));
  });

  it("skips what the virus check flagged or TenderNed gives no address for, saying why, each at an address of its own", async () => {
    const answer = structuredClone(DOCUMENTS);
    const [nota, boorbuizen, masten] = [1, 2, 3].map((i) => answer.documenten[i]!);
    nota!.virusIndicatie = true;
    delete boorbuizen!.links;
    delete masten!.links;
    const documents = documentsOf(await listTenderNedDocuments("443745", recordedTns(answer).getJson));
    expect(documents[0]).toEqual({
      url: `${TNS}/publicaties/443745/documenten/15004015/content`,
      name: "Nota van inlichtingen 2026-10-07-1.pdf",
      sizeBytes: 897597,
      skip: "Virüs taramasında işaretli; indirilmedi.",
    });
    const noAddress = "TenderNed bu dosyanın indirme bağlantısını vermedi; indirilmedi.";
    expect(documents[1]).toEqual({
      url: `${SITE}/aankondigingen/overzicht/443745#document-${boorbuizen!.documentId}`,
      name: "Bijlage 9b.Prijzenblad Boorbuizen 2026-32 versie 1.0.xlsx",
      sizeBytes: 12487,
      skip: noAddress,
    });
    expect(documents[2]).toEqual({
      url: `${SITE}/aankondigingen/overzicht/443745#document-${masten!.documentId}`,
      name: "Bijlage 9a Prijzenblad Bovenleidingmasten 2026-32 versie 1.0.xlsx",
      sizeBytes: 14435,
      skip: noAddress,
    });
    expect(documents.filter((d) => d.skip)).toHaveLength(3);
    expect(new Set(documents.map((d) => d.url)).size).toBe(documents.length);
  });

  it("makes plain file names of what TNS lists", async () => {
    const base = KEPT.find((d) => d.typeDocument.code === "pdf" && d.publicatieCategorie.code === "DOC")!;
    let download = 900;
    const named = (documentId: string, documentNaam: string, more: Record<string, unknown> = {}) => ({
      ...base,
      documentId,
      documentNaam,
      // Each a download of its own: one download number is one document.
      links: { download: { href: `/papi/tenderned-rs-tns/v2/publicaties/443745/documenten/${download++}/content` } },
      ...more,
    });
    const answer = {
      documenten: [
        named("a", "Bestek.PDF"),
        named("b", "Tekening 1/2\tdeel\u0000 A"),
        named("c", "  "),
        named("d", "x".repeat(300)),
        named("e", "Bijlagen", { typeDocument: null, grootte: null }),
        named("f", "Model", { typeDocument: { code: "../exe" } }),
        named("g h/i", "Zonder categorie", { publicatieCategorie: null, links: null }),
      ],
    };
    const documents = documentsOf(await listTenderNedDocuments("443745", recordedTns(answer).getJson));
    expect(documents.map((d) => d.name)).toEqual([
      "Bestek.pdf",
      "Tekening 1-2 deel A.pdf",
      "c.pdf",
      `${"x".repeat(196)}.pdf`,
      "Bijlagen",
      "Model",
      "Zonder categorie.pdf",
    ]);
    expect(documents[4]!.sizeBytes).toBeNull();
    // Kept without a category; the address marks its document, written safely.
    expect(documents[6]!.url).toBe(`${SITE}/aankondigingen/overzicht/443745#document-g%20h%2Fi`);
  });

  // Publication 443947 of the same procedure, rectified by 443745 (made up from
  // the recorded answers): it lists two of 443745's documents, under its own
  // addresses as TNS does, and one that the rectification dropped.
  const original = { ...PUBLICATION, publicatieId: 443947, publicatieIDLaatsteRectificatie: 443745 };
  const originalDocuments = () => {
    const own = structuredClone(DOCUMENTS.documenten.slice(0, 3)).map((d) => ({
      ...d,
      links: { download: { href: d.links!.download.href.replace("/443745/", "/443947/") } },
    }));
    const dropped = { ...own[2]!, documentId: "ffff0000", documentNaam: "Bestek eerste versie", links: { download: { href: "/papi/tenderned-rs-tns/v2/publicaties/443947/documenten/99/content" } } };
    return { documenten: [...own, dropped] };
  };
  const rectifiedTns = () =>
    fakeTns({
      [publicationUrl("443947")]: json(original),
      [documentsUrl("443947")]: json(originalDocuments()),
      [publicationUrl("443745")]: json(PUBLICATION),
      [documentsUrl("443745")]: json(DOCUMENTS),
    });

  it("lists the latest rectification's documents first, then what only the publication itself lists, each once", async () => {
    const { getJson, asked } = rectifiedTns();
    const documents = documentsOf(await listTenderNedDocuments("443947", getJson));
    expect(asked).toEqual([publicationUrl("443947"), documentsUrl("443745"), documentsUrl("443947")]);
    // The documents both list come at the rectification's addresses; the notice PDFs stay out.
    expect(documents).toHaveLength(20);
    expect(documents.slice(0, 19).map((d) => d.url)).toEqual(KEPT.map(downloadUrl));
    expect(documents[19]).toEqual({
      url: `${TNS}/publicaties/443947/documenten/99/content`,
      name: "Bestek eerste versie.xlsx",
      sizeBytes: 12487,
      skip: null,
    });

    // Without a rectification, or written as a string, as listings write numbers.
    for (const latest of [null, "443947"]) {
      const tns = fakeTns({ [publicationUrl("443947")]: json({ ...original, publicatieIDLaatsteRectificatie: latest }), [documentsUrl("443947")]: json(DOCUMENTS) });
      expect(documentsOf(await listTenderNedDocuments("443947", tns.getJson))).toHaveLength(19);
      expect(tns.asked).toEqual([publicationUrl("443947"), documentsUrl("443947")]);
    }
  });

  it("lists a document once whether publications share its documentId or only its download number", async () => {
    // The original lists two of the rectification's documents under other
    // documentIds and the same download numbers, and one under its documentId
    // with another download number.
    const renamed = structuredClone(DOCUMENTS.documenten.slice(1, 3)).map((d) => ({
      ...d,
      documentId: `renamed-${d.documentId}`,
      links: { download: { href: d.links!.download.href.replace("/443745/", "/443947/") } },
    }));
    const renumbered = { ...structuredClone(DOCUMENTS.documenten[3]!), links: { download: { href: "/papi/tenderned-rs-tns/v2/publicaties/443947/documenten/77/content" } } };
    const { getJson } = fakeTns({
      [publicationUrl("443947")]: json(original),
      [documentsUrl("443745")]: json(DOCUMENTS),
      [documentsUrl("443947")]: json({ documenten: [...renamed, renumbered] }),
    });
    expect(documentsOf(await listTenderNedDocuments("443947", getJson)).map((d) => d.url)).toEqual(KEPT.map(downloadUrl));
  });

  it("gives a document the same address from the notice's link and the rectification's", async () => {
    const fromNotice = documentsOf(await listTenderNedDocuments("443947", rectifiedTns().getJson)).map((d) => d.url);
    const fromRectification = documentsOf(await listTenderNedDocuments("443745", rectifiedTns().getJson)).map((d) => d.url);
    expect(fromRectification).toHaveLength(19);
    expect(fromNotice.filter((url) => fromRectification.includes(url))).toEqual(fromRectification);
    expect(fromNotice.filter((url) => !fromRectification.includes(url))).toEqual([`${TNS}/publicaties/443947/documenten/99/content`]);
  });

  it("fails for good, saying what, when TNS answers in another shape", async () => {
    const document = KEPT[0]!;
    const list = (field: string) => `TenderNed doküman listesi beklenen biçimde değil (alan: ${field}); servis değişmiş olabilir.`;
    const cases: [unknown, unknown, string][] = [
      [PUBLICATION, { documenten: "geen" }, list("documenten")],
      [PUBLICATION, { documenten: [{ ...document, documentNaam: 7 }] }, list("documenten.0.documentNaam")],
      [PUBLICATION, { documenten: [{ ...document, publicatieCategorie: "ANK" }] }, list("documenten.0.publicatieCategorie")],
      [PUBLICATION, { documenten: [{ ...document, links: { download: { href: "http://[" } } }] }, list("documenten.0.links.download.href")],
      [{ ...PUBLICATION, publicatieId: "443745a" }, DOCUMENTS, "TenderNed yayın bilgisi beklenen biçimde değil (alan: publicatieId); servis değişmiş olabilir."],
      ["<html>Onderhoud</html>", DOCUMENTS, "TenderNed yayın bilgisi beklenen biçimde değil; servis değişmiş olabilir."],
    ];
    for (const [detail, documents, error] of cases) {
      const { getJson } = fakeTns({ [publicationUrl("443745")]: json(detail), [documentsUrl("443745")]: json(documents) });
      expect(await listTenderNedDocuments("443745", getJson)).toEqual({ kind: "failed", error, status: null, retryable: false, retryAfterMs: null });
    }
  });

  it("asks nothing for a publication number that is not one", async () => {
    const { getJson, asked } = fakeTns({});
    expect(await listTenderNedDocuments("44 37", getJson)).toMatchObject({ kind: "failed", retryable: false, error: 'Geçersiz TenderNed yayın numarası: "44 37".' });
    expect(asked).toEqual([]);
  });

  it("passes a blocked or failed request on as it came, asking nothing more", async () => {
    const blocked: JsonResult = { kind: "blocked", finalUrl: publicationUrl("443745"), reason: "robots_unavailable" };
    const first = fakeTns({ [publicationUrl("443745")]: blocked });
    expect(await listTenderNedDocuments("443745", first.getJson)).toEqual(blocked);
    expect(first.asked).toEqual([publicationUrl("443745")]);

    const busy: JsonResult = { kind: "failed", error: "Sunucu çok fazla istek geldiğini bildirdi (HTTP 429).", status: 429, retryable: true, retryAfterMs: 30_000 };
    const second = fakeTns({ [publicationUrl("443745")]: json(PUBLICATION), [documentsUrl("443745")]: busy });
    expect(await listTenderNedDocuments("443745", second.getJson)).toEqual(busy);

    // A list fails after another was read: nothing is listed in part.
    const third = fakeTns({ [publicationUrl("443947")]: json(original), [documentsUrl("443745")]: busy, [documentsUrl("443947")]: json(DOCUMENTS) });
    expect(await listTenderNedDocuments("443947", third.getJson)).toEqual(busy);
    expect(third.asked).toEqual([publicationUrl("443947"), documentsUrl("443745")]);
    const fourth = fakeTns({ [publicationUrl("443947")]: json(original), [documentsUrl("443745")]: json(DOCUMENTS), [documentsUrl("443947")]: busy });
    expect(await listTenderNedDocuments("443947", fourth.getJson)).toEqual(busy);
  });

  it("reads TNS through fetchJson, asking for JSON, the guard first", async () => {
    const bodies: Record<string, unknown> = { [publicationUrl("443745")]: PUBLICATION, [documentsUrl("443745")]: DOCUMENTS };
    const requests: { url: string; accept: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, accept: new Headers(init?.headers).get("accept") });
      if (!(url in bodies)) return new Response("Not Found", { status: 404 });
      return new Response(JSON.stringify(bodies[url]), { headers: { "Content-Type": "application/json;charset=UTF-8" } });
    };
    const asked: string[] = [];
    const guard = async (url: string) => {
      asked.push(url);
      return null;
    };
    expect(documentsOf(await listTenderNedDocuments("443745", (url) => fetchJson(url, { fetch, guard })))).toHaveLength(19);
    expect(requests).toEqual([
      { url: publicationUrl("443745"), accept: "application/json" },
      { url: documentsUrl("443745"), accept: "application/json" },
    ]);
    expect(asked).toEqual([publicationUrl("443745"), documentsUrl("443745")]);

    const closed = await listTenderNedDocuments("443745", (url) => fetchJson(url, { fetch, guard: async () => "robots_unavailable" }));
    expect(closed).toEqual({ kind: "blocked", finalUrl: publicationUrl("443745"), reason: "robots_unavailable" });
    expect(requests).toHaveLength(2);

    expect(await listTenderNedDocuments("999999", (url) => fetchJson(url, { fetch }))).toMatchObject({
      kind: "failed",
      error: "Kayıt bulunamadı (HTTP 404).",
      retryable: false,
    });
  });
});
