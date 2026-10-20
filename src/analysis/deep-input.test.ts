import { describe, expect, it } from "vitest";
import { buildDeepMergeMessage, buildDeepMessage, DEEP_LIMITS, deepFileText, deepFileTitle, deepQuoteSources, planDeepParts, type DeepCandidate } from "./deep-input";

const MB = 1024 * 1024;
let made = 0;

function candidate(fields: Partial<DeepCandidate> & Pick<DeepCandidate, "name">): DeepCandidate {
  made++;
  return {
    id: `doc-${made}`,
    kind: "pdf",
    documentType: null,
    origin: "auto",
    text: "Page one\fPage two",
    truncated: false,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, made)),
    storagePath: `t/${made}.pdf`,
    sizeBytes: MB,
    pageCount: 2,
    ...fields,
  };
}

describe("planDeepParts", () => {
  it("reads all the files in one part when they fit, in the order a bid team reads them", () => {
    const prices = candidate({ name: "Prijzenblad.xlsx", kind: "xlsx", text: "## Blad1\nItem\tQty", pageCount: null });
    const spec = candidate({ name: "Technical specification.pdf" });
    const upload = candidate({ name: "notes.docx", kind: "docx", origin: "manual", text: "Our notes", pageCount: null });

    const plan = planDeepParts([prices, spec, upload]);

    expect(plan.files.map((f) => [f.n, f.name, f.as])).toEqual([
      [1, "notes.docx", "text"],
      [2, "Technical specification.pdf", "pdf"],
      [3, "Prijzenblad.xlsx", "text"],
    ]);
    expect(plan.parts.map((p) => p.map((f) => f.n))).toEqual([[1, 2, 3]]);
    expect(plan.skipped).toEqual([]);
  });

  it("starts a new part when the tokens or the bytes of one would run over", () => {
    // 25 pages are about 62,500 tokens: two fit a part, three do not.
    const pages = Array.from({ length: 3 }, (_, i) => candidate({ name: `pages-${i}.pdf`, pageCount: 25 }));
    const bytes = Array.from({ length: 2 }, (_, i) => candidate({ name: `bytes-${i}.pdf`, sizeBytes: 10 * MB }));

    expect(planDeepParts(pages).parts.map((p) => p.length)).toEqual([2, 1]);
    expect(planDeepParts(bytes).parts.map((p) => p.length)).toEqual([1, 1]);
  });

  it("sends a PDF up to a request's pages as a PDF, alone in its part when its estimate is over a part's", () => {
    const spec = candidate({ name: "Bestek.pdf", pageCount: DEEP_LIMITS.partPages });
    const scanned = candidate({ name: "Scan.pdf", pageCount: 70, text: "" });
    const small = candidate({ name: "Bijlage.pdf", pageCount: 2 });

    const plan = planDeepParts([spec, scanned, small]);

    expect(plan.files.map((f) => [f.name, f.as])).toEqual([
      ["Bestek.pdf", "pdf"],
      ["Scan.pdf", "pdf"],
      ["Bijlage.pdf", "pdf"],
    ]);
    // Each large one is alone in its part; a small one starts the next.
    expect(plan.parts.map((p) => p.map((f) => f.name))).toEqual([["Bestek.pdf"], ["Scan.pdf"], ["Bijlage.pdf"]]);
    expect(planDeepParts([candidate({ name: "Big.pdf", pageCount: DEEP_LIMITS.partPages + 1 })]).files[0]!.as).toBe("text");
  });

  it("sends a PDF too large for a part as its text, and leaves out one without text", () => {
    const big = candidate({ name: "Bestek.pdf", pageCount: 300, text: Array.from({ length: 300 }, (_, k) => `Page ${k + 1} text`).join("\f") });
    const scanned = candidate({ name: "Tekeningen.pdf", pageCount: 200, text: "\f\f" });

    const plan = planDeepParts([big, scanned]);

    expect(plan.files.map((f) => [f.name, f.as])).toEqual([["Bestek.pdf", "text"]]);
    expect(plan.skipped.map((s) => [s.candidate.name, s.reason])).toEqual([["Tekeningen.pdf", "Tek seferde okunamayacak kadar büyük PDF ve metni yok (taranmış olabilir)."]]);
  });

  it("reads at most as many parts and files as its limits allow, listing the rest", () => {
    const many = Array.from({ length: DEEP_LIMITS.parts + 1 }, (_, i) => candidate({ name: `big-${i}.pdf`, sizeBytes: 15 * MB }));
    const plan = planDeepParts(many);
    expect(plan.parts).toHaveLength(DEEP_LIMITS.parts);
    expect(plan.skipped.map((s) => s.reason)).toEqual([`Analiz en çok ${DEEP_LIMITS.parts} parçada okur; bu dosyaya sıra gelmedi.`]);

    const plenty = Array.from({ length: DEEP_LIMITS.files + 2 }, (_, i) => candidate({ name: `small-${i}.docx`, kind: "docx", text: "x", pageCount: null }));
    expect(planDeepParts(plenty).skipped).toHaveLength(2);
  });
});

