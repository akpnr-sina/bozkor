import { describe, expect, it } from "vitest";
import { cleanUploadName, uploadKindOf, uploadProblem } from "./uploads";

describe("uploadProblem", () => {
  it("takes PDF, DOCX, XLSX and ZIP up to 50 MB, and says what to do with the rest", () => {
    expect(uploadProblem({ name: "Şartname.PDF", size: 1_000 })).toBeNull();
    expect(uploadKindOf("Fiyat Cetveli.xlsx")).toBe("xlsx");
    expect(uploadProblem({ name: "eski.doc", size: 1_000 })).toContain(".docx");
    expect(uploadProblem({ name: "çizim.dwg", size: 1_000 })).toBe("Sadece PDF, DOCX, XLSX ve ZIP dosyaları yüklenir.");
    expect(uploadProblem({ name: "boş.pdf", size: 0 })).toBe("Dosya boş.");
    expect(uploadProblem({ name: "büyük.zip", size: 50 * 1024 * 1024 + 1 })).toBe("Dosya 50 MB sınırından büyük.");
  });
});

describe("cleanUploadName", () => {
  it("keeps the bare name, cuts a long one with its extension, and never leaves it empty", () => {
    expect(cleanUploadName("C:\\Users\\ekip\\Teklif Talimatı.docx", "docx")).toBe("Teklif Talimatı.docx");
    expect(cleanUploadName(" a\u0007b.pdf ", "pdf")).toBe("ab.pdf");
    const long = cleanUploadName(`${"x".repeat(300)}.xlsx`, "xlsx");
    expect(long).toHaveLength(200);
    expect(long.endsWith("x.xlsx")).toBe(true);
    expect(cleanUploadName("   ", "zip")).toBe("dosya.zip");
  });
});
