import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db";
import { lotLabel } from "@/lib/format";
import { analyses, criteriaProfiles, documents, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { sourcesHash } from "./evidence";
import { checkFactsQuotes, type StoredFacts } from "./facts-evidence";
import { analysisInputIds } from "@/documents/queries";
import { KIND_MIME } from "@/documents/sniff";
import { buildFactsInput, selectFactsFiles, type FactsFileCandidate, type FactsNotice } from "./facts-input";
import { factsOutputSchema, type FactsOutput } from "./facts-schema";
import type { LlmClient } from "./llm";
import { toTriageNotice } from "./notice";
import {
  completeValidated,
  noEmDash,
  recordAnalysis,
  runWithinBudget,
  schemaError,
  type AnalysisOutcome,
  type Parsed,
  type RunOptions,
  type RunStats,
} from "./runner";

// Fact extraction, the first stage of the qualification policy (part XII.2):
// the model reads the notice and states what it says, with quotes; the policy
// engine (src/policy) turns the facts into scores and a decision. Facts do not
// depend on the profile, so there is one extraction per tender.

export const FACTS_PROMPT_VERSION = "facts.v5";
// Thirty lots and seventeen facts with quotes make long answers; thinking counts against the limit too.
const MAX_TOKENS = 16_000;

/** Facts use the triage model: the notice-level stage (SPEC 7.1). */
export const factsModel = (): string => process.env.LLM_TRIAGE_MODEL?.trim() || "claude-haiku-5-5";

export function loadFactsPrompt(version = FACTS_PROMPT_VERSION): string {
  return readFileSync(path.join(process.cwd(), "prompts", `${version}.md`), "utf8");
}

/**
 * The system prompt with the answer's JSON Schema appended. The schema is too
 * large for the API's output grammar ("compiled grammar is too large", 16
 * October 2026), so the model reads it here and the answer is validated in
 * code (rule 6). Same text for every call, so it stays cached.
 */
export function factsSystemPrompt(prompt: string): string {
  return [
    prompt.trimEnd(),
    "",
    "## Yanıt biçimi",
    "",
    "Yanıtın, aşağıdaki JSON şemasına uyan tek bir JSON nesnesi olsun. Önüne ya da arkasına metin ya da kod bloğu işareti ekleme. Alan adlarını ve kodları şemadaki gibi aynen yaz; her alanı yaz.",
    "",
    JSON.stringify(z.toJSONSchema(factsOutputSchema)),
    "",
  ].join("\n");
}

/**
 * Tenders without facts from the current prompt version since the tender was
 * last written (a new notice, re-normalising, enrichment with structured
 * details) or its files last changed (documents_changed_at): anything that
 * can change what the facts stage reads. Open tenders with a current match of
 * an active profile, and every tender with a decision (the team's decisions
 * calibrate the policy). An API error is no answer, so the tender is tried
 * again, but not within an hour of an attempt made after its last change of
 * files: a new upload is read within minutes. Nearest deadline first.
 */
/** After the files last changed, the queue waits this long, so a ZIP or a portal page read over a few minutes is read once. */
export const FILES_SETTLE_MINUTES = 5;

/** The condition of pendingFacts, also for one tender (isFactsPending). */
function pendingFactsWhere(settleMinutes: number): SQL {
  return sql`(
    (
      exists (
        select 1 from ${profileMatches} pm join ${criteriaProfiles} cp on cp.id = pm.profile_id and cp.active
        where pm.tender_id = ${tenders.id} and pm.unmatched_at is null
      )
      and ${tenders.status} = 'open'
      and (${tenders.submissionDeadline} is null or ${tenders.submissionDeadline} > now())
    )
    or (
      select r.decision from ${tenderReviews} r where r.tender_id = ${tenders.id} order by r.decided_at desc limit 1
    ) is not null
  )
  and not exists (
    select 1 from ${analyses} answered
    where answered.tender_id = ${tenders.id} and answered.kind = 'facts' and answered.output is not null
      and answered.prompt_version = ${FACTS_PROMPT_VERSION}
      and coalesce((answered.output->>'inputUpdatedAt')::timestamptz, answered.created_at)
        >= date_trunc('milliseconds', greatest(${tenders.updatedAt}, ${tenders.documentsChangedAt}))
  )
  and not exists (
    select 1 from ${analyses} recent
    where recent.tender_id = ${tenders.id} and recent.kind = 'facts' and recent.created_at > now() - interval '1 hour'
      and recent.created_at >= coalesce(${tenders.documentsChangedAt}, '-infinity')
  )
  -- Files still being read would only make another call needed.
  and not exists (
    select 1 from ${documents} unread
    where unread.tender_id = ${tenders.id} and unread.storage_path is not null and unread.processed_at is null
  )
  and (${tenders.documentsChangedAt} is null or ${tenders.documentsChangedAt} <= now() - make_interval(mins => ${settleMinutes}))`;
}

export async function pendingFacts(db: AppDb, limit: number, options: { settleMinutes?: number } = {}): Promise<string[]> {
  const rows = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(pendingFactsWhere(options.settleMinutes ?? FILES_SETTLE_MINUTES))
    .orderBy(
      sql`(${tenders.status} = 'open' and (${tenders.submissionDeadline} is null or ${tenders.submissionDeadline} > now())) desc`,
      sql`${tenders.submissionDeadline} asc nulls last`,
      asc(tenders.id),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Whether the tender waits for its facts to be extracted again (the
 * condition of pendingFacts, without the settling wait): what the detail
 * page says when its facts are out of date.
 */
export async function isFactsPending(db: AppDb, tenderId: string): Promise<boolean> {
  const [row] = await db.select({ id: tenders.id }).from(tenders).where(and(eq(tenders.id, tenderId), pendingFactsWhere(0)));
  return Boolean(row);
}

/** Turkish texts lose em dashes; quotes stay as the notice wrote them. */
function cleanFacts(output: FactsOutput): FactsOutput {
  const tr = noEmDash;
  return {
    ...output,
    summaryTr: tr(output.summaryTr),
    lots: output.lots.map((lot) => ({
      ...lot,
      lotNumber: lot.lotNumber.trim(),
      productTr: tr(lot.productTr),
      quantity: { ...lot.quantity, text: tr(lot.quantity.text) },
    })),
    installation: { ...output.installation, detail: tr(output.installation.detail) },
    commissioningTraining: { ...output.commissioningTraining, detail: tr(output.commissioningTraining.detail) },
    localService: { ...output.localService, detail: tr(output.localService.detail) },
    warranty: { ...output.warranty, detail: tr(output.warranty.detail) },
    deliveryPattern: { ...output.deliveryPattern, detail: tr(output.deliveryPattern.detail) },
    deliveryPoints: { ...output.deliveryPoints, detail: tr(output.deliveryPoints.detail) },
    brand: { ...output.brand, detail: tr(output.brand.detail) },
    pastPerformance: { ...output.pastPerformance, detail: tr(output.pastPerformance.detail) },
    turnover: { ...output.turnover, detail: tr(output.turnover.detail) },
    restrictedProduct: { ...output.restrictedProduct, detail: tr(output.restrictedProduct.detail) },
    awardCriteria: { ...output.awardCriteria, detail: tr(output.awardCriteria.detail) },
    documentsToCheck: output.documentsToCheck.map(tr).filter(Boolean),
  };
}

/**
 * Schema, plus: exactly the lots that were sent, in order, each with a
 * product, and obligations naming only those lots (a misspelt lot number
 * would silently drop the obligation).
 */
export function parseFacts(value: unknown, lotNumbers: readonly string[]): Parsed<FactsOutput> {
  const result = factsOutputSchema.safeParse(value);
  if (!result.success) return { ok: false, error: schemaError(result.error.issues) };
  const output = cleanFacts(result.data);
  const got = output.lots.map((lot) => lot.lotNumber);
  if (got.length !== lotNumbers.length || got.some((lotNumber, i) => lotNumber !== lotNumbers[i])) {
    return { ok: false, error: `Lotlar girdiyle eşleşmiyor: ${lotNumbers.length} lot gönderildi, ${got.length} lot geldi.` };
  }
  if (output.lots.some((lot) => !lot.productTr)) return { ok: false, error: "Bir lotun ürün açıklaması boş." };
  if (lotNumbers.length > 1) {
    const known = new Set(lotNumbers.map(lotLabel));
    for (const key of ["installation", "commissioningTraining", "localService"] as const) {
      const unknown = output[key].lots.filter((n) => !known.has(lotLabel(n)));
      if (unknown.length) return { ok: false, error: `${key} girdide olmayan lotları anıyor: ${unknown.join(", ")}.` };
    }
  }
  return { ok: true, output };
}

/**
 * Documents in the order the facts stage reads them, specifications and
 * tender documents first (SPEC 7.2): only the first ones fit its input. The
 * detail page uses the same order, so the fingerprints agree.
 */
export const factsDocumentOrder = [
  sql`case ${documents.documentType}
    when 'technicalSpecifications' then 0 when 'biddingDocuments' then 1 when 'eligibilityCriteria' then 2
    when 'evaluationCriteria' then 3 when 'contractDraft' then 4 when 'billOfQuantity' then 5 else 6 end`,
  asc(documents.createdAt),
  asc(documents.id),
];

/**
 * Document links the notice gave. Files the team uploaded, ZIP members and
 * files found on a portal page (which have a parent) are no part of the notice.
 */
export const isNoticeDocument = (doc: { origin: "auto" | "manual"; sourceUrl: string | null; parentId: string | null }) =>
  doc.origin === "auto" && doc.sourceUrl !== null && doc.parentId === null;

/** The last change of what the facts stage reads: the notice (updated_at) or the files. */
export const inputChangedAt = (tender: { updatedAt: Date; documentsChangedAt: Date | null }): Date =>
  tender.documentsChangedAt && tender.documentsChangedAt > tender.updatedAt ? tender.documentsChangedAt : tender.updatedAt;

const MIME_KIND: Record<string, FactsFileCandidate["kind"]> = { [KIND_MIME.pdf]: "pdf", [KIND_MIME.docx]: "docx", [KIND_MIME.xlsx]: "xlsx" };

/** The files the facts stage reads: the tender's analysis inputs (analysisInputIds) with their text, chosen by selectFactsFiles. */
async function loadFactsFiles(db: AppDb, tenderId: string) {
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
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(eq(documents.tenderId, tenderId), isNotNull(documents.storagePath), isNotNull(documents.processedAt), isNotNull(documents.textContent)))
    // The earliest copy of a content is the one read.
    .orderBy(asc(documents.createdAt), asc(documents.id));
  const inputs = analysisInputIds(
    rows.map((r) => ({ ...r, stored: true, processed: true, textChars: r.text?.length ?? 0 })),
  );
  const candidates: FactsFileCandidate[] = rows
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
    }));
  return selectFactsFiles(candidates);
}

