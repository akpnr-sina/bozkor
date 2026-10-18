import { Inflate } from "fflate";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { DOCUMENT_LIMITS } from "./limits";
import type { Extracted, FileKind } from "./types";

// Text out of the files the documents stage keeps (SPEC Faz 5): PDF text page
// by page, DOCX paragraphs, XLSX sheets as tab-separated rows, and the members
// of a ZIP for the worker to store and read in turn. Never throws: a file that
// cannot be read comes back as failed or unsupported with a short Turkish
// reason the UI can show.

/** Separates PDF pages in the text: page n is `text.split(PAGE_BREAK)[n - 1]`. */
export const PAGE_BREAK = "\f";

export type ExtractOptions = {
  /** Text kept per file; the rest is cut and marked. */
  maxTextChars?: number;
};

const LABELS: Record<FileKind, string> = { pdf: "PDF", docx: "DOCX", xlsx: "XLSX", zip: "ZIP" };

export async function extractFile(bytes: Uint8Array, kind: FileKind, options: ExtractOptions = {}): Promise<Extracted> {
  const maxTextChars = options.maxTextChars ?? DOCUMENT_LIMITS.textChars;
  try {
    return withoutControls(await read(bytes, kind, maxTextChars));
  } catch (error) {
    return withoutControls({ kind: "failed", error: `${LABELS[kind] ?? "Dosya"} okunamadı: ${describe(error)}` });
  }
}

async function read(bytes: Uint8Array, kind: FileKind, maxTextChars: number): Promise<Extracted> {
  switch (kind) {
    case "pdf":
      return extractPdf(bytes, maxTextChars);
    case "docx":
      return extractDocx(bytes, maxTextChars);
    case "xlsx":
      return extractXlsx(bytes, maxTextChars);
    case "zip":
      return readZip(bytes);
    default:
      return { kind: "unsupported", reason: "Bu dosya türü okunmuyor." };
  }
}

/**
 * Control characters other than tab, line feed, form feed (PAGE_BREAK) and
 * carriage return. Postgres refuses NUL in text, which broken PDF fonts map
 * glyphs to.
 */
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g;

/** Every text the result carries, error messages and reasons too: they end up in the database as well. */
function withoutControls(result: Extracted): Extracted {
  const clean = (text: string) => text.replace(CONTROL, "");
  switch (result.kind) {
    case "pdf":
    case "docx":
    case "xlsx":
      return { ...result, text: clean(result.text) };
    case "zip":
      return { ...result, skipped: result.skipped.map((s) => ({ name: clean(s.name), reason: clean(s.reason) })) };
    case "unsupported":
      return { ...result, reason: clean(result.reason) };
    case "failed":
      return { ...result, error: clean(result.error) };
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200);

/** Cuts at `max` characters, never inside a surrogate pair. */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const code = text.charCodeAt(max - 1);
  return { text: text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max), truncated: true };
}

/** Unix line breaks, no trailing spaces, at most one blank line in a row. */
const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ---------------------------------------------------------------------------
// PDF

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsLoading: Promise<Pdfjs> | undefined;

/**
 * pdf.js on this thread: its worker code is imported first, so documents are
 * parsed without a worker thread. The native canvas it renders with is not
 * installed (pnpm-workspace.yaml) and reading text needs none, so the warnings
 * it prints about that on import are dropped.
 */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjsLoading ??= (async () => {
    const log = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string" && /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(args[0])) return;
      log(...args);
    };
    try {
      // @ts-expect-error The worker bundle ships no type declarations.
      await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return await import("pdfjs-dist/legacy/build/pdf.mjs");
    } finally {
      console.log = log;
    }
  })().catch((error: unknown) => {
    pdfjsLoading = undefined;
    throw error;
  });
  return pdfjsLoading;
}

