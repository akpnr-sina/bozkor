import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertTender } from "../../tests/helpers/tenders";
import { documents } from "@/db/schema";
import { extractFile } from "./extract";
import { sha256Of } from "./fetch-job";
import { processDocuments } from "./process-job";
import { storagePathFor } from "./storage";
import type { Extracted, FileKind } from "./types";

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

const pdf = (text: string) => strToU8(`%PDF-1.7\n${text}`);
const zip = (files: Record<string, Uint8Array>) => zipSync(files as Zippable, { level: 0 });

/** Reads files the way extraction does, without parsing them: PDF text after the header, ZIP members as they are. */
async function fakeExtract(bytes: Uint8Array, kind: FileKind): Promise<Extracted> {
  const text = new TextDecoder().decode(bytes);
  if (kind === "pdf") return { kind: "pdf", pageCount: 2, text: text.slice(9).split(" ").join("\f"), truncated: false };
  if (kind === "zip") {
    const members = unzipSync(bytes);
    return { kind: "zip", entries: Object.entries(members).map(([name, data]) => ({ name, bytes: data })), skipped: [] };
  }
  return { kind, text: `${kind} text`, truncated: text.length > 1000 };
}

let tenderId: string;
let bucket: ReturnType<typeof memoryStorage>;

beforeEach(async () => {
  tenderId = await insertTender(testDb.db);
  bucket = memoryStorage();
});

/** A file in storage with its document row, as an upload or a fetch leaves it. */
/** Files get created_at a second apart unless given one, so their reading order is the order they were stored in. */
let filesStored = 0;
async function stored(
  filename: string,
  bytes: Uint8Array,
  kind: FileKind | null,
  origin: "auto" | "manual" = "manual",
  createdAt = new Date(Date.now() - 1_800_000 + filesStored++ * 1_000),
) {
  const sha = sha256Of(bytes);
  const path = storagePathFor(tenderId, sha, kind);
  bucket.files.set(path, bytes);
  return insertDocument(testDb.db, { tenderId, origin, filename, sizeBytes: bytes.length, sha256: sha, storagePath: path, fetchStatus: "fetched", createdAt });
}

const run = (limit?: number) => processDocuments(testDb.db, { extract: fakeExtract, storage: bucket.storage }, { limit });

async function documentOf(id: string) {
  const [row] = await testDb.db.select().from(documents).where(eq(documents.id, id));
  return row!;
}

const membersOf = (parentId: string) => testDb.db.select().from(documents).where(eq(documents.parentDocumentId, parentId)).orderBy(documents.filename);

