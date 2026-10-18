import { strToU8, zipSync, type Zippable } from "fflate";
import { describe, expect, it } from "vitest";
import { sniffKind } from "./sniff";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

/** A real ZIP; level 0 stores the entries uncompressed, as some portals do. */
const zip = (files: Record<string, string | Uint8Array>, level: 0 | 6 = 6) =>
  zipSync(
    Object.fromEntries(Object.entries(files).map(([name, body]) => [name, typeof body === "string" ? strToU8(body) : body])) as Zippable,
    { level },
  );

const DOCX = zip({ "[Content_Types].xml": "<Types/>", "_rels/.rels": "<Relationships/>", "word/document.xml": "<w:document/>" });
const XLSX = zip({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>", "xl/worksheets/sheet1.xml": "<worksheet/>" });

describe("sniffKind", () => {
  it("tells PDFs and ZIPs by their header, whatever the name says", () => {
    expect(sniffKind(bytes("%PDF-1.7\n"), "teklif.zip")).toBe("pdf");
    expect(sniffKind(zip({ "documents/spec.pdf": "%PDF-1.7" }), "paket.bin")).toBe("zip");
  });

  it("tells DOCX and XLSX by their parts, not their name", () => {
    expect(sniffKind(DOCX)).toBe("docx");
    expect(sniffKind(XLSX, "Fiyat Cetveli.zip")).toBe("xlsx");
    // A folder named Keyword/ or Password/ is no Word part.
    expect(sniffKind(zip({ "Keyword/notes.pdf": "%PDF", "Password/list.pdf": "%PDF" }))).toBe("zip");
  });

  it("keeps a ZIP of documents a ZIP when its DOCX is stored uncompressed", () => {
    const pack = zip({ "Teknik Şartname.docx": DOCX, "Fiyat Cetveli.xlsx": XLSX, "Davet.pdf": "%PDF-1.7" }, 0);
    expect(sniffKind(pack, "ihale-dokumanlari.zip")).toBe("zip");
  });

  it("does not read other packages: PowerPoint, OpenDocument, EPUB", () => {
    expect(sniffKind(zip({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>" }), "sunum.pptx")).toBeNull();
    expect(sniffKind(zip({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": "<office/>" }, 0), "sartname.odt")).toBeNull();
    expect(sniffKind(zip({ mimetype: "application/epub+zip", "META-INF/container.xml": "<container/>" }, 0))).toBeNull();
  });

  it("works from the first bytes of a download, before the central directory arrives", () => {
    const head = (file: Uint8Array) => file.subarray(0, 60);
    expect(sniffKind(head(DOCX))).not.toBeNull();
    expect(sniffKind(head(zip({ "spec.pdf": "%PDF-1.7" })))).toBe("zip");
    expect(sniffKind(head(zip({ mimetype: "application/epub+zip", "a.xhtml": "<html/>" }, 0))), "kitap.epub").toBeNull();
    expect(sniffKind(bytes([0x50, 0x4b, 0x03, 0x04], "cut short"), "Fiyat Cetveli.XLSX")).toBe("xlsx");
  });

  it("does not read old Office files, HTML or anything else", () => {
    expect(sniffKind(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]), "spec.doc")).toBeNull();
    expect(sniffKind(bytes("<!DOCTYPE html><html>"), "documents.pdf")).toBeNull();
    expect(sniffKind(new Uint8Array(), null)).toBeNull();
  });
});
