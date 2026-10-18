import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractFile, PAGE_BREAK, readZip } from "./extract";
import { DOCUMENT_LIMITS } from "./limits";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../tests/fixtures/documents/${name}`, import.meta.url)));

/** A small valid PDF: one Helvetica line per string, one page per array. */
function pdf(pages: string[][], options: { encrypted?: boolean } = {}): Uint8Array {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  for (const lines of pages) {
    const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // The standard security handler with a user password that is not empty: readers must ask for it.
  if (options.encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -44 >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const encrypt = options.encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : "";
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function xlsx(sheets: Record<string, (string | number | null)[][]>): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** A copy of `archive` with the central directory record of `name` changed. */
function patchCentral(archive: Uint8Array, name: string, patch: (view: DataView, at: number, bytes: Uint8Array) => void): Uint8Array {
  const copy = archive.slice();
  const view = new DataView(copy.buffer);
  const wanted = strToU8(name);
  for (let at = 0; at + 46 <= copy.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const found = copy.subarray(at + 46, at + 46 + view.getUint16(at + 28, true));
    if (found.length === wanted.length && found.every((b, i) => b === wanted[i])) {
      patch(view, at, copy);
      return copy;
    }
  }
  throw new Error(`${name} is not in the central directory`);
}

const twoPages = () => pdf([["First page, line one", "line two"], ["Second page"]]);

describe("extractFile: PDF", () => {
  it("counts the pages and separates their text with form feeds", async () => {
    const result = await extractFile(twoPages(), "pdf");
    expect(result).toEqual({ kind: "pdf", pageCount: 2, text: `First page, line one\nline two${PAGE_BREAK}Second page`, truncated: false });
    if (result.kind === "pdf") expect(result.text.split(PAGE_BREAK)[1]).toBe("Second page");
  });

  it("leaves the caller's bytes intact", async () => {
    const bytes = twoPages();
    const copy = bytes.slice();
    await extractFile(bytes, "pdf");
    expect(bytes).toEqual(copy);
  });

  it("cuts the text at the limit and stops reading pages past it", async () => {
    expect(await extractFile(twoPages(), "pdf", { maxTextChars: 35 })).toEqual({
      kind: "pdf",
      pageCount: 2,
      text: `First page, line one\nline two${PAGE_BREAK}Secon`,
      truncated: true,
    });
    const threePages = pdf([["First page, line one"], ["Second page"], ["Third page"]]);
    expect(await extractFile(threePages, "pdf", { maxTextChars: 10 })).toEqual({ kind: "pdf", pageCount: 3, text: "First page", truncated: true });
  });

  it("fails on a password-protected or broken PDF", async () => {
    expect(await extractFile(pdf([["Secret"]], { encrypted: true }), "pdf")).toEqual({ kind: "failed", error: "PDF parola korumalı; metni okunamıyor." });
    expect(await extractFile(new TextEncoder().encode("%PDF-1.7\nnot a PDF after all"), "pdf")).toEqual({
      kind: "failed",
      error: "PDF bozuk ya da geçersiz.",
    });
  });
});

describe("extractFile: DOCX", () => {
  // Written by macOS textutil from an HTML page with a heading, two paragraphs and a table.
  const specification = fixture("specification.docx");

  it("keeps the paragraphs, a blank line between them", async () => {
    expect(await extractFile(specification, "docx")).toEqual({
      kind: "docx",
      text:
        "Technical Specification\n\nThe supplier shall deliver 20 outdoor chairs and 5 matching tables.\n\n" +
        "Warranty: 15 years from delivery. Teslim yeri: Eryri Ulusal Parkı, Galler.\n\nItem\n\nQuantity\n\nChair\n\n20",
      truncated: false,
    });
  });

  it("cuts the text at the limit", async () => {
    expect(await extractFile(specification, "docx", { maxTextChars: 23 })).toEqual({ kind: "docx", text: "Technical Specification", truncated: true });
  });

  it("fails on a file that is not a Word document", async () => {
    const result = await extractFile(twoPages(), "docx");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toMatch(/^DOCX okunamadı: /);
  });
});

describe("extractFile: XLSX", () => {
  it("writes each sheet under its name as tab-separated rows, without empty rows and columns", async () => {
    const workbook = xlsx({
      Fiyatlar: [["Kalem", null, "Adet", "Birim fiyat"], [], ["Kablo", null, 100, 2.5], ["Sigorta", "", 40, null]],
      Teslim: [["Yer", "Tarih"], ["Bangor\nGaller", "2026-11-30"]],
    });
    expect(await extractFile(workbook, "xlsx")).toEqual({
      kind: "xlsx",
      text: "## Fiyatlar\nKalem\tAdet\tBirim fiyat\nKablo\t100\t2.5\nSigorta\t40\n\n## Teslim\nYer\tTarih\nBangor Galler\t2026-11-30",
      truncated: false,
    });
  });

  it("fails on a file that is not a workbook", async () => {
    expect(await extractFile(twoPages(), "xlsx")).toEqual({ kind: "failed", error: "XLSX okunamadı: dosya bir Excel çalışma kitabı değil." });
    const notWorkbook = await extractFile(zipSync({ "notes.txt": strToU8("not a workbook") }), "xlsx");
    expect(notWorkbook.kind).toBe("failed");
  });
});

describe("extractFile: ZIP", () => {
  const spec = pdf([["Specification"]]);
  const inner = zipSync({ "price-schedule.txt": strToU8("inner") });
  const archive = zipSync({
    "docs/": new Uint8Array(0),
    "docs/spec.pdf": spec,
    "__MACOSX/docs/._spec.pdf": strToU8("resource fork"),
    ".DS_Store": strToU8("finder"),
    "docs/Thumbs.db": strToU8("thumbnails"),
    "docs/.hidden.txt": strToU8("hidden"),
    "inner.zip": [inner, { level: 0 }],
    "docs/şartname.txt": strToU8("Şartname"),
    "../outside.txt": strToU8("outside"),
  });

  it("keeps the files in archive order, nested ZIPs unopened, and says why it left the rest out", async () => {
    expect(await extractFile(archive, "zip")).toEqual({
      kind: "zip",
      entries: [
        { name: "docs/spec.pdf", bytes: spec },
        { name: "inner.zip", bytes: inner },
        { name: "docs/şartname.txt", bytes: strToU8("Şartname") },
        // A name never points outside the archive's folder.
        { name: "outside.txt", bytes: strToU8("outside") },
      ],
      skipped: [
        { name: "docs", reason: "klasör" },
        { name: "__MACOSX/docs/._spec.pdf", reason: "macOS ek dosyası" },
        { name: ".DS_Store", reason: "sistem dosyası" },
        { name: "docs/Thumbs.db", reason: "sistem dosyası" },
        { name: "docs/.hidden.txt", reason: "gizli dosya" },
      ],
    });
  });

  it("reads names without the UTF-8 flag as UTF-8 when they are, and as code page 437 otherwise", () => {
    const legacy = zipSync({ "AB.txt": strToU8("dos"), "CDEF.txt": strToU8("mac") });
    // Windows tools write the OEM code page; macOS writes UTF-8 without setting the flag.
    const cp437 = patchCentral(legacy, "AB.txt", (_, at, bytes) => bytes.set([0x87, 0x94], at + 46));
    const renamed = patchCentral(cp437, "CDEF.txt", (_, at, bytes) => bytes.set(strToU8("şı"), at + 46));
    const result = readZip(renamed);
    expect(result.kind === "zip" && result.entries.map((e) => e.name)).toEqual(["çö.txt", "şı.txt"]);
  });

  it("checks the limits before decompressing", () => {
    const three = zipSync({ "a.txt": strToU8("a"), "b.txt": strToU8("b"), "c.txt": strToU8("c") });
    expect(readZip(three, { ...DOCUMENT_LIMITS, zipEntries: 2 })).toMatchObject({
      entries: [{ name: "a.txt" }, { name: "b.txt" }],
      skipped: [{ name: "c.txt", reason: "dosya sayısı sınırı aşıldı (2)" }],
    });

    // Said to be larger than a stored file may be; nothing that size is allocated.
    const huge = patchCentral(three, "b.txt", (view, at) => view.setUint32(at + 24, DOCUMENT_LIMITS.fileBytes + 1, true));
    expect(readZip(huge)).toMatchObject({ skipped: [{ name: "b.txt", reason: "dosya boyutu sınırı aşıldı (50 MB)" }] });

    const fifteen = strToU8("x".repeat(15));
    const result = readZip(zipSync({ "first.txt": fifteen, "second.txt": fifteen }), { ...DOCUMENT_LIMITS, zipBytes: 25 });
    expect(result).toMatchObject({ entries: [{ name: "first.txt" }], skipped: [{ name: "second.txt" }] });
    if (result.kind === "zip") expect(result.skipped[0]!.reason).toMatch(/^toplam boyut sınırı aşıldı/);
  });

  it("leaves out a member that inflates past the size it claims, and encrypted or unknown compression", () => {
    const bomb = zipSync({ "zeros.bin": new Uint8Array(100_000), "ok.txt": strToU8("ok") });
    const lying = patchCentral(bomb, "zeros.bin", (view, at) => view.setUint32(at + 24, 1_000, true));
    expect(readZip(lying)).toMatchObject({ entries: [{ name: "ok.txt" }], skipped: [{ name: "zeros.bin", reason: "bozuk kayıt" }] });

    const encrypted = patchCentral(bomb, "zeros.bin", (view, at) => view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true));
    expect(readZip(encrypted)).toMatchObject({ skipped: [{ name: "zeros.bin", reason: "şifreli" }] });

    const bzip2 = patchCentral(bomb, "zeros.bin", (view, at) => view.setUint16(at + 10, 12, true));
    expect(readZip(bzip2)).toMatchObject({ skipped: [{ name: "zeros.bin", reason: "desteklenmeyen sıkıştırma (yöntem 12)" }] });
  });

  it("fails on a broken archive and reads an empty one", async () => {
    expect(await extractFile(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4), "zip")).toEqual({
      kind: "failed",
      error: "ZIP okunamadı: dizin kaydı bulunamadı, dosya bozuk ya da eksik.",
    });
    expect(await extractFile(zipSync({}), "zip")).toEqual({ kind: "zip", entries: [], skipped: [] });
  });
});
