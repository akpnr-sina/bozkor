import type { AppDb } from "@/db";
import { analyses, type analysisKind } from "@/db/schema";
import { monthlyLlmSpend } from "./budget";
import { llmErrorStatus, type LlmClient, type LlmRequest, type LlmResponse } from "./llm";
import { hasPrice, llmCostUsd } from "./pricing";
import type { LlmUsage } from "./types";

// What every LLM job shares: one validated call with a single retry (rule 6),
// a record of every call with its usage and cost (rule 7), and a run loop that
// stays within the monthly budget.

export const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };

/** UI and AI texts never carry an em dash (CLAUDE.md); quotes stay as the notice wrote them. */
export const noEmDash = (text: string) => text.replace(/\s*\u2014\s*/g, ", ").trim();

export function apiErrorText(error: unknown): string {
  const status = llmErrorStatus(error);
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  return status ? `API hatası (${status}): ${message}` : `API hatası: ${message}`;
}

export type RecordEntry = {
  model: string;
  output: unknown;
  valid: boolean;
  usage: LlmUsage;
  costUsd: number;
  error: string | null;
};

export async function recordAnalysis(
  db: AppDb,
  target: { tenderId: string; profileId: string | null; kind: (typeof analysisKind.enumValues)[number]; promptVersion: string },
  entry: RecordEntry,
): Promise<string> {
  const [row] = await db
    .insert(analyses)
    .values({
      tenderId: target.tenderId,
      profileId: target.profileId,
      kind: target.kind,
      model: entry.model,
      promptVersion: target.promptVersion,
      output: entry.output,
      valid: entry.valid,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens,
      cacheWriteTokens: entry.usage.cacheWriteTokens,
      costUsd: entry.costUsd,
      error: entry.error,
    })
    .returning({ id: analyses.id });
  if (!row) throw new Error("analysis not recorded");
  return row.id;
}

export type Parsed<T> = { ok: true; output: T } | { ok: false; error: string };

type Checked<T> = { ok: true; output: T } | { ok: false; error: string; raw: unknown };

/**
 * The JSON value in a model's text: all of it, or the outermost object when
 * a call without an output format wrapped it in a code fence or a sentence.
 * Throws when there is none.
 */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw error;
    return JSON.parse(text.slice(start, end + 1));
  }
}

/** Rule 6: only output that parses, fits the schema and passes the job's own checks counts. */
function check<T>(response: LlmResponse, parse: (value: unknown) => Parsed<T>): Checked<T> {
  if (response.stopReason === "refusal") {
    const category = response.refusalCategory ? ` (${response.refusalCategory})` : "";
    return { ok: false, error: `Model yanıt vermeyi reddetti${category}.`, raw: response.text };
  }
  if (response.stopReason === "max_tokens") return { ok: false, error: "Yanıt token sınırında kesildi.", raw: response.text };
  let value: unknown;
  try {
    value = parseJsonText(response.text);
  } catch {
    return { ok: false, error: "Yanıt JSON olarak okunamadı.", raw: response.text };
  }
  const parsed = parse(value);
  return parsed.ok ? parsed : { ok: false, error: parsed.error, raw: value ?? response.text };
}

/** Zod issues as a short Turkish error. */
export function schemaError(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const parts = issues.slice(0, 3).map((i) => `${i.path.map(String).join(".") || "kök"}: ${i.message}`);
  return `Şemaya uymayan yanıt: ${parts.join("; ")}`;
}

/** Highest output limit the SDK accepts for a non-streaming call (it rejects ~21,333 and up). */
export const MAX_NON_STREAMING_TOKENS = 21_000;

export type CallResult<T> =
  | { status: "valid"; output: T; analysisId: string; costUsd: number }
  | { status: "invalid"; costUsd: number };

/**
 * One validated LLM answer. A malformed answer is retried once (a refusal is
 * not; a cut-off answer gets twice the room). Every call is recorded through
 * `record`; `stored` turns a valid output into what is saved. API errors are
 * recorded with no output and rethrown.
 */
