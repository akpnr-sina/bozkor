import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertTender } from "../../tests/helpers/tenders";
import { documents } from "@/db/schema";
import { isNoticeDocument, loadFactsNotice } from "@/analysis/facts";
import { analysisInputIds, loadTenderDocuments, storedBytes } from "./queries";
import { KIND_MIME } from "./sniff";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tenderId: string;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  tenderId = await insertTender(testDb.db);
});
afterAll(async () => {
  await testDb.close();
});

const readable = { fetchStatus: "fetched" as const, processedAt: new Date() };

describe("loadTenderDocuments", () => {
  it("lists the notice's links in the facts stage's order, uploads after, members under their ZIP", async () => {
    // One statement, as the normaliser writes a notice's links: the same created_at for all.
    await testDb.db.insert(documents).values([
      // Ids fix the order among equals; the file names would order them the other way.
      { id: "00000000-0000-4000-8000-000000000001", tenderId, origin: "auto", sourceUrl: "https://b.example/2", title: "Ek 2", filename: "z-last-by-name.pdf" },
      { id: "00000000-0000-4000-8000-000000000003", tenderId, origin: "auto", sourceUrl: "https://b.example/1", title: "Teknik şartname", documentType: "technicalSpecifications" },
      { id: "00000000-0000-4000-8000-000000000002", tenderId, origin: "auto", sourceUrl: "https://b.example/3", title: "Ek 3", filename: "a-first-by-name.pdf" },
    ]);
    const zip = await insertDocument(testDb.db, { tenderId, origin: "manual", filename: "paket.zip", storagePath: "t/z.zip", sizeBytes: 10, mime: KIND_MIME.zip, ...readable });
    await insertDocument(testDb.db, { tenderId, origin: "manual", filename: "ic.pdf", parentDocumentId: zip, storagePath: "t/i.pdf", sizeBytes: 4, mime: KIND_MIME.pdf, pageCount: 2, ...readable });
    await insertDocument(testDb.db, { tenderId, origin: "manual", filename: "teklif.docx", storagePath: "t/d.docx", sizeBytes: 6, mime: KIND_MIME.docx, textContent: "metin", ...readable });

    const { documents: list, storedBytes: bytes } = await loadTenderDocuments(testDb.db, tenderId);
    const facts = await loadFactsNotice(testDb.db, tenderId);

    expect(list.filter(isNoticeDocument).map((d) => d.title)).toEqual(facts!.notice.documents!.map((d) => d.title));
    expect(list.map((d) => [d.title ?? d.filename, d.depth, d.analysisInput])).toEqual([
      ["Teknik şartname", 0, false],
      ["Ek 2", 0, false],
      ["Ek 3", 0, false],
      ["paket.zip", 0, false],
      ["ic.pdf", 1, true],
      ["teklif.docx", 0, true],
    ]);
    expect(list.find((d) => d.filename === "teklif.docx")).toMatchObject({ textChars: 5, stored: true, processed: true });
    expect(bytes).toBe(20);
  });
});

describe("analysisInputIds", () => {
  const base = { fetchStatus: "fetched", stored: true, processed: true, mime: KIND_MIME.pdf, pageCount: 3, textChars: 100, sha256: null };

  it("takes stored, read files with pages or text, each content once", () => {
    const ids = analysisInputIds([
      { ...base, id: "pdf", sha256: "a" },
      { ...base, id: "copy", sha256: "a" },
      { ...base, id: "scanned", pageCount: 2, textChars: 0 },
      { ...base, id: "reading", processed: false },
      { ...base, id: "zip", mime: KIND_MIME.zip },
      { ...base, id: "empty-docx", mime: KIND_MIME.docx, textChars: 0 },
      { ...base, id: "portal", fetchStatus: "needs_manual", stored: false },
    ]);
    expect([...ids]).toEqual(["pdf", "scanned"]);
  });
});

describe("storedBytes", () => {
  it("counts each stored object once, per tender or in all", async () => {
    const other = await insertTender(testDb.db);
    await insertDocument(testDb.db, { tenderId, origin: "manual", storagePath: "t/a.pdf", sizeBytes: 100, fetchStatus: "fetched" });
    await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://b.example/a", storagePath: "t/a.pdf", sizeBytes: 100, fetchStatus: "fetched" });
    await insertDocument(testDb.db, { tenderId: other, origin: "manual", storagePath: "o/b.pdf", sizeBytes: 50, fetchStatus: "fetched" });
    await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://b.example/portal", sizeBytes: null });

    expect(await storedBytes(testDb.db, tenderId)).toBe(100);
    expect(await storedBytes(testDb.db)).toBe(150);
  });
});
