import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertAssessment, insertDecision, insertDocument, insertMatch, insertProfile, insertTender } from "../../tests/helpers/tenders";
import { documents } from "@/db/schema";
import { fetchDocuments, type RobotsVerdict, sha256Of, withKindExtension } from "./fetch-job";
import type { FetchGuard, FetchResult } from "./types";

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

    await comeBack();
    await fetchDocuments(testDb.db, { ...links, storage: memoryStorage().storage });
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
    expect(await documentOf(sso)).toMatchObject({ fetchStatus: "needs_manual", processedAt: null });
    expect(await documentOf(portal)).toMatchObject({ fetchError: "Portal sayfası; sayfada indirilecek dosya bulunamadı." });
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
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, portal));

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
    expect(done).toMatchObject({ fetchError: "Portal sayfası; sayfadaki 5 dosya alındı." });
    expect(done.processedAt).not.toBeNull();
    expect(await childCount()).toBe(25);
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