export async function completeValidated<T>(
  llm: LlmClient,
  args: {
    request: Omit<LlmRequest, "maxTokens">;
    maxTokens: number;
    parse: (value: unknown) => Parsed<T>;
    stored: (output: T) => unknown;
    record: (entry: RecordEntry) => Promise<string>;
  },
): Promise<CallResult<T>> {
  const model = args.request.model;
  let costUsd = 0;
  let maxTokens = args.maxTokens;
  for (let attempt = 1; ; attempt++) {
    let response: LlmResponse;
    try {
      response = await llm.complete({ ...args.request, maxTokens });
    } catch (error) {
      await args.record({ model, output: null, valid: false, usage: EMPTY_USAGE, costUsd: 0, error: apiErrorText(error) });
      throw error;
    }
    // A paid call is always recorded, even if its cost cannot be worked out.
    let cost = 0;
    let costError: string | null = null;
    try {
      cost = llmCostUsd(model, response.usage);
    } catch (error) {
      costError = `Maliyet hesaplanamadı: ${error instanceof Error ? error.message : String(error)}`;
    }
    costUsd += cost;
    const checked = check(response, args.parse);
    const base = { model: response.model || model, usage: response.usage, costUsd: cost };
    if (checked.ok) {
      const analysisId = await args.record({ ...base, output: args.stored(checked.output), valid: true, error: costError });
      return { status: "valid", output: checked.output, analysisId, costUsd };
    }
    const error = costError ? `${checked.error} ${costError}` : checked.error;
    await args.record({ ...base, output: checked.raw, valid: false, error });
    // The same input would most likely be refused again.
    if (attempt >= 2 || response.stopReason === "refusal") return { status: "invalid", costUsd };
    if (response.stopReason === "max_tokens") maxTokens = Math.min(maxTokens * 2, MAX_NON_STREAMING_TOKENS);
  }
}

export type AnalysisOutcome = { status: "valid" | "invalid" | "gone"; costUsd: number };

export type RunStats = {
  attempted: number;
  valid: number;
  invalid: number;
  apiErrors: number;
  costUsd: number;
  /** Why the run stopped before the end of its list, if it did. */
  stoppedBy: "budget" | "auth" | "credit" | "errors" | null;
  /** Spend this month before the run, and the budget. */
  spentBeforeUsd: number;
  budgetUsd: number;
};

export type RunOptions = {
  /** A manual run goes on past the monthly budget (rule 7); automatic ones stop. */
  manual?: boolean;
  concurrency?: number;
  log?: (message: string) => void;
  /** Called after each item, with the run's stats so far and the number queued. */
  onProgress?: (stats: RunStats, total: number) => void;
  now?: Date;
};

const MAX_CONSECUTIVE_API_ERRORS = 5;
/** How the API says the account has run out of prepaid credit (HTTP 400). */
const NO_CREDIT = /credit balance is too low/i;

/**
 * Runs `analyze` over the items with a few calls in flight, within the
 * monthly budget. Stops on a rejected key (401/403), on an account out of
 * credit and after repeated API errors.
 */
export async function runWithinBudget<K>(
  db: AppDb,
  job: { label: string; model: string; items: () => Promise<K[]>; describe: (item: K) => string },
  analyze: (item: K) => Promise<AnalysisOutcome>,
  options: RunOptions = {},
): Promise<RunStats> {
  const { manual = false, concurrency = 2, log = console.log } = options;
  if (!hasPrice(job.model)) {
    throw new Error(`"${job.model}" modelinin fiyatı tanımlı değil; maliyet kaydedilemeyeceği için ${job.label} çalışmaz (src/analysis/pricing.ts).`);
  }
  const budget = await monthlyLlmSpend(db, options.now);
  const stats: RunStats = {
    attempted: 0,
    valid: 0,
    invalid: 0,
    apiErrors: 0,
    costUsd: 0,
    stoppedBy: null,
    spentBeforeUsd: budget.spentUsd,
    budgetUsd: budget.budgetUsd,
  };
  const overBudget = () => budget.spentUsd + stats.costUsd >= budget.budgetUsd;
  if (overBudget() && !manual) {
    stats.stoppedBy = "budget";
    return stats;
  }
  if (overBudget()) log(`Uyarı: aylık LLM bütçesi (${budget.budgetUsd} USD) doldu; elle başlatıldığı için devam ediliyor.`);

  const queue = await job.items();
  const total = queue.length;
  let consecutiveErrors = 0;

  const worker = async () => {
    while (queue.length && !stats.stoppedBy) {
      if (!manual && overBudget()) {
        stats.stoppedBy = "budget";
        return;
      }
      const item = queue.shift() as K;
      stats.attempted++;
      try {
        const outcome = await analyze(item);
        stats.costUsd += outcome.costUsd;
        if (outcome.status === "valid") stats.valid++;
        if (outcome.status === "invalid") stats.invalid++;
        consecutiveErrors = 0;
      } catch (error) {
        stats.apiErrors++;
        consecutiveErrors++;
        log(`[${job.label}] ${job.describe(item)}: ${apiErrorText(error)}`);
        const status = llmErrorStatus(error);
        // A bad key or a missing permission fails every call; so does an account without credit.
        if (status === 401 || status === 403) stats.stoppedBy = "auth";
        else if (status === 400 && NO_CREDIT.test(error instanceof Error ? error.message : String(error))) stats.stoppedBy = "credit";
        else if (consecutiveErrors >= MAX_CONSECUTIVE_API_ERRORS) stats.stoppedBy = "errors";
      }
      options.onProgress?.(stats, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return stats;
}
