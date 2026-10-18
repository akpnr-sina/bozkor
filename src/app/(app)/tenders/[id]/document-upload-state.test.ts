import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_FILES_PER_UPLOAD, type CompleteResult, type PrepareResult, type UploadPlan, type UploadRequest } from "@/documents/uploads";
import {
  createLimiter,
  isDone,
  rowNote,
  toHex,
  UPLOADS_AT_ONCE,
  uploadFailure,
  uploadFiles,
  type RowPatch,
  type StorageFailure,
  type UploadDeps,
} from "./document-upload-state";

/** A file as the flow sees it; `content` stands in for its bytes (two files may share a name). */
type TestFile = { name: string; size: number; content?: string };

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const file = (name: string, size = 1_000, content?: string): TestFile => ({ name, size, content });

/** Fake server and storage that record every call; by default every file is uploaded and recorded. */
function harness(
  options: {
    plan?: (request: UploadRequest, index: number) => UploadPlan;
    prepare?: (requests: UploadRequest[]) => Promise<PrepareResult>;
    upload?: (file: TestFile) => Promise<{ error: StorageFailure | null }>;
    complete?: (files: UploadRequest[]) => Promise<CompleteResult>;
    hash?: (file: TestFile) => Promise<string>;
  } = {},
) {
  const calls = { prepare: [] as UploadRequest[][], upload: [] as { bucket: string; path: string; token: string; name: string; kind: string }[], complete: [] as UploadRequest[][] };
  const updates: Record<string, RowPatch[]> = {};
  const deps: UploadDeps<TestFile> = {
    hash: options.hash ?? (async (f) => sha(f.content ?? f.name)),
    prepare: async (requests) => {
      calls.prepare.push(requests);
      if (options.prepare) return options.prepare(requests);
      const plan = options.plan ?? ((r: UploadRequest) => ({ name: r.name, status: "upload" as const, path: `t/${r.sha256}`, token: `token-${r.name}` }));
      return { ok: true, bucket: "documents", plans: requests.map(plan) };
    },
    upload: async (bucket, { path, token }, f, kind) => {
      calls.upload.push({ bucket, path, token, name: f.name, kind });
      return options.upload ? options.upload(f) : { error: null };
    },
    complete: async (files) => {
      calls.complete.push(files);
      return options.complete ? options.complete(files) : { ok: true, added: files.length, missing: [], rejected: [] };
    },
    uploads: createLimiter(UPLOADS_AT_ONCE),
    hashes: createLimiter(2),
  };
  const run = (files: TestFile[]) =>
    uploadFiles(
      files.map((f, i) => ({ id: String(i), file: f })),
      deps,
      (id, patch) => (updates[id] ??= []).push(patch),
    );
  const final = (id: number) => updates[String(id)]?.at(-1);
  return { calls, updates, run, final };
}

