import Anthropic from "@anthropic-ai/sdk";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertMatch, insertProfile, insertTender } from "../../tests/helpers/tenders";
import { analyses, criteriaProfiles, deepRequests, tenders } from "@/db/schema";
import { profileRulesSchema } from "@/matching/rules";
import { analyzeTenderDeep, deepQuestions, queueAutoDeep, runDeepRequests, type DeepPrompts } from "./deep";
import { requestDeepAnalysis } from "./deep-requests";
import { readStoredDeep, type DeepOutput } from "./deep-schema";
import { loadDeepView } from "./deep-view";
import type { LlmClient, LlmRequest } from "./llm";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});
afterAll(async () => {
  await testDb.close();
});

const PROMPTS: DeepPrompts = { analysis: "Analiz promptu", merge: "Birleştirme promptu" };
const MODEL = "claude-sonnet-5-5";
const MB = 1024 * 1024;
const PDF = (label: string) => new TextEncoder().encode(`%PDF-1.7 ${label}`);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const empty = { value: "", quote: "", file: 0, page: 0 };

/** A valid analysis; `overrides` replace whole sections. */
function deepOutput(overrides: Partial<DeepOutput> = {}): DeepOutput {
  return {
    summaryTr: "Jeneratör tedariki — teslim Rotterdam.",
    items: [],
    delivery: { location: empty, country: empty, incoterm: empty, leadTime: empty, schedule: empty },
    eligibility: {
      supplierLocation: empty,
      productOrigin: empty,
      minTurnover: { value: "Son üç yılda yıllık en az 500.000 EUR", quote: "minimum annual turnover of EUR 500,000", file: 1, page: 2 },
      references: { value: "İki benzer iş", quote: "two similar contracts in the last three years", file: 0, page: 0 },
      qualityCerts: [],
      insurance: [],
      securityRequirements: empty,
      localPresence: empty,
    },
    commercial: { contractType: empty, duration: empty, pricingBasis: empty, paymentTerms: empty, bonds: empty, penalties: empty, warranty: empty },
    servicesScope: { installation: { value: "Yalnız teslim", quote: "delivery only, no installation", file: 9, page: 1 }, maintenance: empty, training: empty },
    evaluation: [],
    timeline: { clarificationDeadline: empty, submissionDeadline: empty, siteVisit: empty },
    redFlags: [],
    profileAnswers: [],
    missingInfo: ["Teslim süresi"],
    suggestedDecision: { decision: "REVIEW", reasons: ["Ciro şartı incelenmeli"] },
    ...overrides,
  };
}

/** A fake model: answers each call with `answer(request, n)`, a JSON text or an error to throw; records the requests. */
function fakeLlm(answer: (request: LlmRequest, n: number) => unknown): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const result = answer(request, requests.length);
      if (result instanceof Error) throw result;
      return {
        text: typeof result === "string" ? result : JSON.stringify(result),
        stopReason: "end_turn",
        refusalCategory: null,
        model: MODEL,
        usage: { inputTokens: 10_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 },
      };
    },
  };
}

/** A tender with a specification PDF (text on two pages) and a price schedule, stored, and a profile asking a question. */
async function tenderWithFiles(options: { pdfs?: number; pageCount?: number } = {}) {
  const { db } = testDb;
  const tenderId = await insertTender(db, { title: "Supply of generators", description: "Two similar contracts in the last three years are required." });
  const [profile] = await db
    .insert(criteriaProfiles)
    .values({ name: "Güç", active: true, rules: profileRulesSchema.parse({ analysisQuestions: ["Asgari ciro şartı var mı?"] }) })
    .returning({ id: criteriaProfiles.id });
  await insertMatch(db, profile!.id, tenderId);
  const { storage, files } = memoryStorage();
  const ids: string[] = [];
  for (let i = 0; i < (options.pdfs ?? 1); i++) {
    const path = `${tenderId}/spec-${i}.pdf`;
    files.set(path, PDF(`spec ${i}`));
    ids.push(
      await insertDocument(db, {
        tenderId,
        origin: "auto",
        sourceUrl: `https://buyer.example/spec-${i}.pdf`,
        filename: `Specification ${i + 1}.pdf`,
        documentType: "technicalSpecifications",
        mime: "application/pdf",
        fetchStatus: "fetched",
        storagePath: path,
        sizeBytes: MB,
        sha256: `${i}`.padStart(64, "a"),
        pageCount: options.pageCount ?? 2,
        textContent: "General terms.\fThe tenderer shall have a minimum annual turnover of EUR 500,000 in each of the last three years.",
        processedAt: new Date(),
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
      }),
    );
  }
  files.set(`${tenderId}/prices.xlsx`, new Uint8Array([1]));
  ids.push(
    await insertDocument(db, {
      tenderId,
      origin: "auto",
      sourceUrl: "https://buyer.example/prices.xlsx",
      filename: "Price schedule.xlsx",
      mime: XLSX_MIME,
      fetchStatus: "fetched",
      storagePath: `${tenderId}/prices.xlsx`,
      sizeBytes: 1_000,
      sha256: "b".repeat(64),
      textContent: "## Prices\nGenerator 100 kVA\t4",
      processedAt: new Date(),
      createdAt: new Date(Date.UTC(2026, 9, 1, 1, 0)),
    }),
  );
  return { tenderId, storage, ids };
}

