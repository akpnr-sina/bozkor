import type { FileKind } from "./types";

// Tells the file kind from its first bytes, then the name: servers often send
// application/octet-stream, and DOCX and XLSX are ZIP archives inside.

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);

const PDF = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK..
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
/** OLE2 compound file: old .doc and .xls, which we do not read. */
export const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];

const extension = (filename: string | null) => /\.([a-z0-9]{1,5})$/i.exec(filename ?? "")?.[1]?.toLowerCase() ?? null;

const WINDOW = 64 * 1024;
const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

/**
 * Entry names from a ZIP's central directory, in archive order; null when
 * the archive is cut short (the first bytes of a download) or damaged.
 */
function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record: 22 bytes, then a comment of up to 65535.
  for (let end = bytes.length - 22; end >= 0 && end >= bytes.length - 22 - 0xffff; end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
      const nameLength = view.getUint16(offset + 28, true);
      names.push(latin1(bytes.subarray(offset + 46, offset + 46 + nameLength)));
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return names;
  }
  return null;
}

/**
 * What a ZIP container holds: a DOCX or XLSX, another packaged format we do
 * not read (PowerPoint and other Office files, OpenDocument, EPUB), or files.
 * Told by its entry names; a ZIP of documents may hold a DOCX stored
 * uncompressed, whose own part names then show in the raw bytes.
 */
function zipKind(bytes: Uint8Array, filename: string | null): FileKind | null {
  const entries = zipEntryNames(bytes);
  if (entries) {
    if (entries.includes("word/document.xml")) return "docx";
    if (entries.includes("xl/workbook.xml")) return "xlsx";
    // OpenDocument and EPUB store a "mimetype" entry first.
    if (entries.includes("[Content_Types].xml") || entries[0] === "mimetype") return null;
    return "zip";
  }
  // Cut short or damaged: the extension, then part names in the raw bytes.
  const ext = extension(filename);
  if (ext === "docx" || ext === "xlsx") return ext;
  const head = latin1(bytes.subarray(0, WINDOW));
  if (head.includes("word/document.xml")) return "docx";
  if (head.includes("xl/workbook.xml")) return "xlsx";
  // The first entry's name comes right after its 30-byte header.
  if (head.startsWith("mimetype", 30) || head.includes("ppt/presentation.xml")) return null;
  return "zip";
}

/**
 * The kind of a file we read, or null when it is not one: a PDF by its
 * header, a ZIP by its header with DOCX and XLSX told apart by their parts
 * or their extension.
 */
export function sniffKind(bytes: Uint8Array, filename: string | null = null): FileKind | null {
  if (startsWith(bytes, PDF)) return "pdf";
  if (startsWith(bytes, ZIP) || startsWith(bytes, ZIP_EMPTY)) return zipKind(bytes, filename);
  return null;
}

/** MIME type to store for a kind. */
export const KIND_MIME: Record<FileKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

export const KIND_EXTENSION: Record<FileKind, string> = { pdf: ".pdf", docx: ".docx", xlsx: ".xlsx", zip: ".zip" };
