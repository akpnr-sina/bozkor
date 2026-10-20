import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db";
import { analyses, criteriaProfiles, deepRequests, documents, profileMatches, tenders } from "@/db/schema";
import { fetchWanted } from "@/documents/fetch-job";
import { analysisInputIds } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import type { DocumentStorage } from "@/documents/storage";
import { profileRulesSchema } from "@/matching/rules";
import { monthlyLlmSpend } from "./budget";
import {
  buildDeepMergeMessage,
  buildDeepMessage,
  deepFileText,
  deepFileTitle,
  deepQuoteSources,
  planDeepParts,
  textTokens,
  type DeepCandidate,
  type DeepFile,
  type DeepSkipped,
} from "./deep-input";
import { claimDeepRequest, finishDeepRequest, requestDeepAnalysis } from "./deep-requests";
import { deepOutputSchema, deepQuotes, type DeepOutput, type StoredDeep } from "./deep-schema";
import { buildFactsInput } from "./facts-input";
import { FILES_SETTLE_MINUTES, loadFactsNotice } from "./facts";
import { isPromptTooLong, llmErrorStatus, type LlmClient, type LlmDocument } from "./llm";
import { hasPrice } from "./pricing";
import { quoteFinder } from "./quotes";
import { apiErrorText, completeValidated, noEmDash, recordAnalysis, schemaError, type Parsed } from "./runner";

// The deep analysis of a tender (SPEC 7.2, Faz 6): the analysis model reads
// the notice and the tender's files themselves (PDFs as PDFs) and writes what
// the bid team needs, each claim with its excerpt. Files that do not fit one
// request are read in parts and the parts merged. Every call is recorded with
// its cost (rule 7), answers are validated and retried once (rule 6), quotes
// are checked against the files' text (rule 5); the decision it suggests is
// the team's to take (rule 4). Asked for from the tender page, or by a profile
// with autoAnalyze for its matches.

export const DEEP_PROMPT_VERSION = "deep.v1";
export const DEEP_MERGE_PROMPT_VERSION = "deep-merge.v1";
export const deepModel = (): string => process.env.LLM_ANALYSIS_MODEL?.trim() || "claude-sonnet-5-5";

/** Output room of one call, thinking included: an analysis runs to several thousand tokens. Calls are streamed (no 10-minute ceiling). */
const DEEP_MAX_TOKENS = 32_000;

/** The system prompt with the answer's JSON Schema appended (too large for the API's output grammar, as the facts'). */
export function deepSystemPrompt(prompt: string): string {
  return [
    prompt.trimEnd(),
    "",
    "## Yanıt biçimi",
    "",
    "Yanıtın, aşağıdaki JSON şemasına uyan tek bir JSON nesnesi olsun. Önüne ya da arkasına metin ya da kod bloğu işareti ekleme. Alan adlarını ve kodları şemadaki gibi aynen yaz; her alanı yaz.",
    "",
    JSON.stringify(z.toJSONSchema(deepOutputSchema)),
    "",
  ].join("\n");
}

export type DeepPrompts = { analysis: string; merge: string };

export function loadDeepPrompts(): DeepPrompts {
  const read = (version: string) => readFileSync(path.join(process.cwd(), "prompts", `${version}.md`), "utf8");
  return { analysis: deepSystemPrompt(read(DEEP_PROMPT_VERSION)), merge: deepSystemPrompt(read(DEEP_MERGE_PROMPT_VERSION)) };
}

