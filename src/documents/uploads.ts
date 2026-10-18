import { DOCUMENT_LIMITS } from "./limits";
import { KIND_EXTENSION } from "./sniff";
import type { FileKind } from "./types";

// What the browser and the server agree on for manual uploads (SPEC Faz 5).
// The browser hashes each file and asks where to put it; the server answers
// with a one-time upload token per file, the browser uploads straight to the
// bucket, and the server records the files that arrived. The worker then
// reads them (and checks their content against the hash).

/** Extensions accepted for upload, by the kind they claim; the worker checks the content. */
const UPLOAD_EXTENSIONS: Record<string, FileKind> = { pdf: "pdf", docx: "docx", xlsx: "xlsx", zip: "zip" };

/** For the file input's accept attribute. */
export const UPLOAD_ACCEPT = ".pdf,.docx,.xlsx,.zip";

/** Files sent in one request. */
export const MAX_FILES_PER_UPLOAD = 50;

const extensionOf = (filename: string) => /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? "";

export function uploadKindOf(filename: string): FileKind | null {
  return UPLOAD_EXTENSIONS[extensionOf(filename)] ?? null;
}

/**
 * The name the server keeps: the last part of a path, without control
 * characters, at most 200 characters with its extension. Never rejected,
 * so one odd name does not fail the files sent with it.
 */
export function cleanUploadName(name: string, kind: FileKind): string {
  const base = name.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).at(-1)!.trim();
  if (!base) return `dosya${KIND_EXTENSION[kind]}`;
  if (base.length <= 200) return base;
  const ext = /\.[^.]{1,10}$/.exec(base)?.[0] ?? "";
  return base.slice(0, 200 - ext.length) + ext;
}

/** Why a file cannot be uploaded, told before any request; null when it can be. */
export function uploadProblem(file: { name: string; size: number }): string | null {
  const ext = extensionOf(file.name);
  if (ext === "doc" || ext === "xls") return "Eski Word ve Excel dosyaları okunmuyor; Word ya da Excel'de .docx ya da .xlsx olarak kaydedip yükleyin.";
  if (!uploadKindOf(file.name)) return "Sadece PDF, DOCX, XLSX ve ZIP dosyaları yüklenir.";
  if (file.size === 0) return "Dosya boş.";
  if (file.size > DOCUMENT_LIMITS.fileBytes) return "Dosya 50 MB sınırından büyük.";
  return null;
}

/** A file the browser wants to upload: its name, size, SHA-256 (hex) and the kind its extension claims. */
export type UploadRequest = { name: string; size: number; sha256: string; kind: FileKind };

/** What to do with one file; plans come in the order the files were sent. */
export type UploadPlan =
  /** Upload it with supabase-js `storage.from(bucket).uploadToSignedUrl(path, token, file)`. */
  | { name: string; status: "upload"; path: string; token: string }
  /** The tender already has this file (same content); nothing to do. */
  | { name: string; status: "duplicate" }
  | { name: string; status: "rejected"; reason: string };

export type PrepareResult = { ok: true; bucket: string; plans: UploadPlan[] } | { ok: false; error: string };

/** A file that reached storage, sent back as it was in its UploadRequest. */
export type UploadedFile = UploadRequest;

/**
 * `missing`: SHA-256 of the files not found in storage. `rejected`: files
 * that arrived but no longer fit the tender's or the storage's limit (another
 * upload took the room meanwhile); they are removed again. Neither is recorded.
 */
export type CompleteResult =
  | { ok: true; added: number; missing: string[]; rejected: { sha256: string; reason: string }[] }
  | { ok: false; error: string };

export type DeleteResult = { ok: true } | { ok: false; error: string };