/** A page's text items in reading order, with a line break where pdf.js sees the end of a line. */
function pageText(items: readonly object[]): string {
  let text = "";
  for (const item of items) {
    // Marked-content items carry no text.
    if (!("str" in item)) continue;
    const { str, hasEOL } = item as { str: string; hasEOL: boolean };
    text += hasEOL ? `${str}\n` : str;
  }
  return tidy(text.replaceAll(PAGE_BREAK, " "));
}

async function extractPdf(bytes: Uint8Array, maxTextChars: number): Promise<Extracted> {
  const { getDocument, VerbosityLevel } = await loadPdfjs();
  // pdf.js detaches the buffer it is given; the caller still needs its bytes.
  const task = getDocument({ data: bytes.slice(), verbosity: VerbosityLevel.ERRORS, useSystemFonts: false, disableFontFace: true });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let length = 0;
    // Pages past the text limit are not read.
    while (pages.length < doc.numPages && length <= maxTextChars) {
      const page = await doc.getPage(pages.length + 1);
      const text = pageText((await page.getTextContent()).items);
      page.cleanup();
      pages.push(text);
      length += text.length + PAGE_BREAK.length;
    }
    const { text, truncated } = cut(pages.join(PAGE_BREAK), maxTextChars);
    return { kind: "pdf", pageCount: doc.numPages, text, truncated: truncated || pages.length < doc.numPages };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") return { kind: "failed", error: "PDF parola korumalı; metni okunamıyor." };
    if (name === "InvalidPDFException") return { kind: "failed", error: "PDF bozuk ya da geçersiz." };
    throw error;
  } finally {
    await task.destroy();
  }
}

// ---------------------------------------------------------------------------
// DOCX and XLSX

async function extractDocx(bytes: Uint8Array, maxTextChars: number): Promise<Extracted> {
  // Paragraphs come separated by a blank line.
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  return { kind: "docx", ...cut(tidy(value), maxTextChars) };
}

/** Rows read per sheet; a longer sheet is cut (its text would pass the limit anyway). */
const SHEET_ROWS = 20_000;

function extractXlsx(bytes: Uint8Array, maxTextChars: number): Extracted {
  // SheetJS reads anything that is not a ZIP as CSV or HTML; an XLSX is always a ZIP.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { kind: "failed", error: "XLSX okunamadı: dosya bir Excel çalışma kitabı değil." };
  const workbook = XLSX.read(bytes, {
    type: "array",
    dense: true,
    sheetRows: SHEET_ROWS,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
  });
  let rowsCut = false;
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (sheet?.["!fullref"] && sheet["!fullref"] !== sheet["!ref"]) rowsCut = true;
    return [`## ${name}`, ...sheetLines(sheet)].join("\n");
  });
  const { text, truncated } = cut(sheets.join("\n\n"), maxTextChars);
  return { kind: "xlsx", text, truncated: truncated || rowsCut };
}

/** A sheet's rows as tab-separated cells, leaving out empty rows and empty columns. */
function sheetLines(sheet: XLSX.WorkSheet | undefined): string[] {
  const data = (sheet?.["!data"] ?? []) as (XLSX.CellObject | undefined)[][];
  const rows = Array.from(data, (row) =>
    Array.from(row ?? [], (cell) => (cell ? XLSX.utils.format_cell(cell).replace(/\s+/g, " ").trim() : "")),
  );
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const used = Array.from({ length: width }, (_, column) => rows.some((row) => !!row[column]));
  return rows
    .map((row) =>
      row
        .filter((_, column) => used[column])
        .join("\t")
        .replace(/\t+$/, ""),
    )
    .filter((line) => line.replaceAll("\t", "") !== "");
}

// ---------------------------------------------------------------------------
// ZIP

const SIGNATURE = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50, zip64Locator: 0x07064b50, zip64End: 0x06064b50 };
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const STORED = 0;
const DEFLATED = 8;

export type ZipLimits = Record<"zipEntries" | "zipBytes" | "fileBytes", number>;

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Little-endian reads that never go past the end of the file. */
function reader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  return {
    u16,
    u32,
    u64: (at: number) => u32(at) + u32(at + 4) * 2 ** 32,
    fits: (at: number, length: number) => at >= 0 && length >= 0 && at + length <= bytes.length,
  };
}

