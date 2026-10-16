import type { LlmUsage } from "./types";

/** USD per million tokens for each billed item of one call. */
type Rates = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };

type ModelPrices = {
  rates: Rates;
  /** A prompt (input + cache reads + cache writes) above `aboveTokens` pays these rates for every item, output included. */
  longPrompt?: { aboveTokens: number; rates: Rates };
};

// Claude API list prices from https://platform.claude.com/docs/en/about-claude/pricing,
// checked on 14 October 2026. Batch processing, fast mode and US-only
// inference (inference_geo, 1.1x) are priced differently and not used here.
const PRICES: Readonly<Record<string, ModelPrices>> = {
  "claude-haiku-5-5": {
    rates: { input: 0.1, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, output: 0.5 },
    longPrompt: {
      aboveTokens: 100_000,
      rates: { input: 0.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5 },
    },
  },
  "claude-sonnet-5-5": { rates: { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 } },
  "claude-opus-5-5": { rates: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 } },
};

/** Whether llmCostUsd can price the model; triage refuses a model it could not record the cost of. */
export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

function tokenCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`LLM usage ${name} must be a non-negative integer, got ${value}`);
  return value;
}

/**
 * Cost of one call in USD, rounded to the micro-dollar that analyses.cost_usd
 * keeps. 5-minute cache writes are all writes minus the 1-hour part. Throws
 * for a model without a price and for usage that cannot be billed.
 */
export function llmCostUsd(model: string, usage: LlmUsage): number {
  const prices = hasPrice(model) ? PRICES[model] : undefined;
  if (!prices) throw new Error(`No price for model "${model}"; add it to src/analysis/pricing.ts`);

  const input = tokenCount("inputTokens", usage.inputTokens);
  const output = tokenCount("outputTokens", usage.outputTokens);
  const cacheRead = tokenCount("cacheReadTokens", usage.cacheReadTokens);
  const cacheWrite = tokenCount("cacheWriteTokens", usage.cacheWriteTokens);
  const cacheWrite1h = tokenCount("cacheWrite1hTokens", usage.cacheWrite1hTokens);
  if (cacheWrite1h > cacheWrite) {
    throw new Error(`LLM usage cacheWrite1hTokens (${cacheWrite1h}) exceeds cacheWriteTokens (${cacheWrite})`);
  }

  const prompt = input + cacheRead + cacheWrite;
  const rates = prices.longPrompt && prompt > prices.longPrompt.aboveTokens ? prices.longPrompt.rates : prices.rates;
  // Tokens times USD per million tokens is micro-dollars.
  const microUsd =
    input * rates.input +
    (cacheWrite - cacheWrite1h) * rates.cacheWrite5m +
    cacheWrite1h * rates.cacheWrite1h +
    cacheRead * rates.cacheRead +
    output * rates.output;
  return Math.round(microUsd) / 1_000_000;
}