/** Its Turkish texts without an em dash (CLAUDE.md); quotes stay as the documents wrote them. */
function cleanDeep(output: DeepOutput): DeepOutput {
  const text = (value: string) => noEmDash(value);
  const claim = <T extends { value: string }>(c: T): T => ({ ...c, value: text(c.value) });
  const section = <T extends Record<string, unknown>>(s: T): T =>
    Object.fromEntries(
      Object.entries(s).map(([key, value]) => [key, Array.isArray(value) ? value.map((c) => claim(c as { value: string })) : claim(value as { value: string })]),
    ) as T;
  return {
    ...output,
    summaryTr: text(output.summaryTr),
    items: output.items.map((i) => ({
      ...i,
      description: text(i.description),
      quantity: text(i.quantity),
      unit: text(i.unit),
      specs: i.specs.map(text),
      standards: i.standards.map(text),
      certifications: i.certifications.map(text),
    })),
    delivery: section(output.delivery),
    eligibility: section(output.eligibility),
    commercial: section(output.commercial),
    servicesScope: section(output.servicesScope),
    timeline: section(output.timeline),
    evaluation: output.evaluation.map((e) => ({ ...e, criterion: text(e.criterion), weight: text(e.weight) })),
    redFlags: output.redFlags.map((r) => ({ ...r, issue: text(r.issue) })),
    profileAnswers: output.profileAnswers.map((a) => ({ ...a, answer: text(a.answer) })),
    missingInfo: output.missingInfo.map(text),
    suggestedDecision: { ...output.suggestedDecision, reasons: output.suggestedDecision.reasons.map(text) },
  };
}

export function parseDeep(value: unknown): Parsed<DeepOutput> {
  const parsed = deepOutputSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: schemaError(parsed.error.issues) };
  return { ok: true, output: cleanDeep(parsed.data) };
}

/**
 * Where each quote of the output is in the texts the analysis read (rule 5):
 * the page the model cited first, then its file, then anywhere; null when
 * found nowhere (shown as unverified).
 */
export function checkDeepQuotes(output: DeepOutput, find: ReturnType<typeof quoteFinder>, files: readonly DeepFile[]): Record<string, string | null> {
  const checks: Record<string, string | null> = {};
  for (const q of deepQuotes(output)) {
    const file = files[q.file - 1];
    const prefer = file
      ? [
          ...(q.page > 0 ? [`file:${file.n}:p${q.page}`] : []),
          `file:${file.n}`,
          ...Array.from({ length: file.pageCount ?? 0 }, (_, k) => `file:${file.n}:p${k + 1}`),
        ]
      : [];
    checks[q.path] = find(q.quote, prefer);
  }
  return checks;
}

const MIME_KIND: Record<string, DeepCandidate["kind"]> = { [KIND_MIME.pdf]: "pdf", [KIND_MIME.docx]: "docx", [KIND_MIME.xlsx]: "xlsx" };

/** The tender's files the analysis may read: its analysis inputs (analysisInputIds), PDFs without text too. */
async function loadDeepCandidates(db: AppDb, tenderId: string): Promise<DeepCandidate[]> {
  const rows = await db
    .select({
      id: documents.id,
      filename: documents.filename,
      title: documents.title,
      mime: documents.mime,
      documentType: documents.documentType,
      origin: documents.origin,
      text: documents.textContent,
      truncated: documents.textTruncated,
      pageCount: documents.pageCount,
      sha256: documents.sha256,
      fetchStatus: documents.fetchStatus,
      storagePath: documents.storagePath,
      sizeBytes: documents.sizeBytes,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.tenderId, tenderId), isNotNull(documents.storagePath), isNotNull(documents.processedAt)))
    // The earliest copy of a content is the one read.
    .orderBy(documents.createdAt, documents.id);
  const inputs = analysisInputIds(rows.map((r) => ({ ...r, stored: true, processed: true, textChars: r.text?.length ?? 0 })));
  return rows
    .filter((r) => inputs.has(r.id) && r.mime && MIME_KIND[r.mime])
    .map((r) => ({
      id: r.id,
      name: r.filename ?? r.title ?? "dosya",
      kind: MIME_KIND[r.mime!]!,
      documentType: r.documentType,
      origin: r.origin,
      text: r.text ?? "",
      truncated: r.truncated,
      createdAt: r.createdAt,
      storagePath: r.storagePath!,
      sizeBytes: r.sizeBytes ?? 0,
      pageCount: r.pageCount,
    }));
}

/** The questions of the active profiles the tender currently matches, each once, in profile order (SPEC 6, analysisQuestions). */
export async function deepQuestions(db: AppDb, tenderId: string): Promise<string[]> {
  const rows = await db
    .select({ rules: criteriaProfiles.rules })
    .from(profileMatches)
    .innerJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
    .where(and(eq(profileMatches.tenderId, tenderId), isNull(profileMatches.unmatchedAt), eq(criteriaProfiles.active, true)))
    .orderBy(criteriaProfiles.createdAt);
  const questions: string[] = [];
  for (const { rules } of rows) {
    const parsed = profileRulesSchema.safeParse(rules);
    for (const q of parsed.success ? parsed.data.analysisQuestions : []) if (!questions.includes(q)) questions.push(q);
  }
  return questions.slice(0, 20);
}

