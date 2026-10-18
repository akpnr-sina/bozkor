import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { documents, tenders } from "@/db/schema";
import { DOCUMENT_LIMITS } from "./limits";
import { markDocumentsChanged, storedBytes } from "./queries";
import { KIND_MIME } from "./sniff";
import { type DocumentStorage, storagePathFor } from "./storage";
import type { UploadedFile, UploadPlan, UploadRequest } from "./uploads";

// Manual uploads and their removal (SPEC Faz 5), behind the server actions of
// the tender page. The browser uploads straight to the bucket with a one-time
// token per file, so files never pass through the web server.

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export async function tenderExists(db: AppDb, tenderId: string): Promise<boolean> {
  const [tender] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.id, tenderId));
  return Boolean(tender);
}

/** Says for each file whether to upload it, with a one-time upload token, or why not; in the order given. */
export async function planUploads(db: AppDb, storage: DocumentStorage, tenderId: string, files: UploadRequest[]): Promise<UploadPlan[]> {
  const known = await db
    .select({ sha256: documents.sha256 })
    .from(documents)
    .where(and(eq(documents.tenderId, tenderId), inArray(documents.sha256, files.map((f) => f.sha256))));
  const seen = new Set(known.map((row) => row.sha256));
  let tenderBytes = await storedBytes(db, tenderId);
  let totalBytes = await storedBytes(db);

  const plans: UploadPlan[] = [];
  for (const file of files) {
    if (seen.has(file.sha256)) {
      plans.push({ name: file.name, status: "duplicate" });
      continue;
    }
    if (tenderBytes + file.size > DOCUMENT_LIMITS.tenderBytes) {
      plans.push({ name: file.name, status: "rejected", reason: `İhalenin dosya alanı (${megabytes(DOCUMENT_LIMITS.tenderBytes)}) doldu.` });
      continue;
    }
    if (totalBytes + file.size > DOCUMENT_LIMITS.totalBytes) {
      plans.push({ name: file.name, status: "rejected", reason: "Dosya deposu dolu; eski ihalelerin dosyalarını silin." });
      continue;
    }
    try {
      const { path, token } = await storage.signedUpload(storagePathFor(tenderId, file.sha256, file.kind));
      plans.push({ name: file.name, status: "upload", path, token });
    } catch (error) {
      console.warn(`[documents] ${error instanceof Error ? error.message : String(error)}`);
      plans.push({ name: file.name, status: "rejected", reason: "Yükleme adresi alınamadı; biraz sonra tekrar deneyin." });
      continue;
    }
    seen.add(file.sha256);
    tenderBytes += file.size;
    totalBytes += file.size;
  }
  return plans;
}

/** Two numbers for pg_advisory_xact_lock: this one and the tender's hash, so one tender's uploads are recorded one at a time. */
const UPLOAD_LOCK = 7301102;

/**
 * Records the files that reached storage; the worker reads them within a
 * minute or two. The limits are checked again under the tender's lock: two
 * drops planned together could otherwise both take the last room.
 */
