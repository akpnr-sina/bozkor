import { readFileSync } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { analyses, categories, criteriaProfiles, lots, profileMatches, tenders } from "@/db/schema";
import { openTender } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { checkQuotes, sourcesHash, type StoredTriage } from "./evidence";
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
import { buildTriageInput } from "./triage-input";
import { NOTICE_METRICS, triageOutputSchema, type TriageMetric, type TriageOutput } from "./triage-schema";
import type { TriageNotice, TriageProfile } from "./types";

export const TRIAGE_PROMPT_VERSION = "triage.v2";
const DEFAULT_TRIAGE_MODEL = "claude-haiku-5-5";
// Thinking counts toward max_tokens; the JSON itself is under 1,000 tokens.
const MAX_TOKENS = 8_000;
const EFFORT = "medium";

export const triageModel = (): string => process.env.LLM_TRIAGE_MODEL?.trim() || DEFAULT_TRIAGE_MODEL;

/** The versioned system prompt; read by the worker and the CLI from the repository. */
export function loadTriagePrompt(version = TRIAGE_PROMPT_VERSION): string {
  return readFileSync(path.join(process.cwd(), "prompts", `${version}.md`), "utf8");
}

export type MatchKey = { profileId: string; tenderId: string };

/**
 * Current matches of active profiles on open tenders without an answer from
 * the current prompt version since the tender, or what triage reads from the
 * profile, last changed. An answer counts
 * even when it was invalid (rule 6: retried once, then left as an error); an
 * API error is no answer, so the match is tried again, but not within an hour
 * of any attempt. Nearest deadline first.
 */
export async function pendingTriage(db: AppDb, limit: number): Promise<MatchKey[]> {
  return db
    .select({ profileId: profileMatches.profileId, tenderId: profileMatches.tenderId })
    .from(profileMatches)
    .innerJoin(tenders, eq(tenders.id, profileMatches.tenderId))
    .innerJoin(criteriaProfiles, eq(criteriaProfiles.id, profileMatches.profileId))
    .where(
      and(
        isNull(profileMatches.unmatchedAt),
        eq(criteriaProfiles.active, true),
        openTender(),
        sql`not exists (
          select 1 from ${analyses} answered
          where answered.tender_id = ${profileMatches.tenderId} and answered.profile_id = ${profileMatches.profileId}
            and answered.kind = 'triage' and answered.output is not null
            and answered.prompt_version = ${TRIAGE_PROMPT_VERSION}
            and answered.created_at >= greatest(${tenders.changedAt}, ${criteriaProfiles.triageInputsChangedAt})
        )`,
        sql`not exists (
          select 1 from ${analyses} recent
          where recent.tender_id = ${profileMatches.tenderId} and recent.profile_id = ${profileMatches.profileId}
            and recent.kind = 'triage' and recent.created_at > now() - interval '1 hour'
        )`,
      ),
    )
    .orderBy(sql`${tenders.submissionDeadline} asc nulls last`, asc(tenders.id))
    .limit(limit);
}

/** Current matches of one tender, whatever their triage state; for a manual rerun. */
export async function matchesOfTender(db: AppDb, tenderId: string): Promise<MatchKey[]> {
  return db
    .select({ profileId: profileMatches.profileId, tenderId: profileMatches.tenderId })
    .from(profileMatches)
    .where(and(eq(profileMatches.tenderId, tenderId), isNull(profileMatches.unmatchedAt)));
}

async function loadInput(db: AppDb, key: MatchKey): Promise<{ notice: TriageNotice; profile: TriageProfile } | null> {
  const [[tender], [profileRow], lotRows] = await Promise.all([
    db.select().from(tenders).where(eq(tenders.id, key.tenderId)),
    db.select().from(criteriaProfiles).where(eq(criteriaProfiles.id, key.profileId)),
    db.select().from(lots).where(eq(lots.tenderId, key.tenderId)).orderBy(asc(lots.lotNumber)),
  ]);
  if (!tender || !profileRow) return null;
  const parsed = profileRulesSchema.safeParse(profileRow.rules);
  const rules = parsed.success ? parsed.data : null;
  // An empty description is common; the categories and keywords say what the profile is after.
  const categoryRows = rules?.categoryIds.length
    ? await db.select().from(categories).where(inArray(categories.id, rules.categoryIds)).orderBy(asc(categories.name))
    : [];
  return {
    notice: toTriageNotice(tender, lotRows),
    profile: {
      name: profileRow.name,
      description: rules?.description ?? "",
      questions: rules?.analysisQuestions ?? [],
      categories: categoryRows.map((c) => (c.description ? `${c.name}: ${c.description}` : c.name)),
      keywords: rules?.keywordsAny ?? [],
      excludedKeywords: rules?.keywordsNone ?? [],
    },
  };
}