/** The structured lines of the notice (`<bilgiler>`, each lot's `<lot_bilgileri>`): the deadline and the value are quoted from them. */
export function noticeInfoSources(noticeText: string): Record<string, string> {
  const sources: Record<string, string> = {};
  const info = /<bilgiler>([\s\S]*?)<\/bilgiler>/.exec(noticeText);
  if (info?.[1]?.trim()) sources.info = info[1];
  [...noticeText.matchAll(/<lot_bilgileri>([\s\S]*?)<\/lot_bilgileri>/g)].forEach((m, i) => {
    if (m[1]?.trim()) sources[`lot-info:${i + 1}`] = m[1];
  });
  return sources;
}

export type DeepDeps = { llm: LlmClient; storage: DocumentStorage; log?: (message: string) => void };

export type DeepOutcome =
  | { status: "valid"; analysisId: string; costUsd: number; parts: number }
  | { status: "invalid" | "gone"; costUsd: number; error: string };

/**
 * Analyses one tender: its files in parts (one when they fit), the parts
 * merged, quotes checked, every call recorded (kind "deep"); the result is
 * the call whose output is a StoredDeep. A part the API finds too long is
 * split in two; a PDF alone in one goes again as its text, and without text
 * it is left out (the notice is still analysed). A part whose answer stays
 * invalid is left out, its files listed with why. API errors other than a
 * too long prompt end the analysis (recorded, rethrown).
 */
