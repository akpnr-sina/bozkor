import { describe, expect, it } from "vitest";
import type { TenderDocument } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import { documentDescription, documentFacts, documentName, documentState, type StateContext } from "./document-state";

const NOW = new Date("2026-10-16T12:00:00Z");

const doc = (fields: Partial<TenderDocument>): TenderDocument => ({
  id: "d1",
  origin: "auto",
  title: null,
  documentType: null,
  filename: null,
  sourceUrl: "https://buyer.example/itt.pdf",
  mime: null,
  sizeBytes: null,
  sha256: null,
  pageCount: null,
  fetchStatus: "pending",
  fetchError: null,
  fetchAttempts: 0,
  retryAt: null,
  stored: false,
  processed: false,
  textChars: null,
  textTruncated: false,
  parentId: null,
  createdAt: new Date("2026-10-16T09:00:00Z"),
  depth: 0,
  members: 0,
  analysisInput: false,
  ...fields,
});

const ctx = (fields: Partial<StateContext> = {}): StateContext => ({ inputShas: new Set(), fetchWanted: true, uploadsEnabled: true, now: NOW, ...fields });
const later = new Date("2026-10-16T15:00:00Z");

describe("documentState for links", () => {
  it("says whether a link will be tried, is being fetched or waits for another try", () => {
    expect(documentState(doc({}), ctx())).toEqual({ label: "İndirilmedi", tone: "neutral", note: "Link otomatik denenecek." });
    // A run's claim: no failure behind it.
    expect(documentState(doc({ retryAt: later }), ctx())).toMatchObject({ label: "İndiriliyor", tone: "waiting" });
    expect(documentState(doc({ retryAt: later, fetchAttempts: 1, fetchError: "Zaman aşımı." }), ctx())).toEqual({
      label: "Yeniden denenecek",
      tone: "waiting",
      note: "Zaman aşımı. Sonraki deneme: 16 Eki 2026 18:00.",
    });
    // Its time has come: the next run takes it.
    expect(documentState(doc({ retryAt: new Date("2026-10-16T11:00:00Z"), fetchAttempts: 1, fetchError: "HTTP 503" }), ctx()).note).toBe(
      "HTTP 503 Sıradaki çalıştırmada denenecek.",
    );
  });

  it("does not promise a try that will not come", () => {
    expect(documentState(doc({}), ctx({ fetchWanted: false })).note).toBe(
      "Bu ihale otomatik indirme kapsamında değil; gerekirse linke gidip dosyayı indirip buraya yükleyin.",
    );
    expect(documentState(doc({ sourceUrl: "mailto:tenders@buyer.example" }), ctx()).note).toBe("Bu link web adresi değil; otomatik denenmez.");
  });

  it("asks for a manual upload when the link is a portal page, if uploads are on", () => {
    expect(documentState(doc({ fetchStatus: "needs_manual", fetchError: "Portal girişi istiyor." }), ctx())).toEqual({
      label: "Portalda",
      tone: "action",
      note: "Portal girişi istiyor. Portaldan indirip buraya yükleyin.",
    });
    expect(documentState(doc({ fetchStatus: "needs_manual" }), ctx({ uploadsEnabled: false })).note).toBe("Portaldan indirebilirsiniz.");
    expect(documentState(doc({ fetchStatus: "needs_manual", members: 3, processed: true, fetchError: "Portal sayfası; sayfadaki 3 dosya alındı." }), ctx())).toEqual({
      label: "Portaldan alındı",
      tone: "good",
      note: "Portal sayfası; sayfadaki 3 dosya alındı. Eksik varsa portaldan indirip buraya yükleyin.",
    });
    const scanning = { fetchStatus: "needs_manual" as const, members: 20, processed: false, sourceUrl: "https://ausschreibungen.giz.de/Satellite/notice/9/documents" };
    expect(documentState(doc({ ...scanning, fetchError: "Portal sayfası; dosyaları alınıyor, bu turda 20 dosya alındı." }), ctx())).toMatchObject({
      label: "Portaldan alınıyor",
      tone: "waiting",
    });
    // The tender left the fetching scope half way: nothing goes on by itself.
    expect(documentState(doc({ ...scanning }), ctx({ fetchWanted: false }))).toEqual({
      label: "Portaldan kısmen alındı",
      tone: "action",
      note: "İhale artık otomatik indirme kapsamında değil; eksikleri portaldan indirip buraya yükleyin.",
    });
  });
});

