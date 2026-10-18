import type { FileKind } from "@/documents/types";
import {
  MAX_FILES_PER_UPLOAD,
  uploadKindOf,
  uploadProblem,
  type CompleteResult,
  type PrepareResult,
  type UploadedFile,
  type UploadRequest,
} from "@/documents/uploads";

// The steps of a manual upload, apart from the browser APIs so they can be
// tested: check each file, hash it, ask the server where it goes (at most
// MAX_FILES_PER_UPLOAD per request), upload it, then report what arrived.

export type RowStatus = "preparing" | "uploading" | "uploaded" | "duplicate" | "error";

/** One file of a drop or a pick, as the list shows it. */
export type UploadRow = { id: string; name: string; status: RowStatus; reason: string | null };

export type RowPatch = Pick<UploadRow, "status" | "reason">;

export const ROW_LABELS: Record<RowStatus, string> = {
  preparing: "Hazırlanıyor",
  uploading: "Yükleniyor",
  uploaded: "Yüklendi",
  duplicate: "Zaten var",
  error: "Hata",
};

/** The short line next to a row's status. */
export function rowNote(row: UploadRow): string | null {
  if (row.status === "uploaded") return "Yüklendi; okunması bir iki dakika sürer.";
  if (row.status === "duplicate") return "Bu dosya ihalede zaten var.";
  if (row.status === "error") return row.reason;
  return null;
}

/** Rows that are done; uploaded and duplicate ones leave the list after FINISHED_ROW_MS, errors stay until cleared. */
export const isDone = (row: UploadRow) => row.status === "uploaded" || row.status === "duplicate" || row.status === "error";
export const FINISHED_ROW_MS = 10_000;

/** Files uploaded at once, across drops. */
export const UPLOADS_AT_ONCE = 2;
/** Files read for hashing at once: each is held in memory while it is hashed. */
export const HASHES_AT_ONCE = 2;

export const NO_CRYPTO = "Tarayıcı dosyayı doğrulayamıyor; sayfayı https ile açın.";
const READ_FAILED = "Dosya okunamadı.";
const SERVER_UNREACHABLE = "Sunucuya ulaşılamadı; tekrar deneyin.";
const NO_ANSWER = "Sunucu bu dosya için yanıt vermedi; tekrar deneyin.";
const UPLOAD_LOST = "Bağlantı koptu, dosya yüklenemedi; tekrar deneyin.";
const MISSING = "Dosya depoda bulunamadı; tekrar yükleyin.";

/** Lowercase hex of a digest. */
export function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Limiter = { run<T>(task: () => Promise<T>): Promise<T> };

