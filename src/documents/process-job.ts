import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AppDb } from "@/db";
import { documents, type Document } from "@/db/schema";
import { CLAIM_MINUTES, errorMessage, MAX_ATTEMPTS, sha256Of } from "./fetch-job";
import { DOCUMENT_LIMITS } from "./limits";
import { markDocumentsChanged, storedBytes } from "./queries";
import { KIND_MIME, sniffKind } from "./sniff";
import { type DocumentStorage, storagePathFor } from "./storage";
import type { Extracted, FileKind } from "./types";

// Reads stored files (SPEC Faz 5): PDF page counts and text, DOCX and XLSX
// text, ZIP members stored as files of their own. Fetched and uploaded files
// go the same way, uploads first. A ZIP inside a ZIP is opened, one deeper is
// not. Errors (storage, or anything unforeseen) are retried a few times,
// minutes apart, then recorded, so no file is read forever.

export type ProcessDeps = {
  extract: (bytes: Uint8Array, kind: FileKind) => Promise<Extracted>;
  storage: DocumentStorage;
  log?: (message: string) => void;
};

export type ProcessStats = {
  processed: number;
  members: number;
  skipped: number;
  failed: number;
  /** Storage failed; the run stopped, since the next files would fail too. */
  stoppedBy: "storage" | null;
};

/** ZIPs a file may sit in and still be opened when it is a ZIP itself. */
const MAX_ZIP_DEPTH = 1;
const RETRY_MINUTES = 10;

/** Postgres refuses NUL in text; extraction drops it already, this keeps any other reader safe too. */
const withoutNul = (text: string) => text.replaceAll("\u0000", "");

/** How many ZIPs a file sits in. */
async function zipDepth(db: AppDb, doc: Document): Promise<number> {
  let depth = 0;
  let parentId = doc.parentDocumentId;
  while (parentId && depth <= MAX_ZIP_DEPTH) {
    depth++;
    const [parent] = await db.select({ parentDocumentId: documents.parentDocumentId }).from(documents).where(eq(documents.id, parentId));
    parentId = parent?.parentDocumentId ?? null;
  }
  return depth;
}

class StorageFailure extends Error {}

/** Members left out of a ZIP that nobody misses: folders and the litter of operating systems. */
const LITTER = new Set(["klasör", "macOS ek dosyası", "sistem dosyası", "gizli dosya"]);

/** Stores the members of a ZIP as documents of their own; returns what was left out. */
async function storeMembers(db: AppDb, deps: ProcessDeps, zip: Document, extracted: Extract<Extracted, { kind: "zip" }>) {
  const skipped = extracted.skipped.filter((s) => !LITTER.has(s.reason)).map((s) => withoutNul(`${s.name}: ${s.reason}`));
  let members = 0;
  for (const entry of extracted.entries) {
    const name = withoutNul(entry.name);
    const sha = sha256Of(entry.bytes);
    const [existing] = await db
      .select({ parentDocumentId: documents.parentDocumentId })
      .from(documents)
      .where(and(eq(documents.tenderId, zip.tenderId), eq(documents.sha256, sha)))
      .limit(1);
    if (existing) {
      // Stored by an earlier, interrupted run over this ZIP: nothing to say.
      if (existing.parentDocumentId !== zip.id) skipped.push(`${name}: aynı dosya zaten var`);
      continue;
    }
    const kind = sniffKind(entry.bytes, name);
    const problem =
      kind === null
        ? "Okunmayan dosya türü."
        : entry.bytes.length > DOCUMENT_LIMITS.fileBytes
          ? "Dosya 50 MB sınırından büyük; portaldan indirilmeli."
          : (await storedBytes(db, zip.tenderId)) + entry.bytes.length > DOCUMENT_LIMITS.tenderBytes
            ? "İhalenin dosya alanı (200 MB) doldu."
            : (await storedBytes(db)) + entry.bytes.length > DOCUMENT_LIMITS.totalBytes
              ? "Dosya deposu dolu; eski ihalelerin dosyalarını silin."
              : null;
    const path = kind && !problem ? storagePathFor(zip.tenderId, sha, kind) : null;
    if (path) {
      try {
        await deps.storage.upload(path, entry.bytes, KIND_MIME[kind!]);
      } catch (error) {
        throw new StorageFailure(errorMessage(error));
      }
    }
    await db.insert(documents).values({
      tenderId: zip.tenderId,
      origin: zip.origin,
      parentDocumentId: zip.id,
      filename: name,
      mime: kind ? KIND_MIME[kind] : null,
      sizeBytes: entry.bytes.length,
      sha256: sha,
      storagePath: path,
      fetchStatus: kind === null ? "unsupported" : problem ? "failed" : "fetched",
      fetchError: problem,
      // Members kept out of storage have nothing to read.
      processedAt: path ? null : sql`now()`,
    });
    members++;
  }
  return { members, skipped };
}

const skippedNote = (skipped: string[]) =>
  skipped.length ? `Alınmayan: ${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? ` ve ${skipped.length - 5} dosya daha` : ""}` : null;

/** What reading one file came to; "stop" ends the run (storage is failing). */
type Outcome = "processed" | "skipped" | "failed" | "stop";

/** Counts a failed attempt: the file is tried again minutes later, or recorded as unreadable after a few. */
async function retryLater(db: AppDb, doc: Document, retryNote: string, finalError: string) {
  const attempts = doc.fetchAttempts + 1;
  await db
    .update(documents)
    .set(
      attempts >= MAX_ATTEMPTS
        ? { fetchAttempts: 0, retryAt: null, processedAt: sql`now()`, fetchError: finalError, updatedAt: sql`now()` }
        : { fetchAttempts: attempts, retryAt: sql`now() + make_interval(mins => ${RETRY_MINUTES})`, fetchError: retryNote, updatedAt: sql`now()` },
    )
    .where(eq(documents.id, doc.id));
}

