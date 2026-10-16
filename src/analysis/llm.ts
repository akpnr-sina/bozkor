import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { requireEnv } from "@/lib/env";
import type { LlmUsage } from "./types";

export type LlmRequest = {
  model: string;
  system: string;
  user: string;
  /** Hard limit on all output, thinking included (Haiku 5.5 thinks by default). */
  maxTokens: number;
  /** How much the model thinks and writes; set explicitly rather than relying on per-model defaults. */
  effort: "low" | "medium" | "high";
  /** "disabled" for work that needs no reasoning, such as translation; otherwise the model decides. */
  thinking?: "adaptive" | "disabled";
  /**
   * Sent as the JSON output format, which the API enforces through a grammar
   * compiled from it; the caller still validates the text it gets back. Left
   * out for schemas too large for that grammar (the facts): the prompt then
   * carries the schema and the caller finds the JSON in the text.
   */
  schema?: z.ZodType;
};

export type LlmResponse = {
  /** The JSON text the model wrote. */
  text: string;
  /** "end_turn" normally; "max_tokens" and "refusal" mean the output cannot be trusted. */
  stopReason: string | null;
  /** Why the model refused, when it did (stop_details.category). */
  refusalCategory: string | null;
  model: string;
  usage: LlmUsage;
};

/** The one thing analysis code needs from Claude; tests pass a fake (CLAUDE.md rule 8). */
export type LlmClient = {
  complete(request: LlmRequest): Promise<LlmResponse>;
};

/** HTTP status of a failed API call, when there is one. */
export function llmErrorStatus(error: unknown): number | null {
  return error instanceof Anthropic.APIError && typeof error.status === "number" ? error.status : null;
}

export function createLlmClient(
  apiKey = requireEnv("ANTHROPIC_API_KEY"),
  options: { fetch?: typeof fetch; maxRetries?: number } = {},
): LlmClient {
  // The SDK retries 429, 5xx and connection errors with backoff and honours Retry-After.
  // No shorter timeout than the SDK's own (10 minutes at these output sizes):
  // a timed-out call is retried and may still be billed without being recorded.
  const client = new Anthropic({ apiKey, maxRetries: options.maxRetries ?? 2, fetch: options.fetch });
  return {
    async complete({ model, system, user, maxTokens, effort, thinking, schema }) {
      const message = await client.messages.create({
        model,
        max_tokens: maxTokens,
        // The system prompt is the same for every call; cached reads cost a tenth.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: user }],
        ...(thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { ...(schema ? { format: zodOutputFormat(schema) } : {}), effort },
      });
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const usage = message.usage;
      return {
        text,
        stopReason: message.stop_reason,
        refusalCategory: message.stop_details?.category ?? null,
        model: message.model,
        usage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
      };
    },
  };
}
