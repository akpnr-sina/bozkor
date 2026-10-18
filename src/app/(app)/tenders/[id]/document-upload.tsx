"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DOCUMENT_LIMITS } from "@/documents/limits";
import { KIND_MIME } from "@/documents/sniff";
import { UPLOAD_ACCEPT } from "@/documents/uploads";
import { completeUploads, prepareUploads } from "./document-actions";
import {
  createLimiter,
  FINISHED_ROW_MS,
  HASHES_AT_ONCE,
  isDone,
  NO_CRYPTO,
  ROW_LABELS,
  rowNote,
  toHex,
  UPLOADS_AT_ONCE,
  uploadFiles,
  type RowPatch,
  type RowStatus,
  type UploadDeps,
  type UploadRow,
} from "./document-upload-state";

// Manual upload on the tender page (SPEC Faz 5): files are dropped or picked,
// checked, hashed and uploaded straight to the bucket with the one-time
// tokens document-actions.ts hands out; the worker then reads them.

const MAX_MB = Math.round(DOCUMENT_LIMITS.fileBytes / 1024 / 1024);

const BADGE: Record<RowStatus, "outline" | "secondary" | "destructive"> = {
  preparing: "outline",
  uploading: "outline",
  uploaded: "secondary",
  duplicate: "secondary",
  error: "destructive",
};

let storage: SupabaseClient | null = null;

/** The browser's Supabase client; signed upload tokens need no session. */
function storageClient(): SupabaseClient {
  storage ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return storage;
}

async function sha256Hex(file: File): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export function DocumentUpload({ tenderId, disabledReason }: { tenderId: string; disabledReason: string | null }) {
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  // Shared by every drop, so the limits hold however many drops there are.
  const [limits] = useState(() => ({ uploads: createLimiter(UPLOADS_AT_ONCE), hashes: createLimiter(HASHES_AT_ONCE) }));
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    // A file dropped just outside the area would open in the tab and leave the page.
    const keep = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);

  if (disabledReason) return <p className="text-sm text-muted-foreground">{disabledReason}</p>;

  function update(id: string, patch: RowPatch) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    if (patch.status === "uploaded" || patch.status === "duplicate") {
      // The page lists the new file once the upload is recorded; the row has done its job.
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setRows((current) => current.filter((row) => row.id !== id));
      }, FINISHED_ROW_MS);
      timers.current.add(timer);
    }
  }

  function start(files: File[]) {
    if (!files.length) return;
    const items = files.map((file) => ({ id: `${Date.now()}-${nextId.current++}`, file }));
    setRows((current) => [...current, ...items.map(({ id, file }): UploadRow => ({ id, name: file.name, status: "preparing", reason: null }))]);
    if (!globalThis.crypto?.subtle) {
      for (const { id } of items) update(id, { status: "error", reason: NO_CRYPTO });
      return;
    }
    const deps: UploadDeps<File> = {
      hash: sha256Hex,
      prepare: (requests) => prepareUploads(tenderId, requests),
      upload: async (bucket, { path, token }, file, kind) => {
        const { error } = await storageClient().storage.from(bucket).uploadToSignedUrl(path, token, file, { contentType: KIND_MIME[kind] });
        return { error: error ? { message: error.message, statusCode: error.statusCode } : null };
      },
      complete: (uploaded) => completeUploads(tenderId, uploaded),
      ...limits,
      log: (message) => console.warn(message),
    };
    void uploadFiles(items, deps, update);
  }

  function onDragEnter(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current++;
    setDragging(true);
  }

  function onDragOver(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave() {
    // Leaving a child of the area fires too; only the last leave counts.
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }

  function onDrop(event: DragEvent) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    start([...event.dataTransfer.files]);
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div
        role="group"
        aria-label="Doküman yükleme"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors${dragging ? " border-primary bg-muted" : ""}`}
      >
        <p>Portaldan indirdiğiniz dosyaları buraya bırakın</p>
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
          Dosya seç
        </Button>
        <p className="text-xs text-muted-foreground">PDF, DOCX, XLSX ya da ZIP; dosya başına en fazla {MAX_MB} MB.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          hidden
          onChange={(event) => {
            start([...(event.target.files ?? [])]);
            // Picking the same file again must fire a change too.
            event.target.value = "";
          }}
        />
      </div>
      {/* Always there, so screen readers announce the first row too; hidden only to the eye while empty. */}
      <ul aria-live="polite" aria-label="Yüklenen dosyalar" className={rows.length ? "flex flex-col gap-2" : "sr-only"}>
        {rows.map((row) => {
          const note = rowNote(row);
          return (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium wrap-anywhere">{row.name}</span>
              <Badge variant={BADGE[row.status]}>{ROW_LABELS[row.status]}</Badge>
              {note && <span className={row.status === "error" ? "text-destructive" : "text-muted-foreground"}>{note}</span>}
            </li>
          );
        })}
      </ul>
      {rows.some(isDone) && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((row) => !isDone(row)))}>
            Listeyi temizle
          </Button>
        </div>
      )}
    </div>
  );
}
