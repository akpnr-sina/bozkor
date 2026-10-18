import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertTender } from "../../tests/helpers/tenders";
import { documents } from "@/db/schema";
import { planUploads, recordUploads, removeUpload } from "./manual";
import { storagePathFor } from "./storage";
import type { UploadRequest } from "./uploads";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tenderId: string;
let bucket: ReturnType<typeof memoryStorage>;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  tenderId = await insertTender(testDb.db);
  bucket = memoryStorage();
});
afterAll(async () => {
  await testDb.close();
});

const MB = 1024 * 1024;
const sha = (c: string) => c.repeat(64);
const request = (name: string, c: string, size = 1_000, kind: UploadRequest["kind"] = "pdf"): UploadRequest => ({ name, size, sha256: sha(c), kind });

/** A stored file of the tender, as an upload leaves it. */
async function storedFile(c: string, size: number, fields: Partial<typeof documents.$inferInsert> = {}) {
  const path = storagePathFor(tenderId, sha(c), "pdf");
  bucket.files.set(path, new Uint8Array(1));
  return insertDocument(testDb.db, { tenderId, origin: "manual", filename: `${c}.pdf`, sizeBytes: size, sha256: sha(c), storagePath: path, fetchStatus: "fetched", ...fields });
}

describe("planUploads", () => {
  it("gives a one-time upload per new file and leaves out files the tender has", async () => {
    await storedFile("a", 1_000);

    const plans = await planUploads(testDb.db, bucket.storage, tenderId, [request("Şartname.pdf", "a"), request("Fiyat.xlsx", "b", 1_000, "xlsx"), request("Fiyat kopya.xlsx", "b", 1_000, "xlsx")]);

    expect(plans).toEqual([
      { name: "Şartname.pdf", status: "duplicate" },
      { name: "Fiyat.xlsx", status: "upload", path: `${tenderId}/${sha("b")}.xlsx`, token: `token-for-${tenderId}/${sha("b")}.xlsx` },
      { name: "Fiyat kopya.xlsx", status: "duplicate" },
    ]);
  });

  it("keeps a tender within 200 MB and all files within the storage limit", async () => {
    await storedFile("a", 150 * MB);
    const other = await insertTender(testDb.db);
    await insertDocument(testDb.db, { tenderId: other, origin: "manual", sizeBytes: 790 * MB, sha256: sha("z"), storagePath: `${other}/z.zip`, fetchStatus: "fetched" });

    // 940 MB stored, 150 of them this tender's.
    const plans = await planUploads(testDb.db, bucket.storage, tenderId, [request("b.pdf", "b", 20 * MB), request("c.pdf", "c", 60 * MB), request("d.pdf", "d", 5 * MB)]);

    expect(plans.map((p) => (p.status === "rejected" ? p.reason : p.status))).toEqual([
      "Dosya deposu dolu; eski ihalelerin dosyalarını silin.",
      "İhalenin dosya alanı (200 MB) doldu.",
      "upload",
    ]);
  });
});

describe("recordUploads", () => {
  it("records the files found in storage, once each, for the worker to read", async () => {
    const files = [request("Şartname.pdf", "a"), request("Kayıp.pdf", "b")];
    bucket.files.set(storagePathFor(tenderId, sha("a"), "pdf"), new Uint8Array(1));

    expect(await recordUploads(testDb.db, bucket.storage, tenderId, files)).toEqual({ added: 1, missing: [sha("b")], rejected: [] });
    expect(await recordUploads(testDb.db, bucket.storage, tenderId, files)).toEqual({ added: 0, missing: [sha("b")], rejected: [] });

    const rows = await testDb.db.select().from(documents).where(eq(documents.tenderId, tenderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: "manual",
      filename: "Şartname.pdf",
      mime: "application/pdf",
      sizeBytes: 1_000,
      fetchStatus: "fetched",
      storagePath: storagePathFor(tenderId, sha("a"), "pdf"),
      processedAt: null,
    });
  });
});

describe("recordUploads under the tender's limit", () => {
  it("checks the room again when recording, so two drops planned together cannot pass 200 MB", async () => {
    await storedFile("a", 190 * MB);
    // Both were planned while the tender had room, and both reached storage.
    const files = [request("b.pdf", "b", 8 * MB), request("c.pdf", "c", 8 * MB)];
    for (const file of files) bucket.files.set(storagePathFor(tenderId, file.sha256, "pdf"), new Uint8Array(1));

    const result = await recordUploads(testDb.db, bucket.storage, tenderId, files);

    expect(result).toEqual({ added: 1, missing: [], rejected: [{ sha256: sha("c"), reason: "İhalenin dosya alanı (200 MB) doldu." }] });
    expect(bucket.files.has(storagePathFor(tenderId, sha("c"), "pdf"))).toBe(false);
    expect(bucket.files.has(storagePathFor(tenderId, sha("b"), "pdf"))).toBe(true);
  });
});

describe("removeUpload", () => {
  it("deletes an uploaded ZIP with its members, and the objects nothing else uses", async () => {
    const zip = await storedFile("z", 3_000);
    const member = await storedFile("m", 1_000, { parentDocumentId: zip });
    await storedFile("n", 1_000, { parentDocumentId: member });
    // The notice's link answered with the same file as one of the members.
    await insertDocument(testDb.db, {
      tenderId,
      origin: "auto",
      sourceUrl: "https://buyer.example/m.pdf",
      sha256: sha("m"),
      storagePath: storagePathFor(tenderId, sha("m"), "pdf"),
      fetchStatus: "fetched",
    });

    expect(await removeUpload(testDb.db, bucket.storage, tenderId, zip)).toEqual({ ok: true });

    const left = await testDb.db.select({ origin: documents.origin, sha256: documents.sha256 }).from(documents);
    expect(left).toEqual([{ origin: "auto", sha256: sha("m") }]);
    expect([...bucket.files.keys()]).toEqual([storagePathFor(tenderId, sha("m"), "pdf")]);
  });

  it("keeps what came out of an uploaded ZIP when the notice's link has the same ZIP", async () => {
    const zip = await storedFile("z", 3_000, { mime: "application/zip" });
    const member = await storedFile("m", 1_000, { parentDocumentId: zip });
    const inner = await storedFile("n", 1_000, { parentDocumentId: member });
    const link = await insertDocument(testDb.db, {
      tenderId,
      origin: "auto",
      sourceUrl: "https://buyer.example/pack.zip",
      sha256: sha("z"),
      storagePath: storagePathFor(tenderId, sha("z"), "pdf"),
      fetchStatus: "fetched",
      processedAt: new Date(),
    });

    expect(await removeUpload(testDb.db, bucket.storage, tenderId, zip)).toEqual({ ok: true });

    const rows = await testDb.db.select({ id: documents.id, origin: documents.origin, parentId: documents.parentDocumentId }).from(documents);
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: link, origin: "auto", parentId: null },
        { id: member, origin: "auto", parentId: link },
        { id: inner, origin: "auto", parentId: member },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(bucket.files.size).toBe(3);
  });

  it("does not delete files from the notice's links, or files of another tender", async () => {
    const link = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://buyer.example/a.pdf" });
    const upload = await storedFile("a", 1_000);
    const other = await insertTender(testDb.db);

    expect(await removeUpload(testDb.db, bucket.storage, tenderId, link)).toEqual({ ok: false, error: "İlandan gelen dosyalar silinmez." });
    expect(await removeUpload(testDb.db, bucket.storage, other, upload)).toEqual({ ok: false, error: "Dosya bulunamadı; sayfayı yenileyin." });
    expect(await testDb.db.select().from(documents)).toHaveLength(2);
  });
});
