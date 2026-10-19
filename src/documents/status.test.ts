import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { documents, tenders } from "@/db/schema";
import { DOCUMENT_LIMITS } from "@/documents/limits";
import { loadDocumentsStatus, portalHosts, recentLinks } from "./status";

const now = new Date("2026-10-17T09:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

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

async function tender(title: string, n: number): Promise<string> {
  const [row] = await testDb.db
    .insert(tenders)
    .values({ source: "uk_fat", externalId: `00000${n}-2026`, procedureKey: `ocds-test-${n}`, title })
    .returning({ id: tenders.id });
  return row!.id;
}

async function addDocuments(tenderId: string, rows: Partial<typeof documents.$inferInsert>[]) {
  await testDb.db.insert(documents).values(rows.map((row) => ({ tenderId, origin: "auto" as const, ...row })));
}

/** Two tenders with documents in every state the stage leaves them in. */
async function seed() {
  const generators = await tender("Generators", 1);
  const furniture = await tender("Cafe furniture", 2);
  await addDocuments(generators, [
    // The same file linked twice is stored once.
    { sourceUrl: "https://buyer.example/spec.pdf", fetchStatus: "fetched", storagePath: "g/spec.pdf", sizeBytes: 1_000_000, processedAt: minutesAgo(50), updatedAt: minutesAgo(50) },
    { sourceUrl: "https://buyer.example/spec-copy.pdf", fetchStatus: "fetched", storagePath: "g/spec.pdf", sizeBytes: 1_000_000, processedAt: minutesAgo(49), updatedAt: minutesAgo(49) },
    { sourceUrl: "https://buyer.example/terms.docx", fetchStatus: "fetched", storagePath: "g/terms.docx", sizeBytes: 500_000, updatedAt: minutesAgo(48) },
    { sourceUrl: "https://www.sell2wales.gov.wales/notice/1", fetchStatus: "needs_manual", fetchError: "Portal sayfası; dosyalar portalda.", updatedAt: minutesAgo(5) },
    { sourceUrl: "https://WWW.Sell2Wales.gov.wales:443/notice/2", fetchStatus: "needs_manual", fetchError: "Portal girişi istiyor.", updatedAt: minutesAgo(6) },
    { sourceUrl: "https://slow.example/a.pdf", fetchStatus: "pending", fetchAttempts: 1, retryAt: new Date(now.getTime() + 6 * 3_600_000), fetchError: "Zaman aşımı.", updatedAt: minutesAgo(10) },
    // Its retry is due: it waits in the queue like any pending link.
    { sourceUrl: "https://slow.example/b.pdf", fetchStatus: "pending", fetchAttempts: 1, retryAt: minutesAgo(60), fetchError: "HTTP 503", updatedAt: minutesAgo(70) },
    { sourceUrl: "https://buyer.example/untried.pdf", fetchStatus: "pending", updatedAt: minutesAgo(1) },
    // Claimed by a run fetching it right now: no failure, so no retry.
    { sourceUrl: "https://buyer.example/now.pdf", fetchStatus: "pending", retryAt: new Date(now.getTime() + 10 * 60_000), updatedAt: minutesAgo(0) },
  ]);
  await addDocuments(furniture, [
    { sourceUrl: "https://in-tend.example/tender/9", fetchStatus: "needs_manual", fetchError: "Portal girişi istiyor.", updatedAt: minutesAgo(30) },
    { sourceUrl: "https://buyer.example/gone.pdf", fetchStatus: "failed", fetchError: "HTTP 404", updatedAt: minutesAgo(20) },
    { sourceUrl: "https://buyer.example/plan.png", fetchStatus: "unsupported", fetchError: "Okunmayan dosya türü (image/png).", updatedAt: minutesAgo(15) },
    { origin: "manual", filename: "scan.pdf", fetchStatus: "fetched", storagePath: "f/scan.pdf", sizeBytes: 250_000, processedAt: minutesAgo(2), pageCount: 3, fetchError: "PDF'te metin yok; taranmış olabilir, alıntılar doğrulanamaz.", updatedAt: minutesAgo(2) },
  ]);
  return { generators, furniture };
}

describe("loadDocumentsStatus", () => {
  it("counts documents per status, the files waiting to be read and the links waiting for a retry", async () => {
    await seed();
    const status = await loadDocumentsStatus(testDb.db, now);
    expect(status).toMatchObject({
      storedBytes: 1_750_000,
      limitBytes: DOCUMENT_LIMITS.totalBytes,
      byStatus: { fetched: 4, needs_manual: 3, pending: 4, failed: 1, unsupported: 1 },
      unread: 1,
      retrying: 1,
    });
  });

  it("lists the latest five problems, newest first, without portal pages", async () => {
    const { furniture } = await seed();
    const { recentProblems } = await loadDocumentsStatus(testDb.db, now);
    expect(recentProblems.map((p) => [p.document, p.status, p.message])).toEqual([
      ["scan.pdf", "fetched", "PDF'te metin yok; taranmış olabilir, alıntılar doğrulanamaz."],
      ["https://slow.example/a.pdf", "pending", "Zaman aşımı."],
      ["https://buyer.example/plan.png", "unsupported", "Okunmayan dosya türü (image/png)."],
      ["https://buyer.example/gone.pdf", "failed", "HTTP 404"],
      ["https://slow.example/b.pdf", "pending", "HTTP 503"],
    ]);
    expect(recentProblems[0]).toMatchObject({ tenderId: furniture, tenderTitle: "Cafe furniture", at: minutesAgo(2) });
  });

  it("reports an empty stage", async () => {
    expect(await loadDocumentsStatus(testDb.db, now)).toEqual({
      storedBytes: 0,
      limitBytes: DOCUMENT_LIMITS.totalBytes,
      byStatus: { pending: 0, fetched: 0, needs_manual: 0, failed: 0, unsupported: 0 },
      unread: 0,
      retrying: 0,
      recentProblems: [],
    });
  });
});

describe("report helpers", () => {
  it("counts portal links per host, ignoring case and port", async () => {
    await seed();
    expect(await portalHosts(testDb.db, 10)).toEqual([
      { host: "www.sell2wales.gov.wales", count: 2 },
      { host: "in-tend.example", count: 1 },
    ]);
  });

  it("leaves out portal links whose files were taken", async () => {
    const generators = await tender("Generators", 1);
    const [page] = await testDb.db
      .insert(documents)
      .values({ tenderId: generators, origin: "auto", sourceUrl: "https://www.tenderned.nl/aankondigingen/overzicht/1", fetchStatus: "needs_manual" })
      .returning({ id: documents.id });
    await addDocuments(generators, [
      { parentDocumentId: page!.id, sourceUrl: "https://www.tenderned.nl/papi/x/content", fetchStatus: "fetched", storagePath: "g/x.pdf", sizeBytes: 10 },
      { sourceUrl: "https://www.tenderned.nl/aankondigingen/overzicht/2", fetchStatus: "needs_manual" },
    ]);
    expect(await portalHosts(testDb.db, 10)).toEqual([{ host: "www.tenderned.nl", count: 1 }]);
  });

  it("lists the notice links that have been tried, the latest first", async () => {
    const { generators } = await seed();
    const links = await recentLinks(testDb.db, 4);
    expect(links.map((l) => [l.host, l.status])).toEqual([
      ["www.sell2wales.gov.wales", "needs_manual"],
      ["www.sell2wales.gov.wales", "needs_manual"],
      ["slow.example", "pending"],
      ["buyer.example", "unsupported"],
    ]);
    expect(links[2]).toMatchObject({ tenderId: generators, tenderTitle: "Generators", message: "Zaman aşımı.", retryAt: new Date(now.getTime() + 6 * 3_600_000) });
    // An untried link and an upload are not in the list.
    const all = await recentLinks(testDb.db, 50);
    expect(all.map((l) => l.url)).not.toContain("https://buyer.example/untried.pdf");
    expect(all).toHaveLength(10);
  });
});
