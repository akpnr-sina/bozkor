import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertAssessment, insertDecision, insertDocument, insertMatch, insertProfile, insertTender } from "../../tests/helpers/tenders";
import { documents, hostRests } from "@/db/schema";
import { fetchDocuments, isResting, pendingFetches, type RobotsVerdict, sha256Of, withKindExtension } from "./fetch-job";
import type { DocumentListing, FetchGuard, FetchResult, JsonResult } from "./types";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});
afterAll(async () => {
  await testDb.close();
});

const PDF = new TextEncoder().encode("%PDF-1.7\n%%EOF\n");
const HOUR = 60 * 60 * 1000;

const file = (url: string, filename: string | null = null, bytes = PDF): FetchResult => ({
  kind: "file",
  fileKind: "pdf",
  bytes,
  mime: "application/pdf",
  filename,
  finalUrl: url,
});
const failure = (status: number | null, retryable: boolean, retryAfterMs: number | null = null): FetchResult => ({
  kind: "failed",
  error: status ? `Sunucu hatası (HTTP ${status}).` : "Zaman aşımı.",
  status,
  retryable,
  retryAfterMs,
});

/**
 * Answers from a table of URLs and records the order of requests. `pages`
 * gives the document links each page lists; `disallowed` the URL prefixes
 * robots.txt closes, `unavailable` those whose robots.txt cannot be read.
 */