/** Offset of the end of central directory record, searched from the back past a comment of up to 64 KB. */
function findEnd(bytes: Uint8Array): number {
  const { u16, u32 } = reader(bytes);
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === SIGNATURE.end && at + 22 + u16(at + 20) <= bytes.length) return at;
  }
  return -1;
}

/**
 * The members of a ZIP worth keeping, read from its central directory and in
 * its order: no folders, macOS and Windows litter or hidden files, nothing
 * encrypted, and within the limits, which are checked before anything is
 * decompressed. Nested ZIPs are members like any other file; the worker opens
 * them. Takes the limits as a parameter for the tests.
 */
export function readZip(bytes: Uint8Array, limits: ZipLimits = DOCUMENT_LIMITS): Extracted {
  const { u16, u32, u64, fits } = reader(bytes);
  const broken = (why: string): Extracted => ({ kind: "failed", error: `ZIP okunamadı: ${why}.` });

  const end = findEnd(bytes);
  if (end < 0) return broken("dizin kaydı bulunamadı, dosya bozuk ya da eksik");
  let count = u16(end + 10);
  let at = u32(end + 16);
  if (count === 0xffff || at === 0xffffffff) {
    // ZIP64: the real count and offset are in the record the locator points to.
    const locator = end - 20;
    if (!fits(locator, 20) || u32(locator) !== SIGNATURE.zip64Locator) return broken("ZIP64 dizini bulunamadı");
    const record = u64(locator + 8);
    if (!fits(record, 56) || u32(record) !== SIGNATURE.zip64End) return broken("ZIP64 dizini bozuk");
    count = u64(record + 32);
    at = u64(record + 48);
  }
  if (count > limits.zipEntries * 10) return { kind: "failed", error: `ZIP okunamadı: çok fazla dosya var (${count}).` };

  const entries: { name: string; bytes: Uint8Array }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (!fits(at, 46) || u32(at) !== SIGNATURE.central) return broken("dizin bozuk");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    let packedSize = u32(at + 20);
    let size = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    let localOffset = u32(at + 42);
    const extraStart = at + 46 + nameLength;
    const extraEnd = extraStart + extraLength;
    if (!fits(at + 46, nameLength + extraLength)) return broken("dizin bozuk");
    // ZIP64: the sizes and the offset that did not fit are in its extra field, in this order.
    for (let x = extraStart; x + 4 <= extraEnd; x += 4 + u16(x + 2)) {
      if (u16(x) !== 0x0001) continue;
      let field = x + 4;
      const fieldEnd = Math.min(extraEnd, field + u16(x + 2));
      const next = () => {
        const value = field + 8 <= fieldEnd ? u64(field) : Number.MAX_SAFE_INTEGER;
        field += 8;
        return value;
      };
      if (size === 0xffffffff) size = next();
      if (packedSize === 0xffffffff) packedSize = next();
      if (localOffset === 0xffffffff) localOffset = next();
    }
    const written = decodeName(bytes.subarray(at + 46, extraStart), (flags & FLAG_UTF8) !== 0);
    at = extraEnd + commentLength;

    const name = cleanName(written);
    const skip = (reason: string) => skipped.push({ name: name || written, reason });
    const junk = junkReason(written, name);
    if (junk) skip(junk);
    else if (flags & FLAG_ENCRYPTED) skip("şifreli");
    else if (method !== STORED && method !== DEFLATED) skip(`desteklenmeyen sıkıştırma (yöntem ${method})`);
    else if (size > limits.fileBytes) skip(`dosya boyutu sınırı aşıldı (${megabytes(limits.fileBytes)})`);
    else if (entries.length >= limits.zipEntries) skip(`dosya sayısı sınırı aşıldı (${limits.zipEntries})`);
    else if (total + size > limits.zipBytes) skip(`toplam boyut sınırı aşıldı (${megabytes(limits.zipBytes)})`);
    else {
      const data = memberData(bytes, localOffset, method, packedSize, size);
      if (!data) {
        skip("bozuk kayıt");
        continue;
      }
      entries.push({ name, bytes: data });
      total += size;
    }
  }
  return { kind: "zip", entries, skipped };
}