describe("deep messages", () => {
  const spec = candidate({ name: 'Spec "v2" <final>.pdf' });
  const prices = candidate({ name: "Prices.xlsx", kind: "xlsx", text: "Item\tQty", pageCount: null });
  const plan = planDeepParts([spec, prices]);
  const skipped = [{ candidate: candidate({ name: "Scan.pdf" }), reason: "Taranmış" }];

  it("lists the files, marks those of the part, and asks the profiles' questions", () => {
    const text = buildDeepMessage({
      noticeText: "<ilan>notice</ilan>",
      files: plan.files,
      skipped,
      questions: ["Asgari ciro şartı var mı?"],
      part: { files: [plan.files[0]!], no: 1, count: 2 },
    });
    expect(text).toBe(
      [
        "<ilan>notice</ilan>",
        '<dosya_listesi toplam="3">',
        "<dosya sira=\"1\" ad=\"Spec 'v2' final.pdf\" tur=\"pdf\" sayfa=\"2\" bu_partide=\"evet\"/>",
        '<dosya sira="2" ad="Prices.xlsx" tur="xlsx"/>',
        '<dosya ad="Scan.pdf" tur="pdf" alinmadi="Taranmış"/>',
        "</dosya_listesi>",
        "<profil_sorulari>",
        '<soru sira="1">Asgari ciro şartı var mı?</soru>',
        "</profil_sorulari>",
        '<parti no="1" toplam="2"/>',
      ].join("\n"),
    );
    expect(deepFileTitle(plan.files[0]!)).toBe("Dosya 1: Spec 'v2' final.pdf");
  });

  it("gives no part tag when all the files are in one, and gives the merge the parts' answers", () => {
    const single = buildDeepMessage({ noticeText: "<ilan/>", files: plan.files, skipped: [], questions: [], part: { files: plan.files, no: 1, count: 1 } });
    expect(single).not.toContain("<parti");
    const merge = buildDeepMergeMessage({ noticeText: "<ilan/>", files: plan.files, skipped: [], questions: [], parts: [{ a: 1 }, { b: 2 }] });
    expect(merge).toContain('<parti_sonuclari toplam="2">\n<parti no="1">\n{"a":1}\n</parti>\n<parti no="2">\n{"b":2}\n</parti>\n</parti_sonuclari>');
    expect(merge).not.toContain("bu_partide");
  });

  it("sends a PDF as text with its page numbers, and cuts a long text", () => {
    expect(deepFileText({ kind: "pdf", text: "First\f\fThird" }).text).toBe('<sayfa no="1">\nFirst\n</sayfa>\n<sayfa no="3">\nThird\n</sayfa>');
    const long = deepFileText({ kind: "docx", text: "a".repeat(DEEP_LIMITS.textFileChars + 5) });
    expect(long).toMatchObject({ cut: true });
    expect(long.text).toHaveLength(DEEP_LIMITS.textFileChars);
  });

  it("keys the quotable texts: the notice's, a PDF's pages and other files' text", () => {
    const sources = deepQuoteSources({ title: "Notice title" }, plan.files);
    expect(sources).toEqual({ "notice:title": "Notice title", "file:1:p1": "Page one", "file:1:p2": "Page two", "file:2": "Item\tQty" });
  });
});