describe("analyzeTenderDeep", () => {
  it("reads the notice and the files themselves in one call and checks each quote against them", async () => {
    const { db } = testDb;
    const { tenderId, storage, ids } = await tenderWithFiles();
    const llm = fakeLlm(() => deepOutput());

    const outcome = await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS });

    expect(outcome).toMatchObject({ status: "valid", parts: 1 });
    expect(llm.requests).toHaveLength(1);
    const [request] = llm.requests;
    expect(request!.system).toBe("Analiz promptu");
    expect(request!.documents!.map((d) => [d.kind, d.title])).toEqual([
      ["pdf", "Dosya 1: Specification 1.pdf"],
      ["text", "Dosya 2: Price schedule.xlsx"],
    ]);
    expect(new TextDecoder().decode((request!.documents![0] as { data: Uint8Array }).data)).toBe("%PDF-1.7 spec 0");
    expect(request!.user).toContain("<baslik>Supply of generators</baslik>");
    expect(request!.user).toContain('<soru sira="1">Asgari ciro şartı var mı?</soru>');
    expect(request!.user).not.toContain("<parti");

    const [row] = await db.select().from(analyses).where(eq(analyses.tenderId, tenderId));
    expect(row).toMatchObject({ kind: "deep", promptVersion: "deep.v1", valid: true, documentIds: ids });
    const stored = readStoredDeep(row!.output)!;
    // Turkish without an em dash; quotes located: the cited page, the notice, and one found nowhere.
    expect(stored.output.summaryTr).toBe("Jeneratör tedariki, teslim Rotterdam.");
    expect(stored.quoteChecks).toEqual({
      "eligibility.minTurnover": "file:1:p2",
      "eligibility.references": "notice:description",
      "servicesScope.installation": null,
    });
    expect(stored).toMatchObject({ parts: 1, skipped: [] });
  });

  it("reads files that do not fit one request in parts, merges them, and counts every call in the result's cost", async () => {
    const { db } = testDb;
    // Three 25-page PDFs: two fit a part.
    const { tenderId, storage } = await tenderWithFiles({ pdfs: 3, pageCount: 25 });
    const llm = fakeLlm((request) => (request.system === PROMPTS.merge ? deepOutput({ missingInfo: ["Teslim yeri"] }) : deepOutput({ missingInfo: [] })));

    const outcome = await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS });

    expect(outcome).toMatchObject({ status: "valid", parts: 2 });
    expect(llm.requests.map((r) => r.system)).toEqual([PROMPTS.analysis, PROMPTS.analysis, PROMPTS.merge]);
    expect(llm.requests[0]!.user).toContain('<parti no="1" toplam="2"/>');
    expect(llm.requests[0]!.documents!.map((d) => d.title)).toEqual(["Dosya 1: Specification 1.pdf", "Dosya 2: Specification 2.pdf"]);
    expect(llm.requests[1]!.documents!.map((d) => d.title)).toEqual(["Dosya 3: Specification 3.pdf", "Dosya 4: Price schedule.xlsx"]);
    expect(llm.requests[2]!.documents).toBeUndefined();
    expect(llm.requests[2]!.user).toContain('<parti_sonuclari toplam="2">');

    const rows = await db.select().from(analyses).where(eq(analyses.tenderId, tenderId)).orderBy(analyses.createdAt);
    expect(rows.map((r) => [r.promptVersion, readStoredDeep(r.output) !== null])).toEqual([
      ["deep.v1", false],
      ["deep.v1", false],
      ["deep-merge.v1", true],
    ]);
    const view = await loadDeepView(db, tenderId);
    expect(view).toMatchObject({ state: "done", result: { parts: 2, output: { missingInfo: ["Teslim yeri"] } } });
    expect(view.result!.costUsd).toBeCloseTo(rows.reduce((sum, r) => sum + r.costUsd, 0), 6);
    expect(view.result!.files.map((f) => [f.n, f.name])).toEqual([
      [1, "Specification 1.pdf"],
      [2, "Specification 2.pdf"],
      [3, "Specification 3.pdf"],
      [4, "Price schedule.xlsx"],
    ]);
  });

  it("splits a request the API finds too long, and lists the files of a part whose answer stays invalid", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles();
    const tooLong = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } },
      undefined,
      new Headers(),
    );
    const llm = fakeLlm((request, n) => {
      if (n === 1) return tooLong;
      if (request.system === PROMPTS.merge) return deepOutput();
      // The price schedule's part answers what is no analysis, twice.
      return request.documents?.[0]?.title.includes("Price") ? "not json" : deepOutput();
    });

    const outcome = await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS });

    expect(outcome).toMatchObject({ status: "valid", parts: 1 });
    expect(llm.requests.map((r) => r.documents?.map((d) => d.title) ?? "merge")).toEqual([
      ["Dosya 1: Specification 1.pdf", "Dosya 2: Price schedule.xlsx"],
      ["Dosya 1: Specification 1.pdf"],
      ["Dosya 2: Price schedule.xlsx"],
      ["Dosya 2: Price schedule.xlsx"],
      "merge",
    ]);
    const view = await loadDeepView(db, tenderId);
    expect(view.result!.skipped).toEqual([{ documentId: expect.any(String), name: "Price schedule.xlsx", reason: "Bu dosyaların analizi geçerli bir yanıt vermedi." }]);
  });
});