async function processOne(db: AppDb, deps: ProcessDeps, doc: Document, stats: ProcessStats): Promise<Outcome> {
  const log = deps.log ?? (() => {});
  const done = (fields: PgUpdateSetSource<typeof documents>) =>
    db
      .update(documents)
      .set({ ...fields, fetchAttempts: 0, retryAt: null, processedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(documents.id, doc.id));
  const storageFailed = async (error: unknown, finalError: string): Promise<Outcome> => {
    log(`[documents] ${doc.id}: ${errorMessage(error)}`);
    await retryLater(db, doc, "Dosya depodan okunamadı; birkaç dakika sonra yeniden denenecek.", finalError);
    return "stop";
  };

  let bytes: Uint8Array;
  try {
    bytes = await deps.storage.download(doc.storagePath!);
  } catch (error) {
    return storageFailed(error, "Depodaki dosya okunamadı; yeniden yükleyin.");
  }
  if (doc.sha256 && sha256Of(bytes) !== doc.sha256) {
    await done({ fetchStatus: "failed", fetchError: "Dosya depoya bozuk ulaşmış; yeniden yükleyin." });
    return "failed";
  }
  // The size of what is stored, whatever the browser said.
  const finish = (fields: PgUpdateSetSource<typeof documents>) => done({ sizeBytes: bytes.length, ...fields });
  const kind = sniffKind(bytes, doc.filename);
  if (!kind) {
    await finish({ fetchStatus: "unsupported", fetchError: "Okunmayan dosya türü." });
    return "skipped";
  }
  let extracted: Extracted;
  try {
    extracted = await deps.extract(bytes, kind);
  } catch (error) {
    extracted = { kind: "failed", error: errorMessage(error) };
  }

  switch (extracted.kind) {
    case "pdf":
      await finish({
        pageCount: extracted.pageCount,
        textContent: withoutNul(extracted.text),
        textTruncated: extracted.truncated,
        // Still read by the model page by page; only its quotes cannot be checked.
        fetchError: extracted.pageCount > 0 && !extracted.text.trim() ? "PDF'te metin yok; taranmış olabilir, alıntılar doğrulanamaz." : null,
      });
      // New text for the analysis: the tender's facts are extracted again. A PDF without text changes nothing they read.
      if (extracted.text.trim()) await markDocumentsChanged(db, doc.tenderId);
      return "processed";
    case "docx":
    case "xlsx":
      await finish({ textContent: withoutNul(extracted.text), textTruncated: extracted.truncated, fetchError: null });
      if (extracted.text.trim()) await markDocumentsChanged(db, doc.tenderId);
      return "processed";
    case "zip": {
      if ((await zipDepth(db, doc)) > MAX_ZIP_DEPTH) {
        await finish({ fetchError: "ZIP içinde ZIP içinde ZIP; bu katman açılmadı, içindeki dosyaları ayrıca yükleyin." });
        return "skipped";
      }
      try {
        const { members, skipped } = await storeMembers(db, deps, doc, extracted);
        stats.members += members;
        await finish({ fetchError: skippedNote(skipped) });
        return "processed";
      } catch (error) {
        if (!(error instanceof StorageFailure)) throw error;
        return storageFailed(error, "ZIP'teki dosyaların bir kısmı depoya yazılamadı; ZIP'i açıp dosyaları ayrıca yükleyin.");
      }
    }
    case "unsupported":
      await finish({ fetchStatus: "unsupported", fetchError: withoutNul(extracted.reason) });
      return "skipped";
    case "failed":
      await finish({ fetchError: `Okunamadı: ${withoutNul(extracted.error)}` });
      return "failed";
  }
}

export async function processDocuments(db: AppDb, deps: ProcessDeps, options: { limit?: number } = {}): Promise<ProcessStats> {
  const stats: ProcessStats = { processed: 0, members: 0, skipped: 0, failed: 0, stoppedBy: null };
  const log = deps.log ?? (() => {});
  const rows = await db
    .select()
    .from(documents)
    .where(and(isNotNull(documents.storagePath), isNull(documents.processedAt), sql`(${documents.retryAt} is null or ${documents.retryAt} <= now())`))
    // Someone who just uploaded is waiting for it.
    .orderBy(desc(sql`${documents.origin} = 'manual'`), asc(documents.createdAt), asc(documents.id))
    .limit(options.limit ?? 20);

  for (const doc of rows) {
    // See CLAIM_MINUTES: a second run leaves a file being read alone.
    const [claimed] = await db
      .update(documents)
      .set({ retryAt: sql`now() + make_interval(mins => ${CLAIM_MINUTES})` })
      .where(and(eq(documents.id, doc.id), isNull(documents.processedAt), sql`(${documents.retryAt} is null or ${documents.retryAt} <= now())`))
      .returning({ id: documents.id });
    if (!claimed) continue;

    let outcome: Outcome;
    try {
      outcome = await processOne(db, deps, doc, stats);
    } catch (error) {
      // Unforeseen (a database error, say): counted like a storage error, so the file cannot come round forever.
      log(`[documents] ${doc.id}: ${errorMessage(error)}`);
      try {
        await retryLater(db, doc, "Okunurken beklenmeyen bir hata oldu; birkaç dakika sonra yeniden denenecek.", "Okunamadı: beklenmeyen bir hata oldu.");
      } catch {
        // The database itself is gone; the claim runs out and the next run tries again.
        stats.failed++;
        break;
      }
      outcome = "failed";
    }
    if (outcome === "stop") {
      stats.failed++;
      stats.stoppedBy = "storage";
      break;
    }
    stats[outcome]++;
  }
  return stats;
}