function fakeLinks(
  answers: Record<string, FetchResult | (() => FetchResult)>,
  options: { pages?: Record<string, { url: string; text: string | null }[]>; disallowed?: string[]; unavailable?: string[] } = {},
) {
  const requested: string[] = [];
  /** As fetchDocument: the guard first, then the request (no redirects here). */
  const fetchDocument = async (url: string, { guard, maxBytes }: { guard: FetchGuard; maxBytes: number }): Promise<FetchResult> => {
    const reason = await guard(url);
    if (reason) return { kind: "blocked", finalUrl: url, reason };
    requested.push(url);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected request ${url}`);
    const result = typeof answer === "function" ? answer() : answer;
    return result.kind === "file" && result.bytes.length > maxBytes ? { kind: "too_large", sizeBytes: result.bytes.length, finalUrl: url } : result;
  };
  return {
    fetchDocument,
    requested,
    wait: async () => {},
    robots: async (url: string): Promise<RobotsVerdict> =>
      (options.unavailable ?? []).some((prefix) => url.startsWith(prefix))
        ? "unavailable"
        : (options.disallowed ?? []).some((prefix) => url.startsWith(prefix))
          ? "disallowed"
          : "allowed",
    extractLinks: (_html: string, pageUrl: string) => options.pages?.[pageUrl] ?? [],
  };
}

const page = (url: string, login = false): FetchResult => ({ kind: "page", finalUrl: url, login, html: "<html></html>" });

/** A tender a current match of an active profile shows the team. */
async function matchedTender(fields: Parameters<typeof insertTender>[1] = {}) {
  const tenderId = await insertTender(testDb.db, fields);
  await insertMatch(testDb.db, await insertProfile(testDb.db), tenderId);
  return tenderId;
}

/** Links get created_at a second apart: the clock alone can give two inserts the same time, and the order would be random. */
let linksMade = 0;
const link = (tenderId: string, sourceUrl: string) =>
  insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl, createdAt: new Date(Date.now() - 3_600_000 + linksMade++ * 1_000) });

async function documentOf(id: string) {
  const [row] = await testDb.db.select().from(documents).where(eq(documents.id, id));
  return row!;
}

describe("fetchDocuments", () => {
  it("stores files and marks portal pages, other file types and large files", async () => {
    const tenderId = await matchedTender();
    const spec = await link(tenderId, "https://buyer.example/docs/spec.pdf");
    const aspx = await link(tenderId, "https://buyer.example/NoticeBuilder_FileDownload.aspx?id=7");
    const portal = await link(tenderId, "https://portal.example/tender/42");
    const drawing = await link(tenderId, "https://buyer.example/drawing.dwg");
    const huge = await link(tenderId, "https://buyer.example/all.zip");
    const links = fakeLinks({
      "https://buyer.example/docs/spec.pdf": file("https://buyer.example/docs/spec.pdf", "Technical Specification.pdf"),
      "https://buyer.example/NoticeBuilder_FileDownload.aspx?id=7": file(
        "https://buyer.example/NoticeBuilder_FileDownload.aspx?id=7",
        null,
        new TextEncoder().encode("%PDF-1.4 another"),
      ),
      "https://portal.example/tender/42": { kind: "page", finalUrl: "https://portal.example/login", login: true, html: "<form><input type=password></form>" },
      "https://buyer.example/drawing.dwg": { kind: "unsupported", mime: "image/vnd.dwg", filename: "drawing.dwg", finalUrl: "https://buyer.example/drawing.dwg" },
      "https://buyer.example/all.zip": { kind: "too_large", sizeBytes: 90_000_000, finalUrl: "https://buyer.example/all.zip" },
    });
    const { storage, files } = memoryStorage();

    const stats = await fetchDocuments(testDb.db, { ...links, storage });

    expect(stats).toMatchObject({ attempted: 5, fetched: 2, manual: 1, unsupported: 1, failed: 1, retry: 0, stoppedBy: null });
    const stored = await documentOf(spec);
    expect(stored).toMatchObject({
      fetchStatus: "fetched",
      filename: "Technical Specification.pdf",
      mime: "application/pdf",
      sizeBytes: PDF.length,
      sha256: sha256Of(PDF),
      storagePath: `${tenderId}/${sha256Of(PDF)}.pdf`,
      processedAt: null,
      fetchError: null,
    });
    expect(files.get(stored.storagePath!)).toEqual(PDF);
    // A name from the URL gets the extension of what the file is.
    expect((await documentOf(aspx)).filename).toBe("NoticeBuilder_FileDownload.pdf");
    expect(await documentOf(portal)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal girişi istiyor.", storagePath: null });
    expect(await documentOf(drawing)).toMatchObject({ fetchStatus: "unsupported", fetchError: "Okunmayan dosya türü (image/vnd.dwg)." });
    expect(await documentOf(huge)).toMatchObject({ fetchStatus: "failed", fetchError: "Dosya 50 MB sınırından büyük; portaldan indirilmeli." });

    // Nothing is fetched twice.
    expect((await fetchDocuments(testDb.db, { ...links, storage })).attempted).toBe(0);
  });

  it("fetches links only of open tenders the team may bid on, nearest deadline first", async () => {
    // NO_GO as the latest decision ends fetching even while a profile still matches.
    const db = testDb.db;
    const day = 24 * HOUR;
    const urls: Record<string, string> = {};
    async function tender(name: string, deadlineDays: number, setup: (tenderId: string) => Promise<void>) {
      const tenderId = await insertTender(db, { submissionDeadline: new Date(Date.now() + deadlineDays * day) });
      await setup(tenderId);
      urls[name] = `https://buyer.example/${name}.pdf`;
      await link(tenderId, urls[name]);
    }
    const active = await insertProfile(db);
    const paused = await insertProfile(db, false);
    await tender("needs-documents", 20, async (id) => {
      await insertMatch(db, active, id);
      await insertAssessment(db, id, "NEEDS_DOCUMENTS");
    });
    await tender("not-assessed-yet", 10, (id) => insertMatch(db, active, id));
    await tender("no-bid", 5, async (id) => {
      await insertMatch(db, active, id);
      await insertAssessment(db, id, "NO_BID");
    });
    await tender("watch-verdict", 5, async (id) => {
      await insertMatch(db, active, id);
      await insertAssessment(db, id, "WATCH");
    });
    await tender("rejected-but-review", 30, async (id) => {
      await insertMatch(db, active, id);
      await insertAssessment(db, id, "HARD_REJECT");
      await insertDecision(db, id, "REVIEW");
    });
    await tender("go-without-match", 15, (id) => insertDecision(db, id, "GO"));
    await tender("go-then-no-go", 5, async (id) => {
      await insertDecision(db, id, "GO", new Date(Date.now() - day));
      await insertDecision(db, id, "NO_GO");
    });
    await tender("paused-profile", 5, (id) => insertMatch(db, paused, id));
    await tender("unmatched", 5, (id) => insertMatch(db, active, id, { unmatchedAt: new Date() }));
    await tender("deadline-passed", -1, (id) => insertMatch(db, active, id));
    await tender("matched-no-go", 5, async (id) => {
      await insertMatch(db, active, id);
      await insertDecision(db, id, "NO_GO");
    });
    const links = fakeLinks(Object.fromEntries(Object.values(urls).map((url) => [url, file(url)])));

    await fetchDocuments(db, { ...links, storage: memoryStorage().storage });

    expect(links.requested).toEqual([urls["not-assessed-yet"], urls["go-without-match"], urls["needs-documents"], urls["rejected-but-review"]]);
  });

  it("tries failures worth retrying again hours later, then gives up", async () => {
    const tenderId = await matchedTender();
    const flaky = await link(tenderId, "https://slow.example/spec.pdf");
    const missing = await link(tenderId, "https://buyer.example/gone.pdf");
    const links = fakeLinks({ "https://slow.example/spec.pdf": failure(null, true), "https://buyer.example/gone.pdf": failure(404, false) });
    const deps = { ...links, storage: memoryStorage().storage };
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, flaky));

    expect(await fetchDocuments(testDb.db, deps)).toMatchObject({ attempted: 2, retry: 1, failed: 1 });
    expect(await documentOf(missing)).toMatchObject({ fetchStatus: "failed", fetchAttempts: 1, fetchError: "Sunucu hatası (HTTP 404)." });
    const waiting = await documentOf(flaky);
    expect(waiting).toMatchObject({ fetchStatus: "pending", fetchAttempts: 1, fetchError: "Zaman aşımı." });
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(5.9 * HOUR);

    // Not before its time.
    expect((await fetchDocuments(testDb.db, deps)).attempted).toBe(0);
    await comeBack();
    await fetchDocuments(testDb.db, deps);
    expect(await documentOf(flaky)).toMatchObject({ fetchStatus: "pending", fetchAttempts: 2 });
    await comeBack();
    await fetchDocuments(testDb.db, deps);
    expect(await documentOf(flaky)).toMatchObject({ fetchStatus: "failed", fetchAttempts: 3, retryAt: null });
  });

  it("waits out Retry-After, and leaves the whole site alone as long after a 429", async () => {
    const tenderId = await matchedTender();
    const first = await link(tenderId, "https://busy.example/a.pdf");
    const second = await link(tenderId, "https://busy.example/b.pdf");
    const other = await link(tenderId, "https://calm.example/c.pdf");
    const links = fakeLinks({
      "https://busy.example/a.pdf": failure(429, true, 30 * 24 * HOUR),
      "https://busy.example/b.pdf": file("https://busy.example/b.pdf"),
      "https://calm.example/c.pdf": failure(503, true, 9 * HOUR),
    });

    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });

    expect(links.requested).toEqual(["https://busy.example/a.pdf", "https://calm.example/c.pdf"]);
    // The site's other link waits as long, with no attempt counted, and the next run leaves it alone.
    const waitingLink = await documentOf(second);
    expect(waitingLink).toMatchObject({ fetchStatus: "pending", fetchAttempts: 0, fetchError: "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor." });
    expect(Math.abs(waitingLink.retryAt!.getTime() - (await documentOf(first)).retryAt!.getTime())).toBeLessThan(5_000);
    expect((await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).attempted).toBe(0);
    // A month is cut to a week; nine hours are waited out in full.
    const wait = async (id: string) => (await documentOf(id)).retryAt!.getTime() - Date.now();
    expect(await wait(first)).toBeGreaterThan(6.9 * 24 * HOUR);
    expect(await wait(first)).toBeLessThan(7.1 * 24 * HOUR);
    expect(await wait(other)).toBeGreaterThan(8.9 * HOUR);
    expect(await wait(other)).toBeLessThan(9.1 * HOUR);
  });

  it("keeps the same file once per tender and reuses what was read from it", async () => {
    const tenderId = await matchedTender();
    const uploaded = await insertDocument(testDb.db, {
      tenderId,
      origin: "manual",
      filename: "Şartname.pdf",
      sizeBytes: PDF.length,
      sha256: sha256Of(PDF),
      storagePath: `${tenderId}/${sha256Of(PDF)}.pdf`,
      fetchStatus: "fetched",
      pageCount: 12,
      textContent: "Technical specification",
      processedAt: new Date(),
    });
    const fetched = await link(tenderId, "https://buyer.example/spec.pdf");
    const { storage, uploads } = memoryStorage();

    await fetchDocuments(testDb.db, { ...fakeLinks({ "https://buyer.example/spec.pdf": file("https://buyer.example/spec.pdf") }), storage });

    expect(uploads).toEqual([]);
    const row = await documentOf(fetched);
    expect(row).toMatchObject({ fetchStatus: "fetched", storagePath: (await documentOf(uploaded)).storagePath, pageCount: 12, textContent: "Technical specification" });
    expect(row.processedAt).not.toBeNull();
  });

  it("fetches a link once when two runs overlap, as a command beside the worker would", async () => {
    const tenderId = await matchedTender();
    await link(tenderId, "https://buyer.example/a.pdf");
    await link(tenderId, "https://buyer.example/b.pdf");
    const links = fakeLinks({ "https://buyer.example/a.pdf": file("https://buyer.example/a.pdf"), "https://buyer.example/b.pdf": file("https://buyer.example/b.pdf") });
    const deps = { ...links, storage: memoryStorage().storage };

    const [first, second] = await Promise.all([fetchDocuments(testDb.db, deps), fetchDocuments(testDb.db, deps)]);

    expect(first.attempted + second.attempted).toBe(2);
    expect([...links.requested].sort()).toEqual(["https://buyer.example/a.pdf", "https://buyer.example/b.pdf"]);
    const rows = await testDb.db.select({ status: documents.fetchStatus, retryAt: documents.retryAt }).from(documents);
    expect(rows).toEqual([
      { status: "fetched", retryAt: null },
      { status: "fetched", retryAt: null },
    ]);
  });

  it("stops the run when storage refuses a file", async () => {
    const tenderId = await matchedTender();
    const first = await link(tenderId, "https://buyer.example/a.pdf");
    await link(tenderId, "https://buyer.example/b.pdf");
    const links = fakeLinks({ "https://buyer.example/a.pdf": file("https://buyer.example/a.pdf"), "https://buyer.example/b.pdf": file("https://buyer.example/b.pdf") });
    const { storage, state } = memoryStorage();
    state.failUploads = 1;

    const stats = await fetchDocuments(testDb.db, { ...links, storage });

    expect(stats).toMatchObject({ attempted: 1, retry: 1, stoppedBy: "storage" });
    expect(links.requested).toEqual(["https://buyer.example/a.pdf"]);
    expect(await documentOf(first)).toMatchObject({ fetchStatus: "pending", fetchAttempts: 1, storagePath: null, fetchError: "Dosya depoya yazılamadı; yeniden denenecek." });
  });

  it("fetches nothing while storage is full", async () => {
    const tenderId = await matchedTender();
    await insertDocument(testDb.db, { tenderId, origin: "manual", sizeBytes: 950 * 1024 * 1024, sha256: "f".repeat(64), storagePath: `${tenderId}/f.zip`, fetchStatus: "fetched" });
    await link(tenderId, "https://buyer.example/spec.pdf");
    const links = fakeLinks({ "https://buyer.example/spec.pdf": file("https://buyer.example/spec.pdf") });

    expect(await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).toMatchObject({ attempted: 0, stoppedBy: "full" });
    expect(links.requested).toEqual([]);
  });

  it("stops storing a tender's files at its 200 MB", async () => {
    const tenderId = await matchedTender();
    await insertDocument(testDb.db, {
      tenderId,
      origin: "manual",
      filename: "Çizimler.zip",
      sizeBytes: 200 * 1024 * 1024 - 4,
      sha256: "f".repeat(64),
      storagePath: `${tenderId}/${"f".repeat(64)}.zip`,
      fetchStatus: "fetched",
    });
    const id = await link(tenderId, "https://buyer.example/spec.pdf");

    await fetchDocuments(testDb.db, { ...fakeLinks({ "https://buyer.example/spec.pdf": file("https://buyer.example/spec.pdf") }), storage: memoryStorage().storage });

    expect(await documentOf(id)).toMatchObject({ fetchStatus: "failed", storagePath: null, fetchError: "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli." });
  });
});

/** A portal whose terms allow following its pages' document links (hosts.ts). */
const GIZ = "https://ausschreibungen.giz.de";