/** A member's bytes from its local header, or null when they are not where and what the directory says. */
function memberData(bytes: Uint8Array, localOffset: number, method: number, packedSize: number, size: number): Uint8Array | null {
  const { u16, u32, fits } = reader(bytes);
  if (!fits(localOffset, 30) || u32(localOffset) !== SIGNATURE.local) return null;
  const start = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
  if (!fits(start, packedSize)) return null;
  const packed = bytes.subarray(start, start + packedSize);
  if (method === STORED) return packedSize === size ? packed.slice() : null;
  return inflateExactly(packed, size);
}

/** Compressed input fed at a time: bounds what a member lying about its size can make the inflater produce. */
const INFLATE_CHUNK = 16 * 1024;

/** Inflates `packed`, or null unless it comes out at exactly `size` bytes; stops as soon as it passes them. */
function inflateExactly(packed: Uint8Array, size: number): Uint8Array | null {
  const out = new Uint8Array(size);
  let written = 0;
  let tooLong = false;
  const inflater = new Inflate((chunk) => {
    if (tooLong || written + chunk.length > size) {
      tooLong = true;
      return;
    }
    out.set(chunk, written);
    written += chunk.length;
  });
  try {
    for (let i = 0; i < packed.length && !tooLong; i += INFLATE_CHUNK) {
      inflater.push(packed.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= packed.length);
    }
  } catch {
    return null;
  }
  return !tooLong && written === size ? out : null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The upper half of code page 437, the ZIP default for names without the UTF-8 flag (APPNOTE appendix D). */
const CP437_HIGH = String.fromCharCode(
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x00ec, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x00ff, 0x00d6, 0x00dc, 0x00a2, 0x00a3, 0x00a5, 0x20a7, 0x0192,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x00aa, 0x00ba, 0x00bf, 0x2310, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556, 0x2555, 0x2563, 0x2551, 0x2557, 0x255d, 0x255c, 0x255b, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x255e, 0x255f, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256b, 0x256a, 0x2518, 0x250c, 0x2588, 0x2584, 0x258c, 0x2590, 0x2580,
  0x03b1, 0x00df, 0x0393, 0x03c0, 0x03a3, 0x03c3, 0x00b5, 0x03c4, 0x03a6, 0x0398, 0x03a9, 0x03b4, 0x221e, 0x03c6, 0x03b5, 0x2229,
  0x2261, 0x00b1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00f7, 0x2248, 0x00b0, 0x2219, 0x00b7, 0x221a, 0x207f, 0x00b2, 0x25a0, 0x00a0,
);

/**
 * A member name as the archive wrote it: UTF-8 when flagged, and also when the
 * bytes are valid UTF-8 (macOS writes UTF-8 without the flag); code page 437 otherwise.
 */
function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder().decode(raw);
  try {
    return UTF8.decode(raw);
  } catch {
    return Array.from(raw, (b) => (b < 0x80 ? String.fromCharCode(b) : CP437_HIGH.charAt(b - 0x80))).join("");
  }
}

/** Forward slashes and no empty, "." or ".." parts, so a member name never points outside its folder. */
const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]+/)
    .filter((part) => part !== "" && part !== "." && part !== "..")
    .join("/");

const SYSTEM_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** Why a member is left out as litter, or null for a file to keep. */
function junkReason(written: string, name: string): string | null {
  if (/[\\/]$/.test(written)) return "klasör";
  if (!name) return "geçersiz dosya adı";
  const parts = name.split("/");
  if (parts.includes("__MACOSX")) return "macOS ek dosyası";
  if (SYSTEM_FILES.has((parts.at(-1) ?? "").toLowerCase())) return "sistem dosyası";
  if (parts.some((part) => part.startsWith("."))) return "gizli dosya";
  return null;
}