/**
 * What the facts stage reads: the tender, its lots, its document
 * descriptions and the text of its files, with the last change of all that
 * at the moment it was read (inputChangedAt) and the ids of the files in the
 * order the input numbers them.
 */
export async function loadFactsNotice(db: AppDb, tenderId: string): Promise<{ notice: FactsNotice; updatedAt: Date; documentIds: string[] } | null> {
  // The tender (with its change stamps) first: a file read after this makes the tender pending again, it cannot slip in unseen.
  const [tender] = await db.select().from(tenders).where(eq(tenders.id, tenderId));
  if (!tender) return null;
  const [lotRows, documentRows, files] = await Promise.all([
    db.select().from(lots).where(eq(lots.tenderId, tenderId)),
    db
      .select({ title: documents.title, documentType: documents.documentType })
      .from(documents)
      // As isNoticeDocument.
      .where(
        and(eq(documents.tenderId, tenderId), eq(documents.origin, "auto"), isNotNull(documents.sourceUrl), isNull(documents.parentDocumentId)),
      )
      .orderBy(...factsDocumentOrder),
    loadFactsFiles(db, tenderId),
  ]);
  return {
    notice: { ...toTriageNotice(tender, lotRows), documents: documentRows, files: files.files, filesOmitted: files.omitted },
    updatedAt: inputChangedAt(tender),
    documentIds: files.ids,
  };
}

