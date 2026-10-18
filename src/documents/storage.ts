import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "@/lib/env";
import { KIND_EXTENSION } from "./sniff";
import type { FileKind } from "./types";

// Tender documents in a private Supabase Storage bucket (SUPABASE_STORAGE_BUCKET),
// reached with the secret key from the server and the worker only. Browsers
// upload with a one-time signed URL and download with a short-lived one.

/** The part of the Supabase Storage client used here; tests pass a fake. */
export type StorageBucket = {
  upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): Promise<{ error: { message: string; statusCode?: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
  exists(path: string): Promise<{ data: boolean; error: { message: string } | null }>;
  createSignedUploadUrl(path: string, options: { upsert: boolean }): Promise<{ data: { path: string; token: string } | null; error: { message: string } | null }>;
  createSignedUrl(path: string, expiresIn: number, options?: { download?: string | boolean }): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
};

export type DocumentStorage = {
  /** Stores a file; one already at the path counts as stored (paths are content addressed). */
  upload(path: string, bytes: Uint8Array, mime: string): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  remove(paths: string[]): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** For a browser upload: the path and a one-time token for it. An object already there is replaced (same content, as paths are content addressed). */
  signedUpload(path: string): Promise<{ path: string; token: string }>;
  /** A link to the file for `seconds` (default 120): shown in the browser when `inline`, otherwise downloaded under `filename`. */
  signedDownload(path: string, options: { filename: string | null; inline?: boolean; seconds?: number }): Promise<string>;
};

/**
 * Where a file of a tender is stored: by its SHA-256, so the same file is
 * kept once per tender however many times it is fetched or uploaded.
 */
export function storagePathFor(tenderId: string, sha256: string, kind: FileKind | null): string {
  return `${tenderId}/${sha256}${kind ? KIND_EXTENSION[kind] : ""}`;
}

/** A failed upload because the path is taken: the same content is already there. */
const alreadyExists = (error: { message: string; statusCode?: string }) =>
  error.statusCode === "409" || /already exists|duplicate/i.test(error.message);

export function documentStorage(bucket: StorageBucket): DocumentStorage {
  return {
    async upload(path, bytes, mime) {
      const { error } = await bucket.upload(path, bytes, { contentType: mime, upsert: false });
      if (error && !alreadyExists(error)) throw new Error(`Dosya depoya yazılamadı (${path}): ${error.message}`);
    },
    async download(path) {
      const { data, error } = await bucket.download(path);
      if (error || !data) throw new Error(`Dosya depodan okunamadı (${path}): ${error?.message ?? "boş yanıt"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(paths) {
      if (!paths.length) return;
      const { error } = await bucket.remove(paths);
      if (error) throw new Error(`Dosya depodan silinemedi: ${error.message}`);
    },
    async exists(path) {
      const { data, error } = await bucket.exists(path);
      // A missing object comes back as an error too.
      return !error && data;
    },
    async signedUpload(path) {
      const { data, error } = await bucket.createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(`Yükleme adresi alınamadı: ${error?.message ?? "boş yanıt"}`);
      return { path: data.path, token: data.token };
    },
    async signedDownload(path, { filename, inline = false, seconds = 120 }) {
      const { data, error } = await bucket.createSignedUrl(path, seconds, inline ? undefined : { download: filename ?? true });
      if (error || !data) throw new Error(`İndirme adresi alınamadı: ${error?.message ?? "boş yanıt"}`);
      return data.signedUrl;
    },
  };
}

/** True when the environment has what storage needs; the worker skips document jobs otherwise. */
export function storageConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.SUPABASE_STORAGE_BUCKET);
}

/** Browser uploads also need the publishable key, which the page's Supabase client uses. */
export function uploadsConfigured(): boolean {
  return storageConfigured() && Boolean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

/** The documents bucket with the secret key (server and worker only). */
export function createDocumentStorage(): DocumentStorage {
  const client = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return documentStorage(client.storage.from(requireEnv("SUPABASE_STORAGE_BUCKET")) as unknown as StorageBucket);
}