describe("uploadFiles", () => {
  it("tells the problem of a file before any request, and sends only the others", async () => {
    const h = harness();
    await h.run([file("Teknik Şartname.doc"), file("bos.pdf", 0), file("plan.png"), file("Teknik Şartname.pdf")]);
    expect(h.final(0)).toEqual({ status: "error", reason: expect.stringContaining(".docx") });
    expect(h.final(1)).toEqual({ status: "error", reason: "Dosya boş." });
    expect(h.final(2)).toEqual({ status: "error", reason: "Sadece PDF, DOCX, XLSX ve ZIP dosyaları yüklenir." });
    expect(h.calls.prepare).toEqual([[{ name: "Teknik Şartname.pdf", size: 1_000, sha256: sha("Teknik Şartname.pdf"), kind: "pdf" }]]);
    expect(h.final(3)).toEqual({ status: "uploaded", reason: null });
  });

  it("uploads, skips what the tender has and shows rejections, plan by plan in the order sent", async () => {
    const plans: UploadPlan[] = [
      { name: "a.pdf", status: "upload", path: "t/a", token: "tok-a" },
      { name: "b.xlsx", status: "duplicate" },
      { name: "c.zip", status: "rejected", reason: "İhalenin dosya alanı (200 MB) doldu." },
    ];
    const h = harness({ plan: (_, i) => plans[i]! });
    await h.run([file("a.pdf"), file("b.xlsx"), file("c.zip")]);

    expect(h.updates["0"]).toEqual([
      { status: "uploading", reason: null },
      { status: "uploaded", reason: null },
    ]);
    expect(h.final(1)).toEqual({ status: "duplicate", reason: null });
    expect(h.final(2)).toEqual({ status: "error", reason: "İhalenin dosya alanı (200 MB) doldu." });
    expect(h.calls.upload).toEqual([{ bucket: "documents", path: "t/a", token: "tok-a", name: "a.pdf", kind: "pdf" }]);
    // One report for the drop, with only what was uploaded.
    expect(h.calls.complete).toEqual([[{ name: "a.pdf", size: 1_000, sha256: sha("a.pdf"), kind: "pdf" }]]);
  });

  it("uploads at most two files at once", async () => {
    let active = 0;
    let most = 0;
    const h = harness({
      upload: async () => {
        active++;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { error: null };
      },
    });
    await h.run(["1.pdf", "2.pdf", "3.pdf", "4.pdf", "5.pdf"].map((n) => file(n)));
    expect(most).toBe(2);
    expect(h.calls.upload).toHaveLength(5);
    expect([0, 1, 2, 3, 4].map((i) => h.final(i)?.status)).toEqual(Array(5).fill("uploaded"));
  });

  it("explains upload failures, and counts a file already in storage as uploaded", async () => {
    const outcomes: Record<string, () => Promise<{ error: StorageFailure | null }>> = {
      "izin.pdf": async () => ({ error: { message: "Invalid signature", statusCode: "403" } }),
      "var.pdf": async () => ({ error: { message: "The resource already exists", statusCode: "409" } }),
      "kopuk.pdf": async () => {
        throw new TypeError("Failed to fetch");
      },
    };
    const h = harness({ upload: (f) => outcomes[f.name]!() });
    await h.run([file("izin.pdf"), file("var.pdf"), file("kopuk.pdf")]);
    expect(h.final(0)).toEqual({ status: "error", reason: "Yükleme izni geçersiz ya da süresi doldu; tekrar deneyin." });
    expect(h.final(1)).toEqual({ status: "uploaded", reason: null });
    expect(h.final(2)).toEqual({ status: "error", reason: "Bağlantı koptu, dosya yüklenemedi; tekrar deneyin." });
    expect(h.calls.complete).toEqual([[expect.objectContaining({ name: "var.pdf" })]]);
  });

  it("shows the files the server did not find in storage, told apart by content", async () => {
    // Two versions of one specification under the same name; only the second is missing.
    const h = harness({ complete: async (files) => ({ ok: true, added: files.length - 1, missing: [sha("düzeltilmiş")], rejected: [] }) });
    await h.run([file("a.pdf"), file("Şartname.pdf", 1_000, "ilk"), file("Şartname.pdf", 1_200, "düzeltilmiş")]);
    expect(h.final(0)).toEqual({ status: "uploaded", reason: null });
    expect(h.final(1)).toEqual({ status: "uploaded", reason: null });
    expect(h.final(2)).toEqual({ status: "error", reason: "Dosya depoda bulunamadı; tekrar yükleyin." });
    expect(h.calls.complete[0]!.map((f) => f.sha256)).toEqual([sha("a.pdf"), sha("ilk"), sha("düzeltilmiş")]);
  });

  it("shows why the server refused a file that reached storage, on that file only", async () => {
    // Recorded under the tender's lock, the second version no longer fits.
    const full = "İhalenin dosya alanı (200 MB) doldu.";
    const h = harness({
      complete: async (files) => ({ ok: true, added: files.length - 1, missing: [], rejected: [{ sha256: sha("v2"), reason: full }] }),
    });
    await h.run([file("Teklif.pdf", 1_000, "v1"), file("Teklif.pdf", 1_000, "v2"), file("b.pdf")]);
    expect(h.final(0)).toEqual({ status: "uploaded", reason: null });
    expect(h.final(1)).toEqual({ status: "error", reason: full });
    expect(h.final(2)).toEqual({ status: "uploaded", reason: null });
  });

  it("puts a failed request on every file it was for", async () => {
    const refused = harness({ prepare: async () => ({ ok: false, error: "Dosya deposu ayarlı değil." }) });
    await refused.run([file("a.pdf"), file("b.pdf")]);
    expect([refused.final(0), refused.final(1)]).toEqual(Array(2).fill({ status: "error", reason: "Dosya deposu ayarlı değil." }));
    expect(refused.calls.upload).toEqual([]);

    const offline = harness({
      prepare: async () => {
        throw new Error("network");
      },
    });
    await offline.run([file("a.pdf")]);
    expect(offline.final(0)).toEqual({ status: "error", reason: "Sunucuya ulaşılamadı; tekrar deneyin." });

    const unrecorded = harness({ complete: async () => ({ ok: false, error: "İhale bulunamadı." }) });
    await unrecorded.run([file("a.pdf")]);
    expect(unrecorded.final(0)).toEqual({ status: "error", reason: "İhale bulunamadı." });

    const short = harness({ prepare: async () => ({ ok: true, bucket: "documents", plans: [] }) });
    await short.run([file("a.pdf")]);
    expect(short.final(0)).toEqual({ status: "error", reason: "Sunucu bu dosya için yanıt vermedi; tekrar deneyin." });
  });

  it("goes on with the others when a file cannot be read", async () => {
    const h = harness({
      hash: async (f) => {
        if (f.name === "kilitli.pdf") throw new DOMException("The requested file could not be read", "NotReadableError");
        return sha(f.name);
      },
    });
    await h.run([file("kilitli.pdf"), file("a.pdf")]);
    expect(h.final(0)).toEqual({ status: "error", reason: "Dosya okunamadı." });
    expect(h.final(1)).toEqual({ status: "uploaded", reason: null });
  });

  it("asks for at most MAX_FILES_PER_UPLOAD files per request", async () => {
    const h = harness();
    await h.run(Array.from({ length: 120 }, (_, i) => file(`${i}.pdf`)));
    expect(h.calls.prepare.map((part) => part.length)).toEqual([MAX_FILES_PER_UPLOAD, MAX_FILES_PER_UPLOAD, 20]);
    expect(h.calls.complete.map((part) => part.length)).toEqual([MAX_FILES_PER_UPLOAD, MAX_FILES_PER_UPLOAD, 20]);
  });
});