export async function recordUploads(
  db: AppDb,
  storage: DocumentStorage,
  tenderId: string,
  files: UploadedFile[],
): Promise<{ added: number; missing: string[]; rejected: { sha256: string; reason: string }[] }> {
  const missing: string[] = [];
  const arrived: UploadedFile[] = [];
  for (const file of files) {
    if (await storage.exists(storagePathFor(tenderId, file.sha256, file.kind))) arrived.push(file);
    else missing.push(file.sha256);
  }
  const rejected: { sha256: string; reason: string }[] = [];
  let added = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${UPLOAD_LOCK}, hashtext(${tenderId}))`);
    let tenderBytes = await storedBytes(tx, tenderId);
    let totalBytes = await storedBytes(tx);
    for (const file of arrived) {
      // A second click, or the same file twice in one drop: recorded once.
      const [known] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.tenderId, tenderId), eq(documents.sha256, file.sha256)))
        .limit(1);
      if (known) continue;
      const reason =
        tenderBytes + file.size > DOCUMENT_LIMITS.tenderBytes
          ? `İhalenin dosya alanı (${megabytes(DOCUMENT_LIMITS.tenderBytes)}) doldu.`
          : totalBytes + file.size > DOCUMENT_LIMITS.totalBytes
            ? "Dosya deposu dolu; eski ihalelerin dosyalarını silin."
            : null;
      if (reason) {
        rejected.push({ sha256: file.sha256, reason });
        continue;
      }
      await tx.insert(documents).values({
        tenderId,
        origin: "manual",
        filename: file.name,
        mime: KIND_MIME[file.kind],
        sizeBytes: file.size,
        sha256: file.sha256,
        storagePath: storagePathFor(tenderId, file.sha256, file.kind),
        fetchStatus: "fetched",
      });
      tenderBytes += file.size;
      totalBytes += file.size;
      added++;
    }
  });
  const kinds = new Map(files.map((f) => [f.sha256, f.kind]));
  await removeUnused(db, storage, rejected.map((r) => storagePathFor(tenderId, r.sha256, kinds.get(r.sha256)!)));
  return { added, missing, rejected };
}

/** Rows of a raw query: an array from postgres-js, `{ rows }` from PGlite. */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * Removes the stored objects no document uses, looked up right before: a
 * row added meanwhile (the same file uploaded or fetched again) keeps its object.
 */
async function removeUnused(db: AppDb, storage: DocumentStorage, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const used = await db.select({ path: documents.storagePath }).from(documents).where(inArray(documents.storagePath, paths));
  const stillUsed = new Set(used.map((row) => row.path));
  const unused = [...new Set(paths)].filter((path) => !stillUsed.has(path));
  if (!unused.length) return;
  try {
    await storage.remove(unused);
  } catch (error) {
    // A leftover object only takes space, and an upload of the same file replaces it.
    console.warn(`[documents] ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Deletes an uploaded file, with the members of a ZIP, and the stored
 * objects no other document uses. Files from the notice's links stay. When
 * another document has the same content (the notice's link answered with the
 * uploaded ZIP), what came out of the ZIP moves to it instead of going.
 */
export async function removeUpload(
  db: AppDb,
  storage: DocumentStorage,
  tenderId: string,
  documentId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const outcome = await db.transaction(async (tx): Promise<{ ok: false; error: string } | { ok: true; paths: string[] }> => {
    const [doc] = await tx
      .select({ origin: documents.origin, storagePath: documents.storagePath })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.tenderId, tenderId)))
      .for("update");
    if (!doc) return { ok: false, error: "Dosya bulunamadı; sayfayı yenileyin." };
    if (doc.origin !== "manual") return { ok: false, error: "İlandan gelen dosyalar silinmez." };
    const [heir] = doc.storagePath
      ? await tx
          .select({ id: documents.id, origin: documents.origin })
          .from(documents)
          .where(and(eq(documents.tenderId, tenderId), eq(documents.storagePath, doc.storagePath), ne(documents.id, documentId)))
          .orderBy(desc(sql`${documents.origin} = 'auto'`), asc(documents.createdAt))
          .limit(1)
      : [];
    if (heir) {
      // Members take their ZIP's origin, all the way down.
      await tx.execute(sql`
        with recursive family as (
          select id from ${documents} where parent_document_id = ${documentId}
          union all
          select d.id from ${documents} d join family f on d.parent_document_id = f.id
        )
        update ${documents} set origin = ${heir.origin} where id in (select id from family)`);
      await tx.update(documents).set({ parentDocumentId: heir.id }).where(eq(documents.parentDocumentId, documentId));
    }
    // The file and everything that came out of it (nothing, when it moved).
    const family = await tx.execute(sql`
      with recursive family as (
        select id, storage_path from ${documents} where id = ${documentId}
        union all
        select d.id, d.storage_path from ${documents} d join family f on d.parent_document_id = f.id
      )
      select storage_path from family where storage_path is not null`);
    await tx.delete(documents).where(eq(documents.id, documentId));
    return { ok: true, paths: rowsOf<{ storage_path: string }>(family).map((row) => row.storage_path) };
  });
  if (!outcome.ok) return outcome;
  await removeUnused(db, storage, outcome.paths);
  await markDocumentsChanged(db, tenderId);
  return { ok: true };
}
