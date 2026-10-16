import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { analyses, criteriaProfiles, lots, profileMatches, tenderReviews, tenders } from "@/db/schema";
import { sourcesHash } from "./evidence";
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
import { buildTranslationInput } from "./translation-input";
import { translationOutputSchema, type TranslationOutput } from "./translation-schema";
import type { StoredTranslation } from "./translations";
import { noticeQuoteSources } from "./triage-input";

// Turkish version of every notice the team sees (team decision, 14 October
// 2026): tenders with a current match of an active profile, or a decision.

export const TRANSLATION_PROMPT_VERSION = "translate.v2";
// Long descriptions and many lots make long answers, and thinking counts against the limit too.
const MAX_TOKENS = 16_000;

/** Translation uses the triage model: cheap and good at European languages. */
export const translationModel = (): string => process.env.LLM_TRIAGE_MODEL?.trim() || "claude-haiku-5-5";

export function loadTranslationPrompt(version = TRANSLATION_PROMPT_VERSION): string {
  return readFileSync(path.join(process.cwd(), "prompts", `${version}.md`), "utf8");
}

/**
 * Tenders the team sees without a translation from the current prompt version
 * since they last changed. An API error is no answer, so the tender is tried
 * again, but not within an hour of any attempt. Open tenders first, nearest
 * deadline first.
 */
export async function pendingTranslations(db: AppDb, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: tenders.id })
    .from(tenders)
    .where(
      sql`(
        exists (
          select 1 from ${profileMatches} pm join ${criteriaProfiles} cp on cp.id = pm.profile_id and cp.active
          where pm.tender_id = ${tenders.id} and pm.unmatched_at is null
        )
        or (
          select r.decision from ${tenderReviews} r where r.tender_id = ${tenders.id} order by r.decided_at desc limit 1
        ) is not null
      )
      and not exists (
        select 1 from ${analyses} answered
        where answered.tender_id = ${tenders.id} and answered.kind = 'translation' and answered.output is not null
          and answered.prompt_version = ${TRANSLATION_PROMPT_VERSION}
          and answered.created_at >= coalesce(${tenders.changedAt}, '-infinity'::timestamptz)
      )
      and not exists (
        select 1 from ${analyses} recent
        where recent.tender_id = ${tenders.id} and recent.kind = 'translation' and recent.created_at > now() - interval '1 hour'
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

function cleanTranslation(output: TranslationOutput): TranslationOutput {
  return {
    title: noEmDash(output.title),
    description: noEmDash(output.description),
    lots: output.lots.map((lot) => ({ lotNumber: lot.lotNumber.trim(), title: noEmDash(lot.title), description: noEmDash(lot.description) })),
  };
}

/** Schema, plus: a title, and exactly the lots that were sent, in order. */
export function parseTranslation(value: unknown, lotNumbers: readonly string[]): Parsed<TranslationOutput> {
  const result = translationOutputSchema.safeParse(value);
  if (!result.success) return { ok: false, error: schemaError(result.error.issues) };
  const output = cleanTranslation(result.data);
  if (!output.title) return { ok: false, error: "Türkçe başlık boş." };
  const got = output.lots.map((lot) => lot.lotNumber);
  if (got.length !== lotNumbers.length || got.some((lotNumber, i) => lotNumber !== lotNumbers[i])) {
    return { ok: false, error: `Lotlar girdiyle eşleşmiyor: ${lotNumbers.length} lot gönderildi, ${got.length} lot geldi.` };
  }
  return { ok: true, output };
}

/**
 * Translates one tender: title, description and lots. Validated and retried
 * once (rule 6), every call recorded with its cost (rule 7). The stored
 * fingerprint of the notice texts shows when a translation is out of date.
 */
export async function translateTender(db: AppDb, llm: LlmClient, tenderId: string, model: string, prompt: string): Promise<AnalysisOutcome> {
  const [[tender], lotRows] = await Promise.all([
    db.select().from(tenders).where(eq(tenders.id, tenderId)),
    db.select().from(lots).where(eq(lots.tenderId, tenderId)),
  ]);
  if (!tender) return { status: "gone", costUsd: 0 };
  const notice = toTriageNotice(tender, lotRows);
  const { text, lotNumbers, truncated } = buildTranslationInput(notice);
  const hash = sourcesHash(noticeQuoteSources(notice));
  const target = { tenderId, profileId: null, kind: "translation" as const, promptVersion: TRANSLATION_PROMPT_VERSION };

  const result = await completeValidated(llm, {
    // Natural Turkish and a readable layout need the model to plan the text (team feedback, 16 October 2026).
    request: { model, system: prompt, user: text, effort: "medium", schema: translationOutputSchema },
    maxTokens: MAX_TOKENS,
    parse: (value) => parseTranslation(value, lotNumbers),
    stored: (output): StoredTranslation => ({ ...output, sourcesHash: hash, truncated }),
    record: (entry) => recordAnalysis(db, target, entry),
  });
  return { status: result.status, costUsd: result.costUsd };
}

export type TranslationRunOptions = RunOptions & {
  limit?: number;
  /** Only these tenders, translated again whatever their state; otherwise pendingTranslations. */
  tenderIds?: string[];
  model?: string;
  prompt?: string;
};

/** Translates pending tenders with a few calls in flight, within the monthly budget. */
export async function runTranslation(db: AppDb, llm: LlmClient, options: TranslationRunOptions = {}): Promise<RunStats> {
  const { limit = 200 } = options;
  const model = options.model ?? translationModel();
  let prompt: string | undefined = options.prompt;
  return runWithinBudget(
    db,
    {
      label: "çeviri",
      model,
      items: async () => (options.tenderIds ?? (await pendingTranslations(db, limit))).slice(0, limit),
      describe: (id) => id,
    },
    (id) => translateTender(db, llm, id, model, (prompt ??= loadTranslationPrompt())),
    options,
  );
}