describe("analyzeTenderDeep when parts fail", () => {
  it("lists the files of a part with no valid answer only as left out, numbering the parts as tried", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles({ pdfs: 3, pageCount: 40 });
    const llm = fakeLlm((request) => {
      if (request.system === PROMPTS.merge) return deepOutput();
      return request.documents?.[0]?.title.startsWith("Dosya 2:") ? "not json" : deepOutput();
    });

    const outcome = await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS });

    expect(outcome).toMatchObject({ status: "valid", parts: 2 });
    const parts = llm.requests.filter((r) => r.system === PROMPTS.analysis).map((r) => /<parti no="(\d)" toplam="(\d)"\/>/.exec(r.user)!.slice(1).join("/"));
    expect(parts).toEqual(["1/3", "2/3", "2/3", "3/3"]);
    const merge = llm.requests.at(-1)!.user;
    expect(merge).not.toContain('<dosya sira="2"');
    expect(merge).toContain('<dosya ad="Specification 2.pdf" tur="pdf" alinmadi="Bu dosyaların analizi geçerli bir yanıt vermedi."/>');
    const view = await loadDeepView(db, tenderId);
    expect(view.result!.files.map((f) => [f.n, f.name])).toEqual([
      [1, "Specification 1.pdf"],
      [3, "Specification 3.pdf"],
      [4, "Price schedule.xlsx"],
    ]);
    expect(view.result!.skipped.map((s) => s.name)).toEqual(["Specification 2.pdf"]);
  });

  it("reads a single PDF the API finds too long as its text, and the notice alone when it has none", async () => {
    const { db } = testDb;
    const tooLong = () =>
      Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }, undefined, new Headers());
    const { tenderId, storage, ids } = await tenderWithFiles();
    // Only the specification: the price schedule is gone.
    await db.delete(analyses);
    await testDb.db.execute(sql`delete from documents where id = ${ids[1]!}`);
    const llm = fakeLlm((request) => (request.documents?.[0]?.kind === "pdf" ? tooLong() : deepOutput()));

    expect(await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS })).toMatchObject({ status: "valid", parts: 1 });
    expect(llm.requests.map((r) => r.documents?.map((d) => d.kind))).toEqual([["pdf"], ["text"]]);
    expect(llm.requests[1]!.user).toContain('<dosya sira="1" ad="Specification 1.pdf" tur="pdf" sayfa="2" metin_olarak="evet" bu_partide="evet"/>');

    // A scanned one has no text to fall back on: left out, and the notice is analysed alone.
    await testDb.db.execute(sql`update documents set text_content = '' where id = ${ids[0]!}`);
    const scanned = fakeLlm((request) => (request.documents?.length ? tooLong() : deepOutput()));
    expect(await analyzeTenderDeep(db, { llm: scanned, storage }, tenderId, { model: MODEL, prompts: PROMPTS })).toMatchObject({ status: "valid", parts: 1 });
    expect(scanned.requests.map((r) => r.documents?.length ?? 0)).toEqual([1, 0]);
    const view = await loadDeepView(db, tenderId);
    expect(view.result!.skipped).toEqual([{ documentId: ids[0], name: "Specification 1.pdf", reason: "Dosya tek başına bir isteğe sığmayacak kadar büyük." }]);
  });

  it("verifies a deadline quoted from the notice's structured lines", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles();
    await db.update(tenders).set({ submissionDeadline: new Date("2026-11-30T11:00:00Z") }).where(eq(tenders.id, tenderId));
    let quoted = "";
    const llm = fakeLlm((request) => {
      quoted = /Son teklif[^\n<]*/.exec(request.user)?.[0] ?? "";
      return deepOutput({ timeline: { clarificationDeadline: empty, submissionDeadline: { value: "30 Kasım 2026", quote: quoted, file: 0, page: 0 }, siteVisit: empty } });
    });

    await analyzeTenderDeep(db, { llm, storage }, tenderId, { model: MODEL, prompts: PROMPTS });

    expect(quoted).not.toBe("");
    expect((await loadDeepView(db, tenderId)).result!.quoteChecks["timeline.submissionDeadline"]).toBe("notice:info");
  });
});