describe("processDocuments", () => {
  it("reads PDFs, DOCX and XLSX, uploads before fetched files", async () => {
    const fetched = await stored("spec.pdf", pdf("page-one page-two"), "pdf", "auto", new Date(Date.now() - 60_000));
    const uploaded = await stored("Fiyat Cetveli.xlsx", zip({ "[Content_Types].xml": strToU8("<Types/>"), "xl/workbook.xml": strToU8("<w/>") }), "xlsx");

    expect(await run(1)).toMatchObject({ processed: 1 });
    expect(await documentOf(uploaded)).toMatchObject({ textContent: "xlsx text", textTruncated: false, fetchError: null });
    expect((await documentOf(fetched)).processedAt).toBeNull();

    await run();
    const read = await documentOf(fetched);
    expect(read).toMatchObject({ pageCount: 2, textContent: "page-one\fpage-two" });
    expect(read.processedAt).not.toBeNull();
    expect(await run()).toMatchObject({ processed: 0 });
  });

  it("stores the members of a ZIP as documents of their own, then reads them", async () => {
    const known = pdf("already uploaded");
    await stored("Davet.pdf", known, "pdf");
    const pack = await stored(
      "ihale.zip",
      zip({
        "Teknik/Şartname.pdf": pdf("spec"),
        "Fiyat.docx": zip({ "[Content_Types].xml": strToU8("<Types/>"), "word/document.xml": strToU8("<w/>") }),
        "Çizim.dwg": strToU8("AC1032"),
        "Davet kopya.pdf": known,
      }),
      "zip",
    );

    const first = await run();
    expect(first).toMatchObject({ processed: 2, members: 3 });
    const packRow = await documentOf(pack);
    expect(packRow.fetchError).toBe("Alınmayan: Davet kopya.pdf: aynı dosya zaten var");
    const members = await membersOf(pack);
    expect(members.map((m) => [m.filename, m.origin, m.fetchStatus, m.storagePath !== null, m.processedAt !== null])).toEqual([
      ["Fiyat.docx", "manual", "fetched", true, false],
      ["Teknik/Şartname.pdf", "manual", "fetched", true, false],
      ["Çizim.dwg", "manual", "unsupported", false, true],
    ]);

    expect(await run()).toMatchObject({ processed: 2, members: 0 });
    expect((await membersOf(pack)).map((m) => m.textContent)).toEqual(["docx text", "spec", null]);
  });

  it("opens a ZIP inside a ZIP, but not one deeper", async () => {
    const innermost = zip({ "a.pdf": pdf("deep") });
    const outer = await stored("outer.zip", zip({ "inner.zip": zip({ "innermost.zip": innermost }) }), "zip");

    await run();
    const [inner] = await membersOf(outer);
    await run();
    const [deepest] = await membersOf(inner!.id);
    expect(deepest!.filename).toBe("innermost.zip");
    await run();
    expect(await documentOf(deepest!.id)).toMatchObject({ fetchError: "ZIP içinde ZIP içinde ZIP; bu katman açılmadı, içindeki dosyaları ayrıca yükleyin." });
    expect(await membersOf(deepest!.id)).toEqual([]);
  });

  it("retries storage errors minutes later, then gives up", async () => {
    const id = await stored("spec.pdf", pdf("text"), "pdf");
    await stored("other.pdf", pdf("other"), "pdf");
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, id));
    bucket.state.failDownloads = 3;

    expect(await run()).toMatchObject({ processed: 0, failed: 1, stoppedBy: "storage" });
    expect(await documentOf(id)).toMatchObject({ processedAt: null, fetchAttempts: 1 });
    await comeBack();
    await run();
    await comeBack();
    await run();
    const row = await documentOf(id);
    expect(row).toMatchObject({ fetchAttempts: 0, retryAt: null, fetchError: "Depodaki dosya okunamadı; yeniden yükleyin." });
    expect(row.processedAt).not.toBeNull();
  });

  it("finishes a ZIP whose run was cut short by storage, without repeating its members", async () => {
    const pack = await stored("ihale.zip", zip({ "a.pdf": pdf("a"), "b.pdf": pdf("b") }), "zip");
    // The first member is stored, the second fails.
    const upload = bucket.storage.upload;
    let calls = 0;
    bucket.storage.upload = async (path, bytes, mime) => {
      if (++calls === 2) throw new Error("storage unavailable");
      return upload(path, bytes, mime);
    };

    expect(await run()).toMatchObject({ stoppedBy: "storage" });
    expect((await membersOf(pack)).map((m) => m.filename)).toEqual(["a.pdf"]);
    await testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, pack));
    await run();

    expect((await membersOf(pack)).map((m) => m.filename)).toEqual(["a.pdf", "b.pdf"]);
    expect(await documentOf(pack)).toMatchObject({ fetchError: null, fetchAttempts: 0 });
  });

  it("says when a PDF has no text and leaves folders out of what a ZIP left out", async () => {
    const scanned = await stored("scan.pdf", pdf(" "), "pdf");
    const pack = await stored("ihale.zip", zip({ "a.pdf": pdf("a") }), "zip");
    const extract = async (bytes: Uint8Array, kind: FileKind): Promise<Extracted> =>
      kind === "zip"
        ? {
            kind: "zip",
            entries: [{ name: "a.pdf", bytes: pdf("a") }],
            skipped: [
              { name: "Teknik/", reason: "klasör" },
              { name: "__MACOSX/._a.pdf", reason: "macOS ek dosyası" },
              { name: "gizli.pdf", reason: "şifreli" },
            ],
          }
        : fakeExtract(bytes, kind);

    await processDocuments(testDb.db, { extract, storage: bucket.storage });

    expect(await documentOf(scanned)).toMatchObject({ pageCount: 2, fetchError: "PDF'te metin yok; taranmış olabilir, alıntılar doğrulanamaz." });
    expect((await documentOf(pack)).fetchError).toBe("Alınmayan: gizli.pdf: şifreli");
  });

  it("reads a file once when two runs overlap", async () => {
    const pack = await stored("ihale.zip", zip({ "a.pdf": pdf("a"), "b.pdf": pdf("b") }), "zip");

    const [first, second] = await Promise.all([run(), run()]);

    expect(first.processed + second.processed).toBe(1);
    expect((await membersOf(pack)).map((m) => m.filename)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("drops NUL from text and names, which Postgres refuses", async () => {
    const id = await stored("bozuk.pdf", pdf("x"), "pdf");
    const pack = await stored("paket.zip", zip({ "a.pdf": pdf("a") }), "zip");
    const extract = async (bytes: Uint8Array, kind: FileKind): Promise<Extracted> =>
      kind === "zip"
        ? { kind: "zip", entries: [{ name: "a\u0000.pdf", bytes: pdf("a") }], skipped: [] }
        : { kind: "pdf", pageCount: 1, text: "A\u0000A", truncated: false };

    await processDocuments(testDb.db, { extract, storage: bucket.storage });

    expect((await documentOf(id)).textContent).toBe("AA");
    expect((await membersOf(pack)).map((m) => m.filename)).toEqual(["a.pdf"]);
  });

  it("records a file as unreadable after a few unforeseen errors instead of reading it forever", async () => {
    const id = await stored("garip.pdf", pdf("x"), "pdf");
    // A page count past Postgres integers makes the write fail.
    const extract = async (): Promise<Extracted> => ({ kind: "pdf", pageCount: 2 ** 40, text: "x", truncated: false });
    const comeBack = () => testDb.db.update(documents).set({ retryAt: sql`now() - interval '1 minute'` }).where(eq(documents.id, id));

    expect(await processDocuments(testDb.db, { extract, storage: bucket.storage })).toMatchObject({ failed: 1, stoppedBy: null });
    expect(await documentOf(id)).toMatchObject({ processedAt: null, fetchAttempts: 1 });
    await comeBack();
    await processDocuments(testDb.db, { extract, storage: bucket.storage });
    await comeBack();
    await processDocuments(testDb.db, { extract, storage: bucket.storage });

    const row = await documentOf(id);
    expect(row).toMatchObject({ fetchError: "Okunamadı: beklenmeyen bir hata oldu.", fetchAttempts: 0, retryAt: null });
    expect(row.processedAt).not.toBeNull();
  });

  it("keeps the size of what is stored, not what the browser said", async () => {
    const bytes = pdf("page-one");
    const id = await stored("spec.pdf", bytes, "pdf");
    await testDb.db.update(documents).set({ sizeBytes: 1 }).where(eq(documents.id, id));

    await run();

    expect((await documentOf(id)).sizeBytes).toBe(bytes.length);
  });

  it("marks files it cannot read", async () => {
    const html = await stored("documents.pdf", strToU8("<!DOCTYPE html><html>"), null);
    const broken = await stored("broken.pdf", pdf("x"), "pdf");
    const failing = async (bytes: Uint8Array, kind: FileKind): Promise<Extracted> =>
      new TextDecoder().decode(bytes).endsWith("x") ? { kind: "failed", error: "Invalid PDF structure." } : fakeExtract(bytes, kind);

    await processDocuments(testDb.db, { extract: failing, storage: bucket.storage });

    expect(await documentOf(html)).toMatchObject({ fetchStatus: "unsupported", fetchError: "Okunmayan dosya türü." });
    expect(await documentOf(broken)).toMatchObject({ fetchStatus: "fetched", fetchError: "Okunamadı: Invalid PDF structure." });
    expect((await documentOf(broken)).processedAt).not.toBeNull();
  });

  it("reads a real DOCX with the real extraction", async () => {
    const id = await stored("specification.docx", new Uint8Array(readFileSync("tests/fixtures/documents/specification.docx")), "docx");

    await processDocuments(testDb.db, { extract: extractFile, storage: bucket.storage });

    const row = await documentOf(id);
    expect(row.fetchError).toBeNull();
    expect(row.textContent?.length).toBeGreaterThan(20);
  });
});
