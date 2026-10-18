"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/db";
import { DOCUMENT_LIMITS } from "@/documents/limits";
import { planUploads, recordUploads, removeUpload, tenderExists } from "@/documents/manual";
import { createDocumentStorage, storageConfigured } from "@/documents/storage";
import {
  cleanUploadName,
  type CompleteResult,
  type DeleteResult,
  MAX_FILES_PER_UPLOAD,
  type PrepareResult,
  type UploadedFile,
  type UploadRequest,
} from "@/documents/uploads";
import { requireEnv } from "@/lib/env";
import { requireUser } from "@/lib/auth/session";

// Server actions for manual uploads (SPEC Faz 5); the work is in src/documents/manual.ts.

const fileSchema = z
  .object({
    name: z.string(),
    size: z.number().int().positive().max(DOCUMENT_LIMITS.fileBytes),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["pdf", "docx", "xlsx", "zip"]),
  })
  // An odd name is cleaned, not rejected, so it does not fail the files sent with it.
  .transform((file) => ({ ...file, name: cleanUploadName(file.name, file.kind) }));
const filesSchema = z.object({ tenderId: z.uuid(), files: z.array(fileSchema).min(1).max(MAX_FILES_PER_UPLOAD) });

const INVALID = "Geçersiz istek. Sayfayı yenileyip tekrar deneyin.";
const NO_STORAGE = "Dosya deposu ayarlı değil (SUPABASE_SECRET_KEY, SUPABASE_STORAGE_BUCKET).";

/** Says for each file whether to upload it, with a one-time upload token, or why not. */
export async function prepareUploads(tenderId: string, files: UploadRequest[]): Promise<PrepareResult> {
  await requireUser();
  if (!storageConfigured()) return { ok: false, error: NO_STORAGE };
  const parsed = filesSchema.safeParse({ tenderId, files });
  if (!parsed.success) return { ok: false, error: INVALID };
  const db = getDb();
  if (!(await tenderExists(db, parsed.data.tenderId))) return { ok: false, error: "İhale bulunamadı." };
  const plans = await planUploads(db, createDocumentStorage(), parsed.data.tenderId, parsed.data.files);
  return { ok: true, bucket: requireEnv("SUPABASE_STORAGE_BUCKET"), plans };
}

/** Records the files that reached storage; the worker reads them within a minute or two. */
export async function completeUploads(tenderId: string, files: UploadedFile[]): Promise<CompleteResult> {
  await requireUser();
  if (!storageConfigured()) return { ok: false, error: NO_STORAGE };
  const parsed = filesSchema.safeParse({ tenderId, files });
  if (!parsed.success) return { ok: false, error: INVALID };
  const db = getDb();
  if (!(await tenderExists(db, parsed.data.tenderId))) return { ok: false, error: "İhale bulunamadı." };
  const { added, missing, rejected } = await recordUploads(db, createDocumentStorage(), parsed.data.tenderId, parsed.data.files);
  if (added) refresh();
  return { ok: true, added, missing, rejected };
}

/** Deletes an uploaded file (with a ZIP's members) and the stored objects nothing else uses. */
export async function deleteDocument(tenderId: string, documentId: string): Promise<DeleteResult> {
  await requireUser();
  // Without storage the rows would go and the objects stay, uncounted.
  if (!storageConfigured()) return { ok: false, error: NO_STORAGE };
  const parsed = z.object({ tenderId: z.uuid(), documentId: z.uuid() }).safeParse({ tenderId, documentId });
  if (!parsed.success) return { ok: false, error: INVALID };
  const result = await removeUpload(getDb(), createDocumentStorage(), parsed.data.tenderId, parsed.data.documentId);
  if (result.ok) refresh();
  return result;
}
