import { eq, sql } from "drizzle-orm";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { memoryStorage } from "../../tests/helpers/storage";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertMatch, insertProfile, insertTender } from "../../tests/helpers/tenders";
import { analyses, documents } from "@/db/schema";
import { readStoredFacts } from "@/analysis/facts-evidence";
import { extractFacts, pendingFacts } from "@/analysis/facts";
import type { LlmClient } from "@/analysis/llm";
import { fetchDocuments } from "./fetch-job";
import { processDocuments } from "./process-job";
import type { Extracted, FetchResult } from "./types";

// The documents stage end to end: a public portal page gives a file, the
// worker reads it, the tender goes back to the facts queue, and its facts
// come from the file with the page they were quoted from.

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

const SPEC = strToU8("%PDF-1.7 specification");
const SPEC_TEXT = "1. Scope of supply\fThe supplier shall install the generators on site and commission them.";

const answers: Record<string, FetchResult> = {
  "https://ausschreibungen.giz.de/Satellite/notice/42/documents": { kind: "page", finalUrl: "https://ausschreibungen.giz.de/Satellite/notice/42/documents", login: false, html: "<a href='/files/spec.pdf'>Specification</a>" },
  "https://ausschreibungen.giz.de/files/spec.pdf": {
    kind: "file",
    fileKind: "pdf",
    bytes: SPEC,
    mime: "application/pdf",
    filename: "Specification.pdf",
    finalUrl: "https://ausschreibungen.giz.de/files/spec.pdf",
  },
};

const generators = facts({
  summaryTr: "Jeneratör tedariki, sahada kurulum ve devreye alma.",
  lots: [lot({ productTr: "dizel jeneratör", category: "COMPLEX_GENERATORS", categoryQuote: "install the generators on site" })],
  installation: { value: "REQUIRED", detail: "Sahada kurulum", quote: "The supplier shall install the generators on site" },
});

describe("documents to facts", () => {
  it("reads a file a public portal page gives and quotes it with its page", async () => {
    const { db } = testDb;
    const tenderId = await insertTender(db, { title: "Supply of generators" });
    await insertMatch(db, await insertProfile(db), tenderId);
    const portal = await insertDocument(db, { tenderId, origin: "auto", sourceUrl: "https://ausschreibungen.giz.de/Satellite/notice/42/documents" });
    const { storage } = memoryStorage();

    // Facts from the notice alone first.
    const calls: string[] = [];
    const llm: LlmClient = {
      async complete(request) {
        calls.push(request.user);
        return {
          text: JSON.stringify(generators),
          stopReason: "end_turn",
          refusalCategory: null,
          model: "claude-haiku-5-5",
          usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 },
        };
      },
    };
    await extractFacts(db, llm, tenderId, "claude-haiku-5-5", "Olgu promptu");
    expect(await pendingFacts(db, 10)).toEqual([]);

    // The page gives its file; the worker stores and reads it.
    await fetchDocuments(db, {
      fetchDocument: async (url, { guard }): Promise<FetchResult> => {
        const reason = await guard(url);
        return reason ? { kind: "blocked", finalUrl: url, reason } : answers[url]!;
      },
      wait: async () => {},
      robots: async () => "allowed" as const,
      extractLinks: () => [{ url: "https://ausschreibungen.giz.de/files/spec.pdf", text: "Specification" }],
      storage,
    });
    const read: Extracted = { kind: "pdf", pageCount: 2, text: SPEC_TEXT, truncated: false };
    expect(await processDocuments(db, { extract: async () => read, storage })).toMatchObject({ processed: 1 });
    const [file] = await db.select().from(documents).where(eq(documents.parentDocumentId, portal));
    expect(file).toMatchObject({ filename: "Specification.pdf", pageCount: 2 });

    // A new file for the analysis: the tender is read again (once its files settle), the file with it.
    expect(await pendingFacts(db, 10)).toEqual([]);
    expect(await pendingFacts(db, 10, { settleMinutes: 0 })).toEqual([tenderId]);
    await extractFacts(db, llm, tenderId, "claude-haiku-5-5", "Olgu promptu");
    expect(calls.at(-1)).toContain('<dosya sira="1" ad="Specification.pdf" tur="pdf">');

    const [latest] = await db.select().from(analyses).where(eq(analyses.tenderId, tenderId)).orderBy(sql`${analyses.createdAt} desc`).limit(1);
    expect(latest!.documentIds).toEqual([file!.id]);
    expect(readStoredFacts(latest!.output)!.quoteChecks?.facts.installation).toBe("file:1:p2");
    expect(await pendingFacts(db, 10, { settleMinutes: 0 })).toEqual([]);
  });
});