describe("createLimiter", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("never runs more than its limit, even when a task joins as another hands over its slot", async () => {
    const limiter = createLimiter(2);
    let running = 0;
    let most = 0;
    const order: number[] = [];
    const finish = new Map<number, () => void>();
    const task = (n: number) =>
      limiter.run(() => {
        running++;
        most = Math.max(most, running);
        order.push(n);
        return new Promise<void>((resolve) =>
          finish.set(n, () => {
            running--;
            resolve();
          }),
        );
      });
    const queued = [task(1), task(2), task(3)];
    let release!: () => void;
    const joining = new Promise<void>((resolve) => (release = resolve)).then(() => task(4));
    await flush();
    // Task 1 ends in the same moment as something that starts task 4: task 3,
    // waiting longer, must get the slot and task 4 must wait.
    finish.get(1)!();
    release();
    await flush();
    expect(order).toEqual([1, 2, 3]);
    finish.get(2)!();
    await flush();
    finish.get(3)!();
    finish.get(4)!();
    await Promise.all([...queued, joining]);
    expect(most).toBe(2);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});

describe("helpers", () => {
  it("writes a digest as lowercase hex", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
    expect(toHex(digest)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("reads storage errors", () => {
    expect(uploadFailure({ message: "The resource already exists", statusCode: "409" })).toBeNull();
    expect(uploadFailure({ message: "Duplicate" })).toBeNull();
    expect(uploadFailure({ message: "Payload too large", statusCode: "413" })).toBe("Dosya deponun boyut sınırını aşıyor.");
    expect(uploadFailure({ message: "jwt expired", statusCode: "400" })).toBe("Yükleme izni geçersiz ya da süresi doldu; tekrar deneyin.");
    expect(uploadFailure({ message: "Internal", statusCode: "500" })).toBe("Depoya yüklenemedi; tekrar deneyin.");
  });

  it("notes each finished row and keeps errors until cleared", () => {
    const row = (status: "uploading" | "uploaded" | "duplicate" | "error", reason: string | null = null) => ({ id: "1", name: "a.pdf", status, reason });
    expect(rowNote(row("uploaded"))).toBe("Yüklendi; okunması bir iki dakika sürer.");
    expect(rowNote(row("duplicate"))).toBe("Bu dosya ihalede zaten var.");
    expect(rowNote(row("error", "Dosya boş."))).toBe("Dosya boş.");
    expect(rowNote(row("uploading"))).toBeNull();
    expect([row("uploading"), row("uploaded"), row("error")].map(isDone)).toEqual([false, true, true]);
  });
});