export async function analyzeTenderDeep(db: AppDb, deps: DeepDeps, tenderId: string, options: { model: string; prompts: DeepPrompts }): Promise<DeepOutcome> {
  const log = deps.log ?? (() => {});
  const loaded = await loadFactsNotice(db, tenderId);
  if (!loaded) return { status: "gone", costUsd: 0, error: "İhale bulunamadı." };
  // The notice as the facts stage reads it, without its files: the files go as themselves.
  const { text: noticeText, sources: noticeSources } = buildFactsInput({ ...loaded.notice, files: undefined, filesOmitted: undefined });
  const [candidates, questions] = await Promise.all([loadDeepCandidates(db, tenderId), deepQuestions(db, tenderId)]);
  const plan = planDeepParts(candidates);
  const { files } = plan;
  const skipped: DeepSkipped[] = [...plan.skipped];
  const find = quoteFinder(deepQuoteSources({ ...noticeSources, ...noticeInfoSources(noticeText) }, files));
  // The numbers the model cites stay those of the plan: a file left out later keeps its number unused.
  const documentIds = files.map((f) => f.id);
  let costUsd = 0;
  let partsRead = 1;

  const stored = (output: DeepOutput): StoredDeep => ({
    output,
    quoteChecks: checkDeepQuotes(output, find, files),
    parts: partsRead,
    skipped: skipped.map((s) => ({ documentId: s.candidate.id, name: s.candidate.name, reason: s.reason })),
    inputUpdatedAt: loaded.updatedAt.toISOString(),
  });
  const record = (promptVersion: string) => (entry: Parameters<typeof recordAnalysis>[2]) =>
    recordAnalysis(db, { tenderId, profileId: null, kind: "deep", promptVersion, documentIds }, entry);

  /** The part's files as the model reads them: PDFs from storage, others as text. */
  const documentsOf = async (part: readonly DeepFile[]): Promise<LlmDocument[]> =>
    Promise.all(
      part.map(async (file): Promise<LlmDocument> =>
        file.as === "pdf"
          ? { kind: "pdf", data: await deps.storage.download(file.storagePath), title: deepFileTitle(file) }
          : { kind: "text", text: deepFileText(file).text, title: deepFileTitle(file) },
      ),
    );

  /** One call over some files; `final` when its answer is the result (all the files in one part). */
  const call = async (part: readonly DeepFile[], no: number, count: number, final: boolean) => {
    const result = await completeValidated(deps.llm, {
      request: {
        model: options.model,
        system: options.prompts.analysis,
        user: buildDeepMessage({ noticeText, files, skipped, questions, part: { files: part, no, count } }),
        documents: await documentsOf(part),
        effort: "medium",
        stream: true,
      },
      maxTokens: DEEP_MAX_TOKENS,
      parse: parseDeep,
      stored: final ? stored : (output) => ({ part: no, parts: count, output }),
      record: record(DEEP_PROMPT_VERSION),
    });
    costUsd += result.costUsd;
    return result;
  };

  // One part when the files fit (its answer is the result), else part by part and merged.
  const queue: DeepFile[][] = plan.parts.length ? [...plan.parts] : [[]];
  let single = queue.length === 1;
  const outputs: DeepOutput[] = [];
  let tried = 0;
  while (queue.length) {
    const part = queue.shift()!;
    tried++;
    // Its number among the parts tried and still to try: a split adds parts.
    const no = tried;
    const count = tried + queue.length;
    try {
      const result = await call(part, single ? 1 : no, single ? 1 : count, single);
      if (single) {
        if (result.status === "valid") return { status: "valid", analysisId: result.analysisId, costUsd, parts: 1 };
        return { status: "invalid", costUsd, error: "Analiz geçerli bir yanıt vermedi." };
      }
      if (result.status === "valid") outputs.push(result.output);
      else for (const file of part) skipped.push({ candidate: file, reason: "Bu dosyaların analizi geçerli bir yanıt vermedi." });
    } catch (error) {
      if (!isPromptTooLong(error)) throw error;
      const [only] = part;
      if (part.length > 1) {
        log(`[deep] ${tenderId}: istek çok uzun, dosyalar ikiye bölünüyor.`);
        single = false;
        const half = Math.ceil(part.length / 2);
        queue.unshift(part.slice(0, half), part.slice(half));
      } else if (only && only.as === "pdf" && deepFileText(only).text.trim()) {
        // The same file again, as its text: the part stays what it was, and the file list says so.
        const asText: DeepFile = { ...only, as: "text", tokens: textTokens(deepFileText(only).text) };
        files[only.n - 1] = asText;
        queue.unshift([asText]);
      } else if (only) {
        skipped.push({ candidate: only, reason: "Dosya tek başına bir isteğe sığmayacak kadar büyük." });
        // Nothing left to read but the notice: it is analysed alone.
        if (single) queue.unshift([]);
      } else {
        throw error;
      }
      tried--;
    }
  }
  if (!outputs.length) return { status: "invalid", costUsd, error: "Hiçbir parça geçerli bir yanıt vermedi." };
  partsRead = outputs.length;
  const merged = await completeValidated(deps.llm, {
    request: {
      model: options.model,
      system: options.prompts.merge,
      user: buildDeepMergeMessage({ noticeText, files, skipped, questions, parts: outputs }),
      effort: "medium",
      stream: true,
    },
    maxTokens: DEEP_MAX_TOKENS,
    parse: parseDeep,
    stored,
    record: record(DEEP_MERGE_PROMPT_VERSION),
  });
  costUsd += merged.costUsd;
  if (merged.status === "valid") return { status: "valid", analysisId: merged.analysisId, costUsd, parts: partsRead };
  return { status: "invalid", costUsd, error: "Parçalar birleştirilemedi: geçerli bir yanıt gelmedi." };
}

export type DeepRunStats = {
  analysed: number;
  failed: number;
  costUsd: number;
  /** Automatic requests wait while the month's budget is spent; manual ones run (rule 7). */
  stoppedBy: "auth" | "credit" | null;
};

/** How the API says the account has run out of prepaid credit (HTTP 400). */
const NO_CREDIT = /credit balance is too low/i;

/**
 * Takes up to `limit` requests from the queue and analyses each. Past the
 * month's budget only requests a team member made run (rule 7: a manual
 * trigger runs with a warning, which the page shows).
 */
