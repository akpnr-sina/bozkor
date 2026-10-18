import type { DocumentStorage } from "@/documents/storage";

/**
 * Document storage in memory, recording uploads. `failUploads` and
 * `failDownloads` make the next calls throw, as an unreachable bucket would.
 */
export function memoryStorage() {
  const files = new Map<string, Uint8Array>();
  const uploads: string[] = [];
  const state = { failUploads: 0, failDownloads: 0 };
  const storage: DocumentStorage = {
    async upload(path, bytes) {
      if (state.failUploads > 0) {
        state.failUploads--;
        throw new Error("storage unavailable");
      }
      uploads.push(path);
      files.set(path, bytes);
    },
    async download(path) {
      if (state.failDownloads > 0) {
        state.failDownloads--;
        throw new Error("storage unavailable");
      }
      const file = files.get(path);
      if (!file) throw new Error(`no object at ${path}`);
      return file;
    },
    async remove(paths) {
      for (const path of paths) files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async signedUpload(path) {
      return { path, token: `token-for-${path}` };
    },
    async signedDownload(path, { filename, inline }) {
      return `https://storage.test/${path}${inline ? "" : `?download=${encodeURIComponent(filename ?? "")}`}`;
    },
  };
  return { storage, files, uploads, state };
}