/**
 * Extracts the facts of one tender. Validated and retried once (rule 6),
 * every call recorded with its cost (rule 7); quotes are checked against the
 * exact input and stored with the answer (rule 5).
 */
export async function extractFacts(db: AppDb, llm: LlmClient, tenderId: string, model: string, prompt: string): Promise<AnalysisOutcome> {
  const loaded = await loadFactsNotice(db, tenderId);
  if (!loaded) return { status: "gone", costUsd: 0 };
  const { text, sources, lotNumbers } = buildFactsInput(loaded.notice);
  const hash = sourcesHash(sources);
  const target = { tenderId, profileId: null, kind: "facts" as const, promptVersion: FACTS_PROMPT_VERSION, documentIds: loaded.documentIds };

  const result = await completeValidated(llm, {
    request: { model, system: factsSystemPrompt(prompt), user: text, effort: "medium" },
    maxTokens: MAX_TOKENS,
    parse: (value) => parseFacts(value, lotNumbers),
    // The tender's updated_at as read, not the answer's time: a write while the model answers leaves the tender pending.
    stored: (output): StoredFacts => ({
      ...output,
      quoteChecks: checkFactsQuotes(output, sources),
      sourcesHash: hash,
      inputUpdatedAt: loaded.updatedAt.toISOString(),
    }),
    record: (entry) => recordAnalysis(db, target, entry),
  });
  return { status: result.status, costUsd: result.costUsd };
}

export type FactsRunOptions = RunOptions & {
  limit?: number;
  /** Only these tenders, extracted again whatever their state; otherwise pendingFacts. */
  tenderIds?: string[];
  model?: string;
  prompt?: string;
};

/** Extracts facts for pending tenders with a few calls in flight, within the monthly budget. */
export async function runFacts(db: AppDb, llm: LlmClient, options: FactsRunOptions = {}): Promise<RunStats> {
  const { limit = 200 } = options;
  const model = options.model ?? factsModel();
  let prompt: string | undefined = options.prompt;
  return runWithinBudget(
    db,
    {
      label: "olgu çıkarma",
      model,
      items: async () => (options.tenderIds ?? (await pendingFacts(db, limit))).slice(0, limit),
      describe: (id) => id,
    },
    (id) => extractFacts(db, llm, id, model, (prompt ??= loadFactsPrompt())),
    options,
  );
}