describe("fetchDocuments on portal pages", () => {
  it("takes the files a public page of an allowed portal lists, and lists the files it cannot read", async () => {
    const tenderId = await matchedTender();
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/7/documents`);
    await link(tenderId, `${GIZ}/notice.pdf`);
    const links = fakeLinks(
      {
        [`${GIZ}/Satellite/notice/7/documents`]: page(`${GIZ}/Satellite/notice/7/documents`, true),
        [`${GIZ}/files/spec.pdf`]: file(`${GIZ}/files/spec.pdf`, "Technical specification.pdf"),
        [`${GIZ}/files/drawing.dwg`]: { kind: "unsupported", mime: "image/vnd.dwg", filename: "drawing.dwg", finalUrl: `${GIZ}/files/drawing.dwg` },
        [`${GIZ}/lots`]: page(`${GIZ}/lots`),
        [`${GIZ}/notice.pdf`]: file(`${GIZ}/notice.pdf`, "Notice.pdf", new TextEncoder().encode("%PDF-1.7 notice")),
      },
      {
        pages: {
          [`${GIZ}/Satellite/notice/7/documents`]: [
            { url: `${GIZ}/files/spec.pdf`, text: "Specification" },
            { url: `${GIZ}/files/drawing.dwg`, text: "Drawing" },
            { url: `${GIZ}/lots`, text: "Lots" },
            // A notice link the tender has already: not fetched twice.
            { url: `${GIZ}/notice.pdf`, text: "Notice" },
          ],
        },
      },
    );
    const { storage, files } = memoryStorage();

    // The page shows a login form in its header; its files are public all the same.
    const stats = await fetchDocuments(testDb.db, { ...links, storage });

    expect(stats).toMatchObject({ manual: 1, fetched: 1, pageFiles: 1 });
    expect(links.requested.filter((url) => url === `${GIZ}/notice.pdf`)).toHaveLength(1);
    const portalRow = await documentOf(portal);
    expect(portalRow).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; sayfadaki 1 dosya alındı." });
    expect(portalRow.processedAt).not.toBeNull();
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, portal)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.sourceUrl, c.title, c.fetchStatus, c.filename, c.storagePath !== null])).toEqual([
      [`${GIZ}/files/drawing.dwg`, "Drawing", "unsupported", "drawing.dwg", false],
      [`${GIZ}/files/spec.pdf`, "Specification", "fetched", "Technical specification.pdf", true],
    ]);
    expect(files.size).toBe(2);
    // Read to the end, the page is not fetched again; its files are no links of the notice.
    expect((await fetchDocuments(testDb.db, { ...links, storage })).attempted).toBe(0);
  });

  it("follows only allowed portals' pages, and sends nothing to a portal whose terms forbid automated access", async () => {
    const tenderId = await matchedTender();
    const forbidden = await link(tenderId, "https://platformazakupowa.pl/transakcja/1373180");
    const other = await link(tenderId, "https://portal.example/tender/9");
    const links = fakeLinks(
      { "https://portal.example/tender/9": page("https://portal.example/tender/9") },
      { pages: { "https://portal.example/tender/9": [{ url: "https://portal.example/files/x.pdf", text: null }] } },
    );

    const stats = await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });

    expect(links.requested).toEqual(["https://portal.example/tender/9"]);
    expect(stats).toMatchObject({ forbidden: 1, pageFiles: 0 });
    const forbiddenRow = await documentOf(forbidden);
    expect(forbiddenRow).toMatchObject({
      fetchStatus: "needs_manual",
      fetchError: "Bu portalın kullanım şartları otomatik erişimi yasaklıyor (platformazakupowa.pl); dosyalar portaldan indirilmeli.",
    });
    expect(forbiddenRow.processedAt).not.toBeNull();
    // Not marked read: were the portal added to the allowed ones, its page would be read then.
    expect(await documentOf(other)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; dosyalar portalda.", processedAt: null });
    expect((await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).attempted).toBe(0);
  });

  it("keeps to robots.txt, for the notice's links and for what a page lists", async () => {
    const tenderId = await matchedTender();
    const closed = await link(tenderId, "https://closed.example/tender/1");
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/8/documents`);
    const links = fakeLinks(
      { [`${GIZ}/Satellite/notice/8/documents`]: page(`${GIZ}/Satellite/notice/8/documents`) },
      {
        pages: { [`${GIZ}/Satellite/notice/8/documents`]: [{ url: `${GIZ}/private/a.pdf`, text: null }] },
        disallowed: ["https://closed.example/", `${GIZ}/private/`],
      },
    );

    const stats = await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });

    expect(links.requested).toEqual([`${GIZ}/Satellite/notice/8/documents`]);
    expect(stats).toMatchObject({ blocked: 2, pageFiles: 0 });
    expect(await documentOf(closed)).toMatchObject({
      fetchStatus: "needs_manual",
      fetchError: "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli.",
    });
    expect(await documentOf(portal)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; sayfada indirilecek dosya bulunamadı." });
  });

  it("tries a link again later when its robots.txt cannot be read now", async () => {
    const tenderId = await matchedTender();
    const id = await link(tenderId, "https://down.example/spec.pdf");
    const links = fakeLinks({}, { unavailable: ["https://down.example/"] });
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, id));

    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    const waiting = await documentOf(id);
    expect(waiting).toMatchObject({ fetchStatus: "pending", fetchAttempts: 1, fetchError: "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek." });
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);

    // Then hours later: a site's outage may last the night.
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    const again = await documentOf(id);
    expect(again).toMatchObject({ fetchStatus: "pending", fetchAttempts: 2 });
    expect(again.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    expect(await documentOf(id)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Sitenin robots.txt dosyası okunamadı; dosyalar portaldan indirilmeli." });
    expect(links.requested).toEqual([]);
  });

  it("waits for the host's turn once before each request, through the guard", async () => {
    const tenderId = await matchedTender();
    await link(tenderId, `${GIZ}/Satellite/notice/13/documents`);
    const links = fakeLinks(
      {
        [`${GIZ}/Satellite/notice/13/documents`]: page(`${GIZ}/Satellite/notice/13/documents`),
        [`${GIZ}/files/a.pdf`]: file(`${GIZ}/files/a.pdf`),
      },
      { pages: { [`${GIZ}/Satellite/notice/13/documents`]: [{ url: `${GIZ}/files/a.pdf`, text: null }] } },
    );
    const waited: string[] = [];

    await fetchDocuments(testDb.db, { ...links, wait: async (url) => void waited.push(url), storage: memoryStorage().storage });

    expect(waited).toEqual(links.requested);
  });

  it("settles a link whose redirect the guard turned down at a forbidden portal", async () => {
    const tenderId = await matchedTender();
    const id = await link(tenderId, "https://buyer.example/zamowienie");
    // As fetchDocument answers when a redirect leads to a portal the guard refuses.
    const links = fakeLinks({
      "https://buyer.example/zamowienie": { kind: "blocked", finalUrl: "https://platformazakupowa.pl/transakcja/123456", reason: "terms" },
    });

    expect(await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).toMatchObject({ forbidden: 1, attempted: 0 });
    expect(await documentOf(id)).toMatchObject({
      fetchStatus: "needs_manual",
      fetchError: "Bu portalın kullanım şartları otomatik erişimi yasaklıyor (platformazakupowa.pl); dosyalar portaldan indirilmeli.",
    });
  });

  it("follows a page only where it ended up allowed, and only links of allowed portals", async () => {
    const tenderId = await matchedTender();
    const sso = await link(tenderId, `${GIZ}/Satellite/notice/10/documents`);
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/11/documents`);
    const links = fakeLinks(
      {
        // Redirected to a login service whose terms were not read.
        [`${GIZ}/Satellite/notice/10/documents`]: page("https://sso.example/login"),
        [`${GIZ}/Satellite/notice/11/documents`]: page(`${GIZ}/Satellite/notice/11/documents`),
      },
      {
        pages: {
          "https://sso.example/login": [{ url: "https://sso.example/files/a.pdf", text: null }],
          // The parent domain is not the portal whose terms were read.
          [`${GIZ}/Satellite/notice/11/documents`]: [{ url: "https://www.giz.de/de/downloads/brochure.pdf", text: null }],
        },
      },
    );

    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });

    expect(links.requested).toEqual([`${GIZ}/Satellite/notice/10/documents`, `${GIZ}/Satellite/notice/11/documents`]);
    // Left to the team: a link of an allowed portal not marked read would be fetched again at every run.
    const ssoRow = await documentOf(sso);
    expect(ssoRow).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; dosyalar portalda." });
    expect(ssoRow.processedAt).not.toBeNull();
    expect(await documentOf(portal)).toMatchObject({ fetchError: "Portal sayfası; sayfada indirilecek dosya bulunamadı." });
    expect((await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).attempted).toBe(0);
  });

  it("does not fetch what storage has no room for, and waits a day before trying again", async () => {
    const tenderId = await matchedTender();
    const other = await insertTender(testDb.db);
    await insertDocument(testDb.db, { tenderId: other, origin: "manual", sizeBytes: 950 * 1024 * 1024 - 10, sha256: "e".repeat(64), storagePath: `${other}/e.zip`, fetchStatus: "fetched" });
    const id = await link(tenderId, "https://buyer.example/spec.pdf");
    const links = fakeLinks({ "https://buyer.example/spec.pdf": file("https://buyer.example/spec.pdf") });

    expect(await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).toMatchObject({ stoppedBy: "full" });
    const row = await documentOf(id);
    expect(row).toMatchObject({ fetchStatus: "pending", storagePath: null, fetchError: "Dosya deposunda yer kalmadı; yer açılınca yeniden denenecek." });
    expect(row.retryAt!.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
  });

  it("leaves the rest of a page to the team when its site keeps asking to slow down", async () => {
    const tenderId = await matchedTender();
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/12/documents`);
    const links = fakeLinks(
      {
        [`${GIZ}/Satellite/notice/12/documents`]: page(`${GIZ}/Satellite/notice/12/documents`),
        [`${GIZ}/files/busy.pdf`]: failure(429, true),
      },
      { pages: { [`${GIZ}/Satellite/notice/12/documents`]: [{ url: `${GIZ}/files/busy.pdf`, text: null }] } },
    );
    const comeBack = async () => {
      await testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, portal));
      await testDb.db.update(hostRests).set({ until: sql`now() - interval '1 minute'` });
    };

    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    expect(await documentOf(portal)).toMatchObject({ processedAt: null, fetchAttempts: 1 });
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    const done = await documentOf(portal);
    expect(done).toMatchObject({ fetchError: "Portal sayfası; site istekleri sınırladığı için kalan dosyalar portaldan indirilmeli." });
    expect(done.processedAt).not.toBeNull();
  });

  it("tries a page again on later days when all its links answer pages, then leaves it to the team", async () => {
    const tenderId = await matchedTender();
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/14/documents`);
    const links = fakeLinks(
      {
        [`${GIZ}/Satellite/notice/14/documents`]: page(`${GIZ}/Satellite/notice/14/documents`),
        [`${GIZ}/download?doc=1`]: page(`${GIZ}/download?doc=1`),
        [`${GIZ}/download?doc=2`]: page(`${GIZ}/download?doc=2`),
      },
      { pages: { [`${GIZ}/Satellite/notice/14/documents`]: [`${GIZ}/download?doc=1`, `${GIZ}/download?doc=2`].map((url) => ({ url, text: null })) } },
    );
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, portal));

    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    const waiting = await documentOf(portal);
    expect(waiting).toMatchObject({ processedAt: null, fetchAttempts: 1, fetchError: "Portal sayfası; sayfadaki linkler dosya vermedi, yarın yeniden denenecek." });
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);

    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
    const settled = await documentOf(portal);
    expect(settled).toMatchObject({ fetchError: "Portal sayfası; sayfadaki linkler dosya vermedi, dosyalar portaldan indirilmeli." });
    expect(settled.processedAt).not.toBeNull();
  });

  it("goes on with a page whose files did not fit one run, where it stopped", async () => {
    const tenderId = await matchedTender();
    const portal = await link(tenderId, `${GIZ}/Satellite/notice/9/documents`);
    const fileUrls = Array.from({ length: 25 }, (_, i) => `${GIZ}/files/${i + 1}.pdf`);
    const answers: Record<string, FetchResult> = { [`${GIZ}/Satellite/notice/9/documents`]: page(`${GIZ}/Satellite/notice/9/documents`) };
    for (const [i, url] of fileUrls.entries()) answers[url] = file(url, `${i + 1}.pdf`, new TextEncoder().encode(`%PDF-1.7 file ${i + 1}`));
    const links = fakeLinks(answers, { pages: { [`${GIZ}/Satellite/notice/9/documents`]: fileUrls.map((url) => ({ url, text: null })) } });
    const { storage } = memoryStorage();
    const childCount = async () => (await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, portal))).length;

    expect(await fetchDocuments(testDb.db, { ...links, storage })).toMatchObject({ pageFiles: 20 });
    const halfway = await documentOf(portal);
    expect(halfway).toMatchObject({ fetchStatus: "needs_manual", processedAt: null, retryAt: null, fetchError: "Portal sayfası; dosyaları alınıyor, bu turda 20 dosya alındı." });
    expect(await childCount()).toBe(20);

    expect(await fetchDocuments(testDb.db, { ...links, storage })).toMatchObject({ pageFiles: 5 });
    const done = await documentOf(portal);
    // All the page gave, over both runs.
    expect(done).toMatchObject({ fetchError: "Portal sayfası; sayfadaki 25 dosya alındı." });
    expect(done.processedAt).not.toBeNull();
    expect(await childCount()).toBe(25);
  });
});

/** A portal whose documents come from its official API (hosts.ts). */
const TENDERNED = "https://www.tenderned.nl";
const TNS = `${TENDERNED}/papi/tenderned-rs-tns/v2`;
const tenderNedPage = (id: number) => `${TENDERNED}/aankondigingen/overzicht/${id}`;
const tenderNedFile = (id: number, doc: number) => `${TNS}/publicaties/${id}/documenten/${doc}/content`;

/**
 * As the worker's listDocuments: the API's answer for a notice page of the
 * portal (each request through the guard), null for any other link.
 */
function fakeApi(listings: Record<string, DocumentListing | (() => DocumentListing)>) {
  const listed: string[] = [];
  const listDocuments = async (url: string, guard: FetchGuard): Promise<DocumentListing | null> => {
    const answer = listings[url];
    if (!answer) return null;
    const reason = await guard(url);
    if (reason) return { kind: "blocked", finalUrl: url, reason };
    listed.push(url);
    return typeof answer === "function" ? answer() : answer;
  };
  return { listDocuments, listed };
}

const listing = (...docs: { url: string; name: string; sizeBytes?: number | null; skip?: string | null }[]): DocumentListing => ({
  kind: "documents",
  documents: docs.map((d) => ({ sizeBytes: null, skip: null, ...d })),
});
const apiFailure = (status: number | null, retryable: boolean): Extract<JsonResult, { kind: "failed" }> => ({
  kind: "failed",
  error: status ? `Sunucu hatası (HTTP ${status}).` : "Zaman aşımı.",
  status,
  retryable,
  retryAfterMs: null,
});

describe("fetchDocuments on portal APIs", () => {
  it("takes the files a portal's API lists, under the notice's link, and lists those it does not fetch", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(443745));
    const links = fakeLinks({
      [tenderNedFile(443745, 1)]: file(tenderNedFile(443745, 1)),
      [tenderNedFile(443745, 2)]: file(tenderNedFile(443745, 2), "Bestek v2.pdf", new TextEncoder().encode("%PDF-1.7 bestek")),
    });
    const api = fakeApi({
      [tenderNedPage(443745)]: listing(
        // No file name from the server: the API's name is kept.
        { url: tenderNedFile(443745, 1), name: "Aankondiging.pdf" },
        { url: tenderNedFile(443745, 2), name: "Bestek.pdf" },
        { url: tenderNedFile(443745, 3), name: "Besmet.docx", skip: "Portal bu dosyada virüs şüphesi bildiriyor; indirilmedi." },
        { url: tenderNedFile(443745, 4), name: "Tekeningen.zip", sizeBytes: 80 * 1024 * 1024 },
        // Not the portal's own file.
        { url: "https://elsewhere.example/a.pdf", name: "a.pdf" },
      ),
    });
    const { storage, files } = memoryStorage();

    const stats = await fetchDocuments(testDb.db, { ...links, ...api, storage });

    expect(api.listed).toEqual([tenderNedPage(443745)]);
    expect(links.requested).toEqual([tenderNedFile(443745, 1), tenderNedFile(443745, 2)]);
    expect(stats).toMatchObject({ attempted: 1, manual: 1, pageFiles: 2 });
    const row = await documentOf(notice);
    expect(row).toMatchObject({ fetchStatus: "needs_manual", fetchError: "TenderNed API'si; 2 dosya alındı." });
    expect(row.processedAt).not.toBeNull();
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.sourceUrl, c.fetchStatus, c.filename, c.fetchError])).toEqual([
      [tenderNedFile(443745, 1), "fetched", "Aankondiging.pdf", null],
      [tenderNedFile(443745, 2), "fetched", "Bestek v2.pdf", null],
      [tenderNedFile(443745, 3), "failed", "Besmet.docx", "Portal bu dosyada virüs şüphesi bildiriyor; indirilmedi."],
      [tenderNedFile(443745, 4), "failed", "Tekeningen.zip", "Dosya 50 MB sınırından büyük; portaldan indirilmeli."],
    ]);
    expect(files.size).toBe(2);
    // Taken to the end: the API is not asked again.
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage })).attempted).toBe(0);
    expect(api.listed).toHaveLength(1);
  });

  it("asks the API again for a notice left as a portal page before the portal had an adapter", async () => {
    const tenderId = await matchedTender();
    const notice = await insertDocument(testDb.db, {
      tenderId,
      origin: "auto",
      sourceUrl: tenderNedPage(442384),
      fetchStatus: "needs_manual",
      fetchError: "Portal sayfası; dosyalar portalda.",
    });
    const links = fakeLinks({ [tenderNedFile(442384, 9)]: file(tenderNedFile(442384, 9), "Leidraad.pdf") });
    const api = fakeApi({ [tenderNedPage(442384)]: listing({ url: tenderNedFile(442384, 9), name: "Leidraad.pdf" }) });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(await documentOf(notice)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "TenderNed API'si; 1 dosya alındı." });
  });

  it("goes on with a long list over several runs, and counts all it took", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(7));
    const docs = Array.from({ length: 23 }, (_, i) => ({ url: tenderNedFile(7, i + 1), name: `${i + 1}.pdf` }));
    const answers: Record<string, FetchResult> = {};
    for (const [i, d] of docs.entries()) answers[d.url] = file(d.url, null, new TextEncoder().encode(`%PDF-1.7 doc ${i + 1}`));
    const links = fakeLinks(answers);
    const api = fakeApi({ [tenderNedPage(7)]: listing(...docs) });
    const { storage } = memoryStorage();

    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(await documentOf(notice)).toMatchObject({ processedAt: null, retryAt: null, fetchError: "TenderNed API'si; dosyalar alınıyor, bu turda 20 dosya alındı." });

    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    const done = await documentOf(notice);
    expect(done).toMatchObject({ fetchError: "TenderNed API'si; 23 dosya alındı." });
    expect(done.processedAt).not.toBeNull();
    expect(links.requested).toHaveLength(23);
  });

  it("takes a procedure's files once when the tender has a link to its rectification too", async () => {
    const tenderId = await matchedTender();
    const original = await link(tenderId, tenderNedPage(443706));
    const rectification = await link(tenderId, tenderNedPage(444310));
    // As the adapter answers both: the latest rectification's addresses for the documents they share.
    const shared = listing({ url: tenderNedFile(444310, 15010869), name: "Programma van Eisen.pdf" });
    const links = fakeLinks({ [tenderNedFile(444310, 15010869)]: file(tenderNedFile(444310, 15010869)) });
    const api = fakeApi({ [tenderNedPage(443706)]: shared, [tenderNedPage(444310)]: shared });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(api.listed).toEqual([tenderNedPage(443706), tenderNedPage(444310)]);
    expect(links.requested).toEqual([tenderNedFile(444310, 15010869)]);
    expect(await documentOf(original)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });
    const second = await documentOf(rectification);
    expect(second).toMatchObject({ fetchStatus: "needs_manual", fetchError: "TenderNed API'si; listelenen dosyalar ihalede zaten var." });
    expect(second.processedAt).not.toBeNull();
  });

  it("lists each document the API names that did not come, with why, and tries again later those worth it", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(20));
    const links = fakeLinks({
      [tenderNedFile(20, 1)]: file(tenderNedFile(20, 1), "Bestek.pdf"),
      [tenderNedFile(20, 2)]: { kind: "page", finalUrl: tenderNedFile(20, 2), login: true, html: "" },
      [tenderNedFile(20, 3)]: failure(null, true),
      [tenderNedFile(20, 4)]: failure(404, false),
      // No size in the list: it turns out larger than any file we keep.
      [tenderNedFile(20, 5)]: { kind: "too_large", sizeBytes: 60 * 1024 * 1024, finalUrl: tenderNedFile(20, 5) },
    });
    const api = fakeApi({
      [tenderNedPage(20)]: listing(
        { url: tenderNedFile(20, 1), name: "Bestek.pdf" },
        { url: tenderNedFile(20, 2), name: "Prijzenblad.pdf" },
        { url: tenderNedFile(20, 3), name: "Leidraad.pdf" },
        { url: tenderNedFile(20, 4), name: "Weg.pdf" },
        { url: tenderNedFile(20, 5), name: "Tekeningen.pdf" },
      ),
    });
    const { storage } = memoryStorage();

    await fetchDocuments(testDb.db, { ...links, ...api, storage });

    expect(await documentOf(notice)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "TenderNed API'si; 1 dosya alındı, 1 dosya yeniden denenecek." });
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.filename, c.fetchStatus, c.fetchError, c.processedAt !== null])).toEqual([
      ["Bestek.pdf", "fetched", null, false],
      ["Prijzenblad.pdf", "needs_manual", "Portal girişi istiyor; dosya portaldan indirilmeli.", true],
      ["Leidraad.pdf", "pending", "Zaman aşımı.", false],
      ["Weg.pdf", "failed", "Sunucu hatası (HTTP 404).", true],
      ["Tekeningen.pdf", "failed", "Dosya 50 MB sınırından büyük; portaldan indirilmeli.", true],
    ]);
    const waiting = children.find((c) => c.filename === "Leidraad.pdf")!;
    expect(waiting.fetchAttempts).toBe(1);
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);

    // Its time come, it is fetched as any link, without asking the API again.
    await testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, waiting.id));
    links.requested.length = 0;
    const answers = { [tenderNedFile(20, 3)]: file(tenderNedFile(20, 3), null, new TextEncoder().encode("%PDF-1.7 leidraad")) };
    await fetchDocuments(testDb.db, { ...links, fetchDocument: fakeLinks(answers).fetchDocument, ...api, storage });
    expect(await documentOf(waiting.id)).toMatchObject({ fetchStatus: "fetched", filename: "Leidraad.pdf" });
    expect(api.listed).toHaveLength(1);
  });

  it("rests the whole site when a file of its list asks to slow down, the rest of the list waiting as links of their own", async () => {
    const first = await matchedTender();
    const second = await matchedTender();
    const busy = await link(first, tenderNedPage(30));
    const other = await link(second, tenderNedPage(31));
    const links = fakeLinks({ [tenderNedFile(30, 1)]: failure(429, true, 2 * HOUR) });
    const api = fakeApi({
      [tenderNedPage(30)]: listing({ url: tenderNedFile(30, 1), name: "a.pdf" }, { url: tenderNedFile(30, 2), name: "b.pdf" }),
      [tenderNedPage(31)]: listing(),
    });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(api.listed).toEqual([tenderNedPage(30)]);
    expect(links.requested).toEqual([tenderNedFile(30, 1)]);
    expect(await documentOf(busy)).toMatchObject({ fetchError: "TenderNed API'si; 2 dosya yeniden denenecek." });
    const waiting = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, busy)).orderBy(documents.sourceUrl);
    expect(waiting.map((c) => [c.filename, c.fetchStatus, c.fetchError])).toEqual([
      ["a.pdf", "pending", "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor."],
      ["b.pdf", "pending", "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor."],
    ]);
    for (const child of waiting) expect(child.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
    const rested = await documentOf(other);
    expect(rested).toMatchObject({ fetchAttempts: 0, fetchError: "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor." });
    expect(rested.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
    // The next run leaves the site alone.
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage })).attempted).toBe(0);
  });

  it("lists what is left of the API's list when the tender's room fills", async () => {
    const tenderId = await matchedTender();
    await insertDocument(testDb.db, {
      tenderId,
      origin: "manual",
      sizeBytes: 200 * 1024 * 1024 - 100,
      sha256: "f".repeat(64),
      storagePath: `${tenderId}/${"f".repeat(64)}.zip`,
      fetchStatus: "fetched",
    });
    const notice = await link(tenderId, tenderNedPage(40));
    const links = fakeLinks({ [tenderNedFile(40, 1)]: file(tenderNedFile(40, 1), "Klein.pdf", new TextEncoder().encode("%PDF")) });
    const big = new Uint8Array(200).fill(37);
    const api = fakeApi({
      [tenderNedPage(40)]: listing(
        { url: tenderNedFile(40, 1), name: "Klein.pdf" },
        { url: tenderNedFile(40, 2), name: "Tekening.pdf" },
        { url: tenderNedFile(40, 3), name: "Bijlage.pdf" },
      ),
    });
    const answers = { ...{ [tenderNedFile(40, 1)]: file(tenderNedFile(40, 1), "Klein.pdf", new TextEncoder().encode("%PDF")) }, [tenderNedFile(40, 2)]: file(tenderNedFile(40, 2), null, big) };

    await fetchDocuments(testDb.db, { ...links, fetchDocument: fakeLinks(answers).fetchDocument, ...api, storage: memoryStorage().storage });

    expect(await documentOf(notice)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.filename, c.fetchStatus, c.fetchError])).toEqual([
      ["Klein.pdf", "fetched", null],
      ["Tekening.pdf", "failed", "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli."],
      ["Bijlage.pdf", "failed", "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli."],
    ]);
  });

  it("tries a list whose files storage refused again hours later, then leaves it to the team", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(50));
    const links = fakeLinks({ [tenderNedFile(50, 1)]: file(tenderNedFile(50, 1)) });
    const api = fakeApi({ [tenderNedPage(50)]: listing({ url: tenderNedFile(50, 1), name: "a.pdf" }) });
    const { storage, state } = memoryStorage();
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, notice));

    state.failUploads = 3;
    expect(await fetchDocuments(testDb.db, { ...links, ...api, storage })).toMatchObject({ stoppedBy: "storage" });
    const waiting = await documentOf(notice);
    expect(waiting).toMatchObject({ fetchAttempts: 1, processedAt: null, fetchError: "TenderNed API'si; dosyalar alınırken depo hata verdi, yeniden denenecek." });
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
    // Not asked again at the next run.
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage })).attempted).toBe(0);

    await comeBack();
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    const settled = await documentOf(notice);
    expect(settled).toMatchObject({ fetchError: "TenderNed API'si; depo dosyaları kabul etmedi, dosyalar portaldan indirilmeli." });
    expect(settled.processedAt).not.toBeNull();
    expect(api.listed).toHaveLength(3);
  });

  it("lets the files whose robots.txt cannot be read wait as links of their own", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(60));
    // The files live on another host of the portal, whose robots.txt cannot be read.
    const files = "https://files.tenderned.nl/content";
    const links = fakeLinks({}, { unavailable: ["https://files.tenderned.nl/"] });
    const api = fakeApi({ [tenderNedPage(60)]: listing({ url: `${files}/1`, name: "a.pdf" }, { url: `${files}/2`, name: "b.pdf" }) });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect((await documentOf(notice)).processedAt).not.toBeNull();
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.filename, c.fetchStatus, c.fetchAttempts, c.fetchError])).toEqual([
      ["a.pdf", "pending", 0, "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek."],
      ["b.pdf", "pending", 0, "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek."],
    ]);
    for (const child of children) expect(child.retryAt!.getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);
    expect(links.requested).toEqual([]);
  });

  it("knows a document under another publication's address by its key", async () => {
    const tenderId = await matchedTender();
    const first = await link(tenderId, tenderNedPage(70));
    const later = await link(tenderId, tenderNedPage(71));
    // The procedure's rectification came later: the API lists the same documents under its address.
    const links = fakeLinks({ [tenderNedFile(70, 5)]: file(tenderNedFile(70, 5), "Bestek.pdf") });
    const api = fakeApi({
      [tenderNedPage(70)]: listing({ url: tenderNedFile(70, 5), name: "Bestek.pdf" }),
      [tenderNedPage(71)]: listing({ url: tenderNedFile(71, 5), name: "Bestek.pdf" }),
    });
    const documentKey = (url: string) => /\/documenten\/(\d+)\/content$/.exec(url)?.[1] ?? null;

    await fetchDocuments(testDb.db, { ...links, ...api, documentKey, storage: memoryStorage().storage });

    expect(links.requested).toEqual([tenderNedFile(70, 5)]);
    expect(await documentOf(first)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });
    expect(await documentOf(later)).toMatchObject({ fetchError: "TenderNed API'si; listelenen dosyalar ihalede zaten var." });
  });

  it("asks the API again a day after its list gave documents, for those added since", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(80));
    const answers: Record<string, FetchResult> = {
      [tenderNedFile(80, 1)]: file(tenderNedFile(80, 1), "Bestek.pdf"),
      [tenderNedFile(80, 2)]: file(tenderNedFile(80, 2), "Nota van inlichtingen.pdf", new TextEncoder().encode("%PDF-1.7 nvi")),
    };
    const links = fakeLinks(answers);
    let documentsListed = [{ url: tenderNedFile(80, 1), name: "Bestek.pdf" }];
    const api = fakeApi({ [tenderNedPage(80)]: () => listing(...documentsListed) });
    const { storage } = memoryStorage();
    const listedAgo = (hours: number) =>
      testDb.db.update(documents).set({ processedAt: sql`now() - make_interval(hours => ${hours})`, fetchAttempts: 2 }).where(eq(documents.id, notice));

    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(await documentOf(notice)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı.", fetchAttempts: 0 });

    // Not again the same day.
    await listedAgo(23);
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage })).attempted).toBe(0);

    // A day later the buyer's answers are there: only they are fetched, and the tries start over.
    documentsListed = [...documentsListed, { url: tenderNedFile(80, 2), name: "Nota van inlichtingen.pdf" }];
    await listedAgo(25);
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(api.listed).toHaveLength(2);
    expect(links.requested).toEqual([tenderNedFile(80, 1), tenderNedFile(80, 2)]);
    const again = await documentOf(notice);
    expect(again).toMatchObject({ fetchError: "TenderNed API'si; 2 dosya alındı.", fetchAttempts: 0 });
    expect(Date.now() - again.processedAt!.getTime()).toBeLessThan(HOUR);
  });

  it("keeps what a list read before gave when it fails later, and stops asking for a list that is gone", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(86));
    const links = fakeLinks({ [tenderNedFile(86, 1)]: file(tenderNedFile(86, 1), "Bestek.pdf") });
    let answer: DocumentListing = listing({ url: tenderNedFile(86, 1), name: "Bestek.pdf" });
    const api = fakeApi({ [tenderNedPage(86)]: () => answer });
    const { storage } = memoryStorage();
    const listedAgo = (hours: number) => testDb.db.update(documents).set({ processedAt: sql`now() - make_interval(hours => ${hours})`, retryAt: null }).where(eq(documents.id, notice));

    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(await documentOf(notice)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });

    // A day later the service fails: tried again later, the note kept.
    answer = apiFailure(500, true);
    await listedAgo(25);
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    const failing = await documentOf(notice);
    expect(failing).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı.", fetchAttempts: 1 });
    expect(failing.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);

    // The publication is gone: the note stays and the list is not asked for again.
    answer = apiFailure(404, false);
    await listedAgo(25);
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(await documentOf(notice)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı.", fetchAttempts: 3 });
    await listedAgo(48);
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage })).attempted).toBe(0);
    expect(api.listed).toHaveLength(3);
  });

  it("keeps the note of a list read before while its site rests, and reads it again with storage nearly full", async () => {
    const tenderId = await matchedTender({ submissionDeadline: new Date(Date.now() + 20 * 24 * HOUR) });
    const notice = await link(tenderId, tenderNedPage(87));
    const links = fakeLinks({ [tenderNedFile(87, 1)]: file(tenderNedFile(87, 1), "Bestek.pdf") });
    const api = fakeApi({ [tenderNedPage(87)]: listing({ url: tenderNedFile(87, 1), name: "Bestek.pdf" }) });
    const { storage } = memoryStorage();
    await fetchDocuments(testDb.db, { ...links, ...api, storage });

    // A day later, another link of the site (of a tender closing sooner) asks to slow down: the notice waits as long, its note kept.
    await testDb.db.update(documents).set({ processedAt: sql`now() - interval '25 hours'` }).where(eq(documents.id, notice));
    const other = await matchedTender({ submissionDeadline: new Date(Date.now() + 5 * 24 * HOUR) });
    await link(other, `${TENDERNED}/x.pdf`);
    await fetchDocuments(testDb.db, { ...fakeLinks({ [`${TENDERNED}/x.pdf`]: failure(429, true) }), ...api, storage });
    expect(api.listed).toHaveLength(1);
    const resting = await documentOf(notice);
    expect(resting).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });
    expect(resting.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);

    // Storage nearly full: the list read before is read again all the same, and the run goes on.
    await testDb.db.update(documents).set({ retryAt: null }).where(eq(documents.id, notice));
    await testDb.db.update(hostRests).set({ until: sql`now() - interval '1 minute'` });
    const filler = await insertTender(testDb.db);
    await insertDocument(testDb.db, { tenderId: filler, origin: "manual", sizeBytes: 947 * 1024 * 1024, sha256: "e".repeat(64), storagePath: `${filler}/e.zip`, fetchStatus: "fetched" });
    const stats = await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(stats.stoppedBy).toBeNull();
    expect(api.listed).toHaveLength(2);
    expect(await documentOf(notice)).toMatchObject({ fetchError: "TenderNed API'si; 1 dosya alındı." });
  });

  it("lists what no longer fits once, leaving out the documents the tender has under another address", async () => {
    const tenderId = await matchedTender();
    await insertDocument(testDb.db, {
      tenderId,
      origin: "manual",
      sizeBytes: 200 * 1024 * 1024 - 100,
      sha256: "f".repeat(64),
      storagePath: `${tenderId}/${"f".repeat(64)}.zip`,
      fetchStatus: "fetched",
    });
    const original = await link(tenderId, tenderNedPage(88));
    await insertDocument(testDb.db, { tenderId, origin: "auto", parentDocumentId: original, sourceUrl: tenderNedFile(88, 77), fetchStatus: "fetched", storagePath: `${tenderId}/a.pdf`, sizeBytes: 10 });
    await testDb.db.update(documents).set({ fetchStatus: "needs_manual", processedAt: sql`now()` }).where(eq(documents.id, original));
    const rectification = await link(tenderId, tenderNedPage(89));
    // The new drawing does not fit; the specification after it is the one the tender has under the original's address.
    const api = fakeApi({ [tenderNedPage(89)]: listing({ url: tenderNedFile(89, 78), name: "Tekening.pdf" }, { url: tenderNedFile(89, 77), name: "Bestek.pdf" }) });
    const links = fakeLinks({ [tenderNedFile(89, 78)]: file(tenderNedFile(89, 78), null, new Uint8Array(500).fill(37)) });
    const documentKey = (url: string) => /\/documenten\/(\d+)\/content$/.exec(url)?.[1] ?? null;

    await fetchDocuments(testDb.db, { ...links, ...api, documentKey, storage: memoryStorage().storage });

    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, rectification));
    expect(children.map((c) => [c.filename, c.fetchStatus, c.fetchError])).toEqual([["Tekening.pdf", "failed", "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli."]]);
  });

  it("does not ask again for notices whose list gave nothing of their own, nor read pages again", async () => {
    const tenderId = await matchedTender();
    const settled = { origin: "auto" as const, fetchStatus: "needs_manual" as const, processedAt: new Date(Date.now() - 48 * HOUR) };
    // Its documents came under the procedure's other link.
    await insertDocument(testDb.db, { tenderId, ...settled, sourceUrl: tenderNedPage(90), fetchError: "TenderNed API'si; listelenen dosyalar ihalede zaten var." });
    // Robots.txt closed: nothing was listed.
    await insertDocument(testDb.db, { tenderId, ...settled, sourceUrl: tenderNedPage(91), fetchError: "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli." });
    // A page of a portal whose links are followed is read once.
    const page = await insertDocument(testDb.db, { tenderId, ...settled, sourceUrl: `${GIZ}/Satellite/notice/90/documents`, fetchError: "Portal sayfası; sayfadaki 1 dosya alındı." });
    await insertDocument(testDb.db, { tenderId, origin: "auto", parentDocumentId: page, sourceUrl: `${GIZ}/files/90.pdf`, fetchStatus: "unsupported" });
    const api = fakeApi({ [tenderNedPage(90)]: listing(), [tenderNedPage(91)]: listing() });

    expect((await fetchDocuments(testDb.db, { ...fakeLinks({}), ...api, storage: memoryStorage().storage })).attempted).toBe(0);
    expect(api.listed).toEqual([]);
  });

  it("sends nothing to a resting site, also from links that come due while it rests", async () => {
    const first = await matchedTender({ submissionDeadline: new Date(Date.now() + 5 * 24 * HOUR) });
    const busy = await link(first, tenderNedPage(100));
    const links = fakeLinks({ [tenderNedFile(100, 1)]: failure(429, true, 48 * HOUR) });
    const api = fakeApi({
      [tenderNedPage(100)]: listing({ url: tenderNedFile(100, 1), name: "a.pdf" }),
      [tenderNedPage(101)]: listing(),
      [tenderNedPage(102)]: listing(),
    });
    const { storage } = memoryStorage();
    await fetchDocuments(testDb.db, { ...links, ...api, storage });

    // A day later: a list read before comes due again, and a new notice of the site arrives.
    await testDb.db.update(documents).set({ processedAt: sql`now() - interval '25 hours'` }).where(eq(documents.id, busy));
    const second = await matchedTender();
    await link(second, tenderNedPage(102));
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage })).attempted).toBe(0);
    expect(api.listed).toEqual([tenderNedPage(100)]);

    // The rest is over: they are asked.
    await testDb.db.update(hostRests).set({ until: sql`now() - interval '1 minute'` });
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    expect(api.listed).toEqual([tenderNedPage(100), tenderNedPage(100), tenderNedPage(102)]);
  });

  it("keeps a flagged document flagged when the rest of its list waits", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(110));
    const links = fakeLinks({ [tenderNedFile(110, 1)]: failure(429, true) });
    const api = fakeApi({
      [tenderNedPage(110)]: listing(
        { url: tenderNedFile(110, 1), name: "Leidraad.pdf" },
        { url: tenderNedFile(110, 2), name: "Besmet.pdf", skip: "Virüs taramasında işaretli; indirilmedi." },
        { url: tenderNedFile(110, 3), name: "Tekeningen.zip", sizeBytes: 80 * 1024 * 1024 },
      ),
    });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.filename, c.fetchStatus, c.fetchError])).toEqual([
      ["Leidraad.pdf", "pending", "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor."],
      ["Besmet.pdf", "failed", "Virüs taramasında işaretli; indirilmedi."],
      ["Tekeningen.zip", "failed", "Dosya 50 MB sınırından büyük; portaldan indirilmeli."],
    ]);
  });

  it("asks again for a list read before that failed only a day later, so a night's outage does not end it", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(120));
    const links = fakeLinks({ [tenderNedFile(120, 1)]: file(tenderNedFile(120, 1), "Bestek.pdf") });
    let answer: DocumentListing = listing({ url: tenderNedFile(120, 1), name: "Bestek.pdf" });
    const api = fakeApi({ [tenderNedPage(120)]: () => answer });
    const { storage } = memoryStorage();
    await fetchDocuments(testDb.db, { ...links, ...api, storage });

    answer = apiFailure(503, true);
    await testDb.db.update(documents).set({ processedAt: sql`now() - interval '25 hours'` }).where(eq(documents.id, notice));
    await fetchDocuments(testDb.db, { ...links, ...api, storage });
    const failing = await documentOf(notice);
    expect(failing).toMatchObject({ fetchAttempts: 1, fetchError: "TenderNed API'si; 1 dosya alındı." });
    expect(failing.retryAt!.getTime() - Date.now()).toBeGreaterThan(23 * HOUR);
  });

  it("treats a link waiting to be fetched as one, whatever was read of it before", async () => {
    const tenderId = await matchedTender();
    // A pending link with a time it was once read (by hand, say): robots.txt closes its site.
    const id = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: tenderNedPage(130), fetchStatus: "pending", processedAt: new Date(Date.now() - 48 * HOUR) });
    const links = fakeLinks({}, { disallowed: [`${TENDERNED}/aankondigingen/`] });
    const api = fakeApi({ [tenderNedPage(130)]: listing() });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(await documentOf(id)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli." });
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage })).blocked).toBe(0);
  });

  it("rests the site that answered, whichever of its names a link uses", async () => {
    const first = await matchedTender({ submissionDeadline: new Date(Date.now() + 5 * 24 * HOUR) });
    const second = await matchedTender();
    // The notice links to the bare domain; the API it is listed through answers on www.
    await link(first, "https://tenderned.nl/aankondigingen/overzicht/140");
    await link(second, tenderNedPage(141));
    const api = fakeApi({
      "https://tenderned.nl/aankondigingen/overzicht/140": { ...apiFailure(429, true), finalUrl: `${TNS}/publicaties/140` },
      [tenderNedPage(141)]: listing(),
    });

    await fetchDocuments(testDb.db, { ...fakeLinks({}), ...api, storage: memoryStorage().storage });

    expect(api.listed).toEqual(["https://tenderned.nl/aankondigingen/overzicht/140"]);
    expect(await testDb.db.select({ host: hostRests.host }).from(hostRests)).toEqual([{ host: "tenderned.nl" }]);
    expect((await fetchDocuments(testDb.db, { ...fakeLinks({}), ...api, storage: memoryStorage().storage })).attempted).toBe(0);
  });

  it("leaves a resting site's links out of the queue, whichever form their host takes, an API portal's subdomains too", async () => {
    const tenderId = await matchedTender();
    await testDb.db.insert(hostRests).values({ host: "tenderned.nl", until: new Date(Date.now() + 6 * HOUR), status: 429 });
    await link(tenderId, "https://WWW.TenderNed.nl./aankondigingen/overzicht/160");
    await link(tenderId, "https://tenderned.nl:443/aankondigingen/overzicht/161");
    await link(tenderId, "https://files.tenderned.nl/x.pdf");
    await link(tenderId, "https://nottenderned.nl/x.pdf");
    // Another site: www and the bare name are one, its other services are not.
    await testDb.db.insert(hostRests).values({ host: "gov.uk", until: new Date(Date.now() + 6 * HOUR), status: 429 });
    await link(tenderId, "https://www.gov.uk/x.pdf");
    await link(tenderId, "https://www.find-tender.service.gov.uk/x.pdf");

    const queue = await pendingFetches(testDb.db, 30);

    // The API portal's subdomains rest with it; a name that only ends the same way does not.
    expect(queue.map((q) => q.sourceUrl)).toEqual(["https://nottenderned.nl/x.pdf", "https://www.find-tender.service.gov.uk/x.pdf"]);
    expect(isResting(new Set(["tenderned.nl", "gov.uk"]), "https://files.tenderned.nl/x.pdf")).toBe(true);
    expect(isResting(new Set(["tenderned.nl", "gov.uk"]), "https://www.find-tender.service.gov.uk/x.pdf")).toBe(false);
    expect(isResting(new Set(["[2001:db8::1]"]), "https://[2001:db8::1]/x.pdf")).toBe(true);
  });

  it("rests the site a redirect led to, and refuses redirects to a resting site", async () => {
    const tenderId = await matchedTender({ submissionDeadline: new Date(Date.now() + 5 * 24 * HOUR) });
    const other = await matchedTender();
    const short = await link(tenderId, "https://buyer.example/spec");
    const later = await link(other, "https://another.example/spec");
    const requested: string[] = [];
    // buyer.example sends to cdn.example, which asks to slow down; another.example sends there too.
    const fetchDocument = async (url: string, { guard }: { guard: FetchGuard; maxBytes: number }): Promise<FetchResult> => {
      for (const hop of [url, "https://CDN.example./files/spec.pdf"]) {
        const reason = await guard(hop);
        if (reason) return { kind: "blocked", finalUrl: hop, reason };
        requested.push(hop);
      }
      return { ...failure(429, true), finalUrl: "https://CDN.example./files/spec.pdf" };
    };

    await fetchDocuments(testDb.db, { ...fakeLinks({}), fetchDocument, storage: memoryStorage().storage });

    expect(requested).toEqual(["https://buyer.example/spec", "https://CDN.example./files/spec.pdf", "https://another.example/spec"]);
    expect(await testDb.db.select({ host: hostRests.host }).from(hostRests)).toEqual([{ host: "cdn.example" }]);
    expect(await documentOf(short)).toMatchObject({ fetchAttempts: 1 });
    // Stopped at the redirect: no attempt counted, tried again once the rest is over.
    const refused = await documentOf(later);
    expect(refused).toMatchObject({ fetchStatus: "pending", fetchAttempts: 0, fetchError: "Site çok fazla istek geldiğini bildirdi; bekleniyor." });
    expect(refused.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
  });

  it("rests a site whose link has an odd form without failing the run", async () => {
    const tenderId = await matchedTender();
    const odd = await link(tenderId, "https:///www.tenderned.nl/files/7.pdf");
    const links = fakeLinks({ "https:///www.tenderned.nl/files/7.pdf": failure(503, true) });

    expect(await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage })).toMatchObject({ attempted: 1 });

    expect(await documentOf(odd)).toMatchObject({ fetchAttempts: 1 });
    expect(await testDb.db.select({ host: hostRests.host }).from(hostRests)).toEqual([{ host: "tenderned.nl" }]);
  });

  it("sees a rest another run wrote meanwhile before the next request", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(150));
    const api = fakeApi({ [tenderNedPage(150)]: listing({ url: tenderNedFile(150, 1), name: "a.pdf" }, { url: tenderNedFile(150, 2), name: "b.pdf" }) });
    // While the first file comes, another run is told to slow down by the site.
    const links = fakeLinks({
      [tenderNedFile(150, 1)]: () => {
        void testDb.db.insert(hostRests).values({ host: "tenderned.nl", until: new Date(Date.now() + 6 * HOUR), status: 429 }).execute();
        return file(tenderNedFile(150, 1), "a.pdf");
      },
    });

    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(links.requested).toEqual([tenderNedFile(150, 1)]);
    const children = await testDb.db.select().from(documents).where(eq(documents.parentDocumentId, notice)).orderBy(documents.sourceUrl);
    expect(children.map((c) => [c.filename, c.fetchStatus])).toEqual([
      ["a.pdf", "fetched"],
      ["b.pdf", "pending"],
    ]);
  });

  it("tries a failed list again later, then leaves the notice to the team", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(8));
    const api = fakeApi({ [tenderNedPage(8)]: apiFailure(500, true) });
    const links = fakeLinks({});
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, notice));

    expect(await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage })).toMatchObject({ attempted: 1, retry: 1 });
    const waiting = await documentOf(notice);
    expect(waiting).toMatchObject({
      fetchStatus: "pending",
      fetchAttempts: 1,
      fetchError: "TenderNed API'si; dosya listesi alınamadı. Sunucu hatası (HTTP 500). Yeniden denenecek.",
    });
    expect(waiting.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);

    await comeBack();
    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });
    await comeBack();
    await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });
    const settled = await documentOf(notice);
    expect(settled).toMatchObject({
      fetchStatus: "needs_manual",
      fetchError: "TenderNed API'si; dosya listesi alınamadı. Sunucu hatası (HTTP 500). Dosyalar portaldan indirilmeli.",
    });
    expect(settled.processedAt).not.toBeNull();
    expect(links.requested).toEqual([]);
  });

  it("leaves a notice the API does not know to the team at once", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(9));
    const api = fakeApi({ [tenderNedPage(9)]: apiFailure(404, false) });

    await fetchDocuments(testDb.db, { ...fakeLinks({}), ...api, storage: memoryStorage().storage });

    expect(await documentOf(notice)).toMatchObject({
      fetchStatus: "needs_manual",
      fetchError: "TenderNed API'si; dosya listesi alınamadı. Sunucu hatası (HTTP 404). Dosyalar portaldan indirilmeli.",
    });
  });

  it("keeps the API to robots.txt, and lets a portal link the API does not answer for be fetched once", async () => {
    const tenderId = await matchedTender();
    const notice = await link(tenderId, tenderNedPage(10));
    const other = await link(tenderId, `${TENDERNED}/over-tenderned`);
    const links = fakeLinks({ [`${TENDERNED}/over-tenderned`]: page(`${TENDERNED}/over-tenderned`) }, { disallowed: [`${TENDERNED}/aankondigingen/`] });
    const api = fakeApi({ [tenderNedPage(10)]: listing() });

    const stats = await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage });

    expect(api.listed).toEqual([]);
    expect(stats).toMatchObject({ blocked: 1 });
    expect(await documentOf(notice)).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli." });
    // Not a notice: fetched as any link, then left to the team, not fetched at every run.
    const otherRow = await documentOf(other);
    expect(otherRow).toMatchObject({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; dosyalar portalda." });
    expect(otherRow.processedAt).not.toBeNull();
    expect((await fetchDocuments(testDb.db, { ...links, ...api, storage: memoryStorage().storage })).attempted).toBe(0);
  });

  it("rests the portal when its API asks to slow down", async () => {
    const tenderId = await matchedTender();
    const first = await link(tenderId, tenderNedPage(11));
    const second = await link(tenderId, tenderNedPage(12));
    const api = fakeApi({ [tenderNedPage(11)]: apiFailure(429, true), [tenderNedPage(12)]: listing() });

    await fetchDocuments(testDb.db, { ...fakeLinks({}), ...api, storage: memoryStorage().storage });

    expect(api.listed).toEqual([tenderNedPage(11)]);
    expect(await documentOf(first)).toMatchObject({ fetchAttempts: 1 });
    const rested = await documentOf(second);
    expect(rested).toMatchObject({ fetchAttempts: 0, fetchError: "Site çok fazla istek geldiğini bildirdi (HTTP 429); bekleniyor." });
    expect(rested.retryAt!.getTime() - Date.now()).toBeGreaterThan(5 * HOUR);
  });
});

describe("withKindExtension", () => {
  it("gives a file name the extension of what the file is", () => {
    expect(withKindExtension("Spec.PDF", "pdf")).toBe("Spec.PDF");
    expect(withKindExtension("FileDownload.ashx", "docx")).toBe("FileDownload.docx");
    expect(withKindExtension("ITT Volume 2", "zip")).toBe("ITT Volume 2.zip");
    expect(withKindExtension(null, "pdf")).toBeNull();
  });
});