describe("documentState for stored files", () => {
  const stored = { fetchStatus: "fetched" as const, stored: true, mime: KIND_MIME.pdf, sha256: "a".repeat(64) };

  it("follows a file from reading to the analysis", () => {
    expect(documentState(doc({ ...stored }), ctx()).label).toBe("Okunuyor");
    expect(documentState(doc({ ...stored, processed: true, analysisInput: true, pageCount: 3 }), ctx())).toMatchObject({ label: "Analize girecek", tone: "good" });
    expect(documentState(doc({ ...stored, processed: true }), ctx({ inputShas: new Set(["a".repeat(64)]) })).label).toBe("Kopya");
    expect(documentState(doc({ ...stored, processed: true, fetchError: "Okunamadı: PDF bozuk ya da geçersiz." }), ctx())).toMatchObject({
      label: "Okunamadı",
      tone: "problem",
    });
  });

  it("tells an opened ZIP from one that was not opened", () => {
    const zip = { ...stored, mime: KIND_MIME.zip, processed: true };
    expect(documentState(doc({ ...zip, members: 2, fetchError: "Alınmayan: a.dwg: şifreli" }), ctx())).toMatchObject({ label: "ZIP açıldı", note: "Alınmayan: a.dwg: şifreli" });
    expect(documentState(doc({ ...zip, fetchError: "Alınmayan: a.pdf: aynı dosya zaten var" }), ctx()).label).toBe("ZIP açıldı");
    expect(documentState(doc({ ...zip, fetchError: "ZIP içinde ZIP içinde ZIP; bu katman açılmadı, içindeki dosyaları ayrıca yükleyin." }), ctx())).toMatchObject({
      label: "Açılmadı",
      tone: "problem",
    });
  });
});

describe("documentFacts, documentName and documentDescription", () => {
  it("describe a stored file in a line", () => {
    const pdf = doc({ stored: true, mime: KIND_MIME.pdf, sizeBytes: 2_516_582, pageCount: 18, textTruncated: true });
    expect(documentFacts(pdf)).toBe("PDF, 2,4 MB, 18 sayfa, metnin bir kısmı alındı");
    expect(documentFacts(doc({ stored: true, mime: KIND_MIME.xlsx, sizeBytes: 40_000, textChars: 12_500 }))).toBe("XLSX, 39 KB, 12.500 karakter metin");
    expect(documentFacts(doc({}))).toBeNull();
  });

  it("name a link by a short description, a long one by its site with the description below", () => {
    expect(documentName(doc({ title: "Invitation to tender" }))).toBe("Invitation to tender");
    expect(documentName(doc({ filename: "ITT.pdf", title: "Invitation to tender" }))).toBe("ITT.pdf");
    expect(documentDescription(doc({ filename: "ITT.pdf", title: "Invitation to tender" }))).toBe("Invitation to tender");
    const specification = `Capability to remotely charge BA cylinders. ${"Maximum charging pressure of 300 Bar. ".repeat(10)}`;
    const long = doc({ title: specification, sourceUrl: "https://www.find-tender.service.gov.uk/Notice/Attachment/1" });
    expect(documentName(long)).toBe("find-tender.service.gov.uk linki");
    expect(documentDescription(long)).toBe(specification);
    expect(documentDescription(doc({ title: "Invitation to tender" }))).toBeNull();
  });
});