export async function runDeepRequests(db: AppDb, deps: DeepDeps, options: { limit?: number; model?: string; prompts?: DeepPrompts } = {}): Promise<DeepRunStats> {
  const log = deps.log ?? console.log;
  const model = options.model ?? deepModel();
  if (!hasPrice(model)) throw new Error(`"${model}" modelinin fiyatı tanımlı değil; maliyet kaydedilemeyeceği için derin analiz çalışmaz (src/analysis/pricing.ts).`);
  const prompts = options.prompts ?? loadDeepPrompts();
  const stats: DeepRunStats = { analysed: 0, failed: 0, costUsd: 0, stoppedBy: null };
  for (let i = 0; i < (options.limit ?? 2); i++) {
    const budget = await monthlyLlmSpend(db);
    const request = await claimDeepRequest(db, { manualOnly: budget.exceeded });
    if (!request) break;
    try {
      const outcome = await analyzeTenderDeep(db, deps, request.tenderId, { model, prompts });
      stats.costUsd += outcome.costUsd;
      if (outcome.status === "valid") {
        await finishDeepRequest(db, request.id, { analysisId: outcome.analysisId });
        stats.analysed++;
      } else {
        await finishDeepRequest(db, request.id, { error: outcome.error });
        stats.failed++;
      }
    } catch (error) {
      await finishDeepRequest(db, request.id, { error: apiErrorText(error) });
      stats.failed++;
      log(`[deep] ${request.tenderId}: ${apiErrorText(error)}`);
      const status = llmErrorStatus(error);
      if (status === 401 || status === 403) stats.stoppedBy = "auth";
      else if (status === 400 && NO_CREDIT.test(error instanceof Error ? error.message : String(error))) stats.stoppedBy = "credit";
      if (stats.stoppedBy) break;
    }
  }
  return stats;
}

/** A failed automatic analysis is not asked for again before this long, nor after this many failures. */
const AUTO_RETRY_HOURS = 24;
const AUTO_MAX_FAILURES = 2;

/**
 * Asks for the first deep analysis of tenders a profile with autoAnalyze
 * matches: open and fetched (fetchWanted), with a file to read, none still
 * being read and its files settled, never analysed and with no open or
 * recently failed request, and not after two failed ones. Later analyses are
 * the team's to ask for (the page says when one is stale). Returns how many
 * were queued.
 */
export async function queueAutoDeep(db: AppDb, options: { limit?: number; settleMinutes?: number } = {}): Promise<number> {
  const settle = options.settleMinutes ?? FILES_SETTLE_MINUTES;
  const rows = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(
      and(
        fetchWanted(),
        sql`exists (
          select 1 from ${profileMatches} pm join ${criteriaProfiles} cp on cp.id = pm.profile_id and cp.active
          where pm.tender_id = ${tenders.id} and pm.unmatched_at is null and (cp.rules->>'autoAnalyze')::boolean is true)`,
        sql`exists (select 1 from ${documents} d where d.tender_id = ${tenders.id} and d.fetch_status = 'fetched' and d.storage_path is not null and d.processed_at is not null)`,
        sql`not exists (select 1 from ${documents} d where d.tender_id = ${tenders.id} and d.storage_path is not null and d.processed_at is null)`,
        sql`(${tenders.documentsChangedAt} is null or ${tenders.documentsChangedAt} < now() - make_interval(mins => ${settle}))`,
        // A result (what the page shows), not the parts of an analysis whose merge failed.
        sql`not exists (select 1 from ${analyses} a where a.tender_id = ${tenders.id} and a.kind = 'deep' and a.valid and a.output -> 'quoteChecks' is not null)`,
        sql`not exists (
          select 1 from ${deepRequests} r where r.tender_id = ${tenders.id}
          and (r.status in ('queued', 'running') or (r.status = 'failed' and r.finished_at > now() - make_interval(hours => ${AUTO_RETRY_HOURS}))))`,
        // After a couple of failed automatic analyses the team asks for the next one: each pays for its parts.
        sql`(select count(*) from ${deepRequests} r where r.tender_id = ${tenders.id} and r.status = 'failed' and r.requested_by is null) < ${AUTO_MAX_FAILURES}`,
      ),
    )
    .orderBy(sql`${tenders.submissionDeadline} asc nulls last`)
    .limit(options.limit ?? 10);
  let queued = 0;
  for (const { id } of rows) if (await requestDeepAnalysis(db, id, null)) queued++;
  return queued;
}
