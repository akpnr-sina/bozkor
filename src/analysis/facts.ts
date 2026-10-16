import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db";
import { lotLabel } from "@/lib/format";
import { analyses, criteriaProfiles, documents, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { sourcesHash } from "./evidence";
import { checkFactsQuotes, type StoredFacts } from "./facts-evidence";
import { buildFactsInput, type FactsNotice } from "./facts-input";
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

export const FACTS_PROMPT_VERSION = "facts.v4";
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
 * details: anything that can change what the facts stage reads): open
 * tenders with a current match of an active profile, and every tender with a
 * decision (the team's decisions calibrate the policy). An API error is no
 * answer, so the tender is tried again, but not within an hour of any
 * attempt. Nearest deadline first.
 */
export async function pendingFacts(db: AppDb, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(
      sql`(
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
          and coalesce((answered.output->>'inputUpdatedAt')::timestamptz, answered.created_at) >= date_trunc('milliseconds', ${tenders.updatedAt})
      )
      and not exists (
        select 1 from ${analyses} recent
        where recent.tender_id = ${tenders.id} and recent.kind = 'facts' and recent.created_at > now() - interval '1 hour'
      )`,
    )
    .orderBy(
      sql`(${tenders.status} = 'open' and (${tenders.submissionDeadline} is null or ${tenders.submissionDeadline} > now())) desc`,
      sql`${tenders.submissionDeadline} asc nulls last`,
      asc(tenders.id),
    )
    .limit(limit);
  return rows.map((r) => r.id);
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
 * The notice as the facts stage reads it: the tender, its lots and its
 * document descriptions, with the tender's updated_at at the moment it was read.
 */
export async function loadFactsNotice(db: AppDb, tenderId: string): Promise<{ notice: FactsNotice; updatedAt: Date } | null> {
  const [[tender], lotRows, documentRows] = await Promise.all([
    db.select().from(tenders).where(eq(tenders.id, tenderId)),
    db.select().from(lots).where(eq(lots.tenderId, tenderId)),
    db
      .select({ title: documents.title, documentType: documents.documentType })
      .from(documents)
      .where(eq(documents.tenderId, tenderId))
      .orderBy(...factsDocumentOrder),
  ]);
  if (!tender) return null;
  return { notice: { ...toTriageNotice(tender, lotRows), documents: documentRows }, updatedAt: tender.updatedAt };
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
  const target = { tenderId, profileId: null, kind: "facts" as const, promptVersion: FACTS_PROMPT_VERSION };

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