describe("deep results on the page", () => {
  it("finds the result past many later part answers, and counts only the calls of its request", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles();
    // An earlier failed request: its calls are not this result's.
    await db.insert(analyses).values({ tenderId, kind: "deep", model: MODEL, promptVersion: "deep.v1", valid: false, costUsd: 0.5, createdAt: new Date(Date.now() - 3_600_000) });
    await requestDeepAnalysis(db, tenderId, "ekip@bozkor.com");
    await runDeepRequests(db, { llm: fakeLlm(() => deepOutput()), storage, log: () => {} }, { model: MODEL, prompts: PROMPTS });
    const [result] = await db.select().from(analyses).where(eq(analyses.valid, true));
    // Many later parts of analyses whose merge never came.
    await db.insert(analyses).values(
      Array.from({ length: 31 }, () => ({ tenderId, kind: "deep" as const, model: MODEL, promptVersion: "deep.v1", valid: true, output: { part: 1, parts: 2, output: deepOutput() }, costUsd: 0.1 })),
    );

    const view = await loadDeepView(db, tenderId);

    expect(view.result!.analysisId).toBe(result!.id);
    expect(view.result!.costUsd).toBeCloseTo(result!.costUsd, 6);
  });
});

describe("the deep analysis queue", () => {
  it("analyses a requested tender and records how the request ended", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles();
    expect(await requestDeepAnalysis(db, tenderId, "ekip@bozkor.com")).toBe(true);
    // One open request per tender.
    expect(await requestDeepAnalysis(db, tenderId, "ekip@bozkor.com")).toBe(false);
    expect(await loadDeepView(db, tenderId)).toMatchObject({ state: "queued", result: null });

    const stats = await runDeepRequests(db, { llm: fakeLlm(() => deepOutput()), storage, log: () => {} }, { model: MODEL, prompts: PROMPTS });

    expect(stats).toMatchObject({ analysed: 1, failed: 0 });
    const [request] = await db.select().from(deepRequests);
    expect(request).toMatchObject({ status: "done", requestedBy: "ekip@bozkor.com" });
    expect(request!.analysisId).not.toBeNull();
    expect(await loadDeepView(db, tenderId)).toMatchObject({ state: "done", request: { status: "done" } });
  });

  it("past the month's budget runs only what a team member asked for", async () => {
    const { db } = testDb;
    process.env.LLM_MONTHLY_BUDGET_USD = "1";
    try {
      const auto = await tenderWithFiles();
      await db.insert(analyses).values({ tenderId: auto.tenderId, kind: "facts", model: MODEL, promptVersion: "facts.v5", costUsd: 2 });
      await requestDeepAnalysis(db, auto.tenderId, null);
      const llm = fakeLlm(() => deepOutput());

      expect(await runDeepRequests(db, { llm, storage: auto.storage, log: () => {} }, { model: MODEL, prompts: PROMPTS })).toMatchObject({ analysed: 0 });
      expect(llm.requests).toHaveLength(0);

      const manual = await tenderWithFiles();
      await requestDeepAnalysis(db, manual.tenderId, "ekip@bozkor.com");
      expect(await runDeepRequests(db, { llm, storage: manual.storage, log: () => {} }, { model: MODEL, prompts: PROMPTS, limit: 5 })).toMatchObject({ analysed: 1 });
      const open = await db.select().from(deepRequests).where(eq(deepRequests.status, "queued"));
      expect(open.map((r) => r.requestedBy)).toEqual([null]);
    } finally {
      delete process.env.LLM_MONTHLY_BUDGET_USD;
    }
  });

  it("marks a request failed when the analysis cannot finish", async () => {
    const { db } = testDb;
    const { tenderId, storage } = await tenderWithFiles();
    await requestDeepAnalysis(db, tenderId, "ekip@bozkor.com");

    await runDeepRequests(db, { llm: fakeLlm(() => "not json"), storage, log: () => {} }, { model: MODEL, prompts: PROMPTS });

    const [request] = await db.select().from(deepRequests).orderBy(desc(deepRequests.requestedAt));
    expect(request).toMatchObject({ status: "failed", error: "Analiz geçerli bir yanıt vermedi." });
    expect(await loadDeepView(db, tenderId)).toMatchObject({ state: "failed", result: null });
  });

  it("asks for the first analysis of tenders a profile with autoAnalyze matches, once", async () => {
    const { db } = testDb;
    const { tenderId } = await tenderWithFiles();
    expect(await queueAutoDeep(db, { settleMinutes: 0 })).toBe(0);

    const [auto] = await db
      .insert(criteriaProfiles)
      .values({ name: "Otomatik", active: true, rules: profileRulesSchema.parse({ autoAnalyze: true }) })
      .returning({ id: criteriaProfiles.id });
    await insertMatch(db, auto!.id, tenderId);
    // A tender of the profile without a file to read waits.
    await insertMatch(db, auto!.id, await insertTender(db));

    expect(await queueAutoDeep(db, { settleMinutes: 0 })).toBe(1);
    expect(await queueAutoDeep(db, { settleMinutes: 0 })).toBe(0);
    const requests = await db.select().from(deepRequests);
    expect(requests.map((r) => [r.tenderId, r.requestedBy])).toEqual([[tenderId, null]]);

    // Failed a day ago, and only the parts of an analysis were answered: asked again, but not after two failures.
    const failDayAgo = () =>
      db.update(deepRequests).set({ status: "failed", finishedAt: sql`now() - interval '25 hours'` }).where(eq(deepRequests.status, "queued"));
    await failDayAgo();
    await db.insert(analyses).values({ tenderId, kind: "deep", model: MODEL, promptVersion: "deep.v1", valid: true, output: { part: 1, parts: 2, output: deepOutput() } });
    expect(await queueAutoDeep(db, { settleMinutes: 0 })).toBe(1);
    await failDayAgo();
    expect(await queueAutoDeep(db, { settleMinutes: 0 })).toBe(0);
  });

  it("asks each profile question once", async () => {
    const { db } = testDb;
    const { tenderId } = await tenderWithFiles();
    const [second] = await db
      .insert(criteriaProfiles)
      .values({ name: "Giyim", active: true, rules: profileRulesSchema.parse({ analysisQuestions: ["Asgari ciro şartı var mı?", "Menşe kısıtı var mı?"] }) })
      .returning({ id: criteriaProfiles.id });
    await insertMatch(db, second!.id, tenderId);
    // An inactive profile asks nothing.
    await insertMatch(db, await insertProfile(db, false), tenderId);

    expect(await deepQuestions(db, tenderId)).toEqual(["Asgari ciro şartı var mı?", "Menşe kısıtı var mı?"]);
  });
});
