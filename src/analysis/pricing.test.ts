import { describe, expect, it } from "vitest";
import { hasPrice, llmCostUsd } from "./pricing";
import type { LlmUsage } from "./types";

const usage = (parts: Partial<LlmUsage>): LlmUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  ...parts,
});

const MILLION = 1_000_000;

describe("llmCostUsd", () => {
  it("charges the list price per million tokens for each item", () => {
    // Input, 5-minute write, 1-hour write, cache read, output.
    const each = (model: string, tokens: number) => [
      llmCostUsd(model, usage({ inputTokens: tokens })),
      llmCostUsd(model, usage({ cacheWriteTokens: tokens })),
      llmCostUsd(model, usage({ cacheWriteTokens: tokens, cacheWrite1hTokens: tokens })),
      llmCostUsd(model, usage({ cacheReadTokens: tokens })),
      llmCostUsd(model, usage({ outputTokens: tokens })),
    ];
    expect(each("claude-sonnet-5-5", MILLION)).toEqual([2, 2.5, 4, 0.1, 10]);
    expect(each("claude-opus-5-5", MILLION)).toEqual([4, 5, 8, 0.2, 20]);
    // 100,000 tokens keep a Haiku prompt on the lower rate card.
    expect(each("claude-haiku-5-5", 100_000)).toEqual([0.01, 0.0125, 0.02, 0.001, 0.05]);
  });

  it("adds up a call with every kind of token", () => {
    // 12,000 x 2 + 3,000 x 2.5 + 2,000 x 4 + 30,000 x 0.1 + 800 x 10 = 50,500 micro-dollars.
    const call = usage({
      inputTokens: 12_000,
      cacheWriteTokens: 5_000,
      cacheWrite1hTokens: 2_000,
      cacheReadTokens: 30_000,
      outputTokens: 800,
    });
    expect(llmCostUsd("claude-sonnet-5-5", call)).toBe(0.0505);
  });

  it("prices every item of a Haiku prompt over 100,000 tokens, output included, on the higher card", () => {
    const at = (cacheReadTokens: number) =>
      llmCostUsd(
        "claude-haiku-5-5",
        usage({ inputTokens: 60_000, cacheReadTokens, cacheWriteTokens: 10_000, outputTokens: 1_000 }),
      );
    // Prompt of exactly 100,000: 6,000 + 300 + 1,250 + 500 micro-dollars.
    expect(at(30_000)).toBe(0.00805);
    // One token more: 30,000 + 1,500.05 + 6,250 + 2,500 micro-dollars, cache reads counting toward the prompt.
    expect(at(30_001)).toBe(0.04025);
  });

  it("splits cache writes into the 5-minute and the 1-hour part", () => {
    const writes = (cacheWrite1hTokens: number) =>
      llmCostUsd("claude-haiku-5-5", usage({ cacheWriteTokens: 10_000, cacheWrite1hTokens }));
    expect(writes(0)).toBe(0.00125);
    // 6,000 x 0.125 + 4,000 x 0.2 micro-dollars.
    expect(writes(4_000)).toBe(0.00155);
  });

  it("rounds to the micro-dollar that cost_usd keeps", () => {
    expect(llmCostUsd("claude-haiku-5-5", usage({ inputTokens: 7 }))).toBe(0.000001);
    expect(llmCostUsd("claude-haiku-5-5", usage({ inputTokens: 4 }))).toBe(0);
  });

  it("refuses models without a price", () => {
    expect(() => llmCostUsd("claude-haiku-4-5", usage({ inputTokens: 1 }))).toThrow(/No price for model "claude-haiku-4-5"/);
  });

  it("refuses usage that cannot be billed", () => {
    expect(() => llmCostUsd("claude-sonnet-5-5", usage({ inputTokens: -1 }))).toThrow(/inputTokens/);
    expect(() => llmCostUsd("claude-sonnet-5-5", usage({ outputTokens: Number.NaN }))).toThrow(/outputTokens/);
    expect(() => llmCostUsd("claude-sonnet-5-5", usage({ cacheReadTokens: 1.5 }))).toThrow(/cacheReadTokens/);
    expect(() => llmCostUsd("claude-sonnet-5-5", usage({ cacheWriteTokens: 10, cacheWrite1hTokens: 11 }))).toThrow(
      /exceeds cacheWriteTokens/,
    );
  });
});

describe("hasPrice", () => {
  it("knows the current models by their exact ids", () => {
    expect(hasPrice("claude-haiku-5-5")).toBe(true);
    expect(hasPrice("claude-sonnet-5-5")).toBe(true);
    expect(hasPrice("claude-opus-5-5")).toBe(true);
    expect(hasPrice("claude-haiku-4-5")).toBe(false);
    expect(hasPrice("claude-opus-5-5-20261001")).toBe(false);
    expect(hasPrice("constructor")).toBe(false);
    expect(hasPrice("")).toBe(false);
  });
});