/** Runs at most `limit` tasks at once; the others wait their turn in order. */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run(task) {
      // A finished task hands its slot straight to the next in line, so a
      // newcomer cannot slip in between.
      if (active < limit) active++;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

export type StorageFailure = { message: string; statusCode?: string };

/** What a failed upload to storage means for the team. */
export function uploadFailure(error: StorageFailure): string | null {
  // Paths are content addressed: a file already at the path is this file.
  if (error.statusCode === "409" || /already exists|duplicate/i.test(error.message)) return null;
  if (error.statusCode === "413") return "Dosya deponun boyut sınırını aşıyor.";
  if (error.statusCode === "400" || error.statusCode === "401" || error.statusCode === "403") {
    return "Yükleme izni geçersiz ya da süresi doldu; tekrar deneyin.";
  }
  return "Depoya yüklenemedi; tekrar deneyin.";
}

export type UploadDeps<F> = {
  hash(file: F): Promise<string>;
  prepare(requests: UploadRequest[]): Promise<PrepareResult>;
  upload(bucket: string, target: { path: string; token: string }, file: F, kind: FileKind): Promise<{ error: StorageFailure | null }>;
  complete(files: UploadedFile[]): Promise<CompleteResult>;
  uploads: Limiter;
  hashes: Limiter;
  /** For failures the team does not need the detail of. */
  log?: (message: string) => void;
};

type Ready<F> = { id: string; file: F; request: UploadRequest };

/**
 * Takes files from "preparing" to "uploaded", "duplicate" or "error",
 * reporting each change. Never throws: a failed step becomes the reason of
 * the files it concerned.
 */
export async function uploadFiles<F extends { name: string; size: number }>(
  items: readonly { id: string; file: F }[],
  deps: UploadDeps<F>,
  update: (id: string, patch: RowPatch) => void,
): Promise<void> {
  const hashed = await Promise.all(
    items.map(async ({ id, file }): Promise<Ready<F> | null> => {
      const problem = uploadProblem(file);
      const kind = uploadKindOf(file.name);
      if (problem || !kind) {
        update(id, { status: "error", reason: problem ?? "Bu dosya türü yüklenmiyor." });
        return null;
      }
      try {
        const sha256 = await deps.hashes.run(() => deps.hash(file));
        return { id, file, request: { name: file.name, size: file.size, sha256, kind } };
      } catch (error) {
        deps.log?.(`[upload] ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        update(id, { status: "error", reason: READ_FAILED });
        return null;
      }
    }),
  );
  const ready = hashed.filter((entry): entry is Ready<F> => entry !== null);
  for (let i = 0; i < ready.length; i += MAX_FILES_PER_UPLOAD) {
    await uploadPart(ready.slice(i, i + MAX_FILES_PER_UPLOAD), deps, update);
  }
}

async function uploadPart<F>(part: Ready<F>[], deps: UploadDeps<F>, update: (id: string, patch: RowPatch) => void): Promise<void> {
  const failAll = (entries: Ready<F>[], reason: string) => entries.forEach((e) => update(e.id, { status: "error", reason }));
  let prepared: PrepareResult;
  try {
    prepared = await deps.prepare(part.map((e) => e.request));
  } catch (error) {
    deps.log?.(`[upload] prepare: ${error instanceof Error ? error.message : String(error)}`);
    prepared = { ok: false, error: SERVER_UNREACHABLE };
  }
  if (!prepared.ok) return failAll(part, prepared.error);
  const { bucket, plans } = prepared;

  // Plans come in the order the files were sent.
  const arrived = await Promise.all(
    part.map(async (entry, i): Promise<boolean> => {
      const plan = plans[i];
      if (!plan) {
        update(entry.id, { status: "error", reason: NO_ANSWER });
        return false;
      }
      if (plan.status === "duplicate") {
        update(entry.id, { status: "duplicate", reason: null });
        return false;
      }
      if (plan.status === "rejected") {
        update(entry.id, { status: "error", reason: plan.reason });
        return false;
      }
      const reason = await deps.uploads.run(async () => {
        update(entry.id, { status: "uploading", reason: null });
        try {
          const { error } = await deps.upload(bucket, plan, entry.file, entry.request.kind);
          if (error) deps.log?.(`[upload] ${entry.request.name}: ${error.statusCode ?? ""} ${error.message}`);
          return error ? uploadFailure(error) : null;
        } catch (error) {
          deps.log?.(`[upload] ${entry.request.name}: ${error instanceof Error ? error.message : String(error)}`);
          return UPLOAD_LOST;
        }
      });
      if (reason) update(entry.id, { status: "error", reason });
      return !reason;
    }),
  );
  const uploaded = part.filter((_, i) => arrived[i]);
  if (!uploaded.length) return;

  let completed: CompleteResult;
  try {
    completed = await deps.complete(uploaded.map((e) => e.request));
  } catch (error) {
    deps.log?.(`[upload] complete: ${error instanceof Error ? error.message : String(error)}`);
    completed = { ok: false, error: SERVER_UNREACHABLE };
  }
  if (!completed.ok) return failAll(uploaded, completed.error);
  // By content: the server may clean names, and two files can share one.
  // Rejected files reached storage but no longer fit the tender's or the bucket's limit.
  const missing = new Set(completed.missing);
  const rejected = new Map(completed.rejected.map((r) => [r.sha256, r.reason]));
  for (const entry of uploaded) {
    const sha = entry.request.sha256;
    const reason = missing.has(sha) ? MISSING : (rejected.get(sha) ?? null);
    update(entry.id, reason ? { status: "error", reason } : { status: "uploaded", reason: null });
  }
}