/** A rating and its evidence state must agree: no rating means MISSING, a rating is at least PROVISIONAL. */
function cleanMetric(metric: TriageMetric): TriageMetric {
  const quality = metric.rating === null ? (metric.quality === "CONFLICT" ? "CONFLICT" : "MISSING") : metric.quality === "MISSING" ? "PROVISIONAL" : metric.quality;
  return { rating: metric.rating, quality, reason: noEmDash(metric.reason), quote: metric.quote.trim() };
}

function cleanOutput(output: TriageOutput): TriageOutput {
  const claim = (c: TriageOutput["quantityHint"]) => ({ text: noEmDash(c.text), quote: c.quote.trim() });
  const metrics = Object.fromEntries(NOTICE_METRICS.map((id) => [id, cleanMetric(output.metrics[id])])) as TriageOutput["metrics"];
  return {
    relevance: output.relevance,
    productSummary: noEmDash(output.productSummary),
    reasons: output.reasons.map(claim),
    metrics,
    conditionFlags: output.conditionFlags.map((f) => ({ code: f.code, text: noEmDash(f.text), quote: f.quote.trim() })),
    quantityHint: claim(output.quantityHint),
    missingInfo: output.missingInfo.map(noEmDash),
  };
}

function parseTriage(value: unknown): Parsed<TriageOutput> {
  const result = triageOutputSchema.safeParse(value);
  return result.success ? { ok: true, output: cleanOutput(result.data) } : { ok: false, error: schemaError(result.error.issues) };
}

/**
 * Triages one match: the profile and the notice go to the model, the answer is
 * validated and retried once if malformed (rule 6; a refusal is not retried).
 * Every call is recorded with its usage and cost (rule 7). A valid answer is
 * stored with its quote checks (rule 5) and becomes the match's triage; a
 * failed one leaves the match's last valid triage in place. API errors are
 * recorded and rethrown; the match stays pending.
 */
export async function triageMatch(db: AppDb, llm: LlmClient, key: MatchKey, model: string, prompt: string): Promise<AnalysisOutcome> {
  const input = await loadInput(db, key);
  if (!input) return { status: "gone", costUsd: 0 };
  const { text, sources } = buildTriageInput(input.notice, input.profile);
  const target = { tenderId: key.tenderId, profileId: key.profileId, kind: "triage" as const, promptVersion: TRIAGE_PROMPT_VERSION };

  const result = await completeValidated(llm, {
    request: { model, system: prompt, user: text, effort: EFFORT, schema: triageOutputSchema },
    maxTokens: MAX_TOKENS,
    parse: parseTriage,
    stored: (output): StoredTriage => ({ ...output, quoteChecks: checkQuotes(output, sources), sourcesHash: sourcesHash(sources) }),
    record: (entry) => recordAnalysis(db, target, entry),
  });
  if (result.status === "valid") await setMatchTriage(db, key, result.output.relevance, result.analysisId);
  return { status: result.status, costUsd: result.costUsd };
}

async function setMatchTriage(db: AppDb, key: MatchKey, score: number, analysisId: string): Promise<void> {
  await db
    .update(profileMatches)
    .set({ triageScore: score, triageAnalysisId: analysisId })
    .where(and(eq(profileMatches.profileId, key.profileId), eq(profileMatches.tenderId, key.tenderId)));
}

export type TriageRunStats = RunStats;

export type TriageRunOptions = RunOptions & {
  /** At most this many matches. */
  limit?: number;
  /** Only these matches, in any triage state; otherwise pendingTriage. */
  keys?: MatchKey[];
  model?: string;
  prompt?: string;
};

/** Triages pending matches with a few calls in flight, within the monthly budget. */
export async function runTriage(db: AppDb, llm: LlmClient, options: TriageRunOptions = {}): Promise<TriageRunStats> {
  const { limit = 200 } = options;
  const model = options.model ?? triageModel();
  let prompt: string | undefined = options.prompt;
  return runWithinBudget(
    db,
    {
      label: "triage",
      model,
      items: async () => (options.keys ?? (await pendingTriage(db, limit))).slice(0, limit),
      describe: (key) => key.tenderId,
    },
    (key) => triageMatch(db, llm, key, model, (prompt ??= loadTriagePrompt())),
    options,
  );
}

/** Triage analyses by id, for showing the latest result next to each match. */
export async function triageAnalyses(db: AppDb, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(analyses).where(inArray(analyses.id, ids));
}
