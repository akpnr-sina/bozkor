import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsBase } from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";
import { requireEnv } from "@/lib/env";
import type { LlmUsage } from "./types";

/** A file the model reads itself: a PDF as a PDF (its text, tables and page images), or the text of another file. */
export type LlmDocument =
  | { kind: "pdf"; data: Uint8Array; title: string }
  | { kind: "text"; text: string; title: string };

export type LlmRequest = {
  model: string;
  system: string;
  user: string;
  /**
   * Files the model reads before the user text, each a document block, sent
   * in the request itself (base64 for a PDF): nothing is stored with
   * Anthropic. The last one carries a cache breakpoint, so a retry or another
   * analysis of the same files reads them from the cache.
   */
  documents?: LlmDocument[];
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
  /**
   * Read the answer as it is written (server-sent events), for answers too
   * long for one wait: the SDK refuses a request that is not streamed when
   * max_tokens could take over 10 minutes (above about 21,333).
   */
  stream?: boolean;
  /** Streamed, how long the whole answer may take (STREAM_TIMEOUT_MS by default); ignored otherwise. */
  timeoutMs?: number;
};

/** A streamed answer is cut off after this: its stream has no other limit (see streamed()). */
export const STREAM_TIMEOUT_MS = 30 * 60 * 1000;

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

/**
 * The 400 messages of a request too big for the model, which fewer files at
 * a time may pass. They are not documented: matched as users report them
 * (October 2026), "prompt is too long: 208310 tokens > 200000 maximum",
 * "input length and `max_tokens` exceed context limit: ...", and for PDFs
 * "messages.0.content.0.pdf.source.base64.data: A maximum of 100 PDF pages
 * may be provided.".
 */
const TOO_LONG = /prompt is too long|exceed context limit|maximum of \d+ PDF pages/i;

/**
 * Whether a failed call was too big for one request: a 413 request_too_large
 * (over 32 MB; documented, and answered by Cloudflare before the API, so its
 * body is not relied on), or a 400 whose message says so (TOO_LONG).
 */
export function isPromptTooLong(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false;
  if (error.status === 413) return true;
  return error.status === 400 && TOO_LONG.test(apiMessage(error));
}

/** The API's own message ({ type: "error", error: { type, message } }), else the SDK's. */
function apiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  return typeof body?.error?.message === "string" ? body.error.message : error.message;
}

export function createLlmClient(
  apiKey = requireEnv("ANTHROPIC_API_KEY"),
  options: { fetch?: typeof fetch; maxRetries?: number } = {},
): LlmClient {
  // The SDK retries 429, 5xx and connection errors with backoff and honours Retry-After.
  // No shorter timeout than the SDK's own (10 minutes at these output sizes):
  // a timed-out call is retried and may still be billed without being recorded.
  const client = new Anthropic({ apiKey, maxRetries: options.maxRetries ?? 2, fetch: options.fetch });

  /**
   * The answer read as a stream (SDK 0.131.0, read in its source). The
   * 10-minute timeout covers only the wait for the stream to begin, and the
   * size check of requests that are not streamed does not apply, so a long
   * answer takes as long as it takes. maxRetries holds until the stream
   * begins (a connection error, 408, 409, 429, 5xx); an error event in the
   * stream or a connection lost in it is not retried, and is thrown: an
   * APIError without a status (its `type` says which, e.g. overloaded_error),
   * or an AnthropicError. finalMessage() gives a message only once its
   * message_stop has come; a stream cut short throws instead of giving part.
   * So a stream that stops coming without ending is cut off after
   * `timeoutMs`, with an AnthropicError that says how long it was given.
   */
  async function streamed(
    request: Omit<MessageCreateParamsBase, "output_config" | "stream">,
    format: ReturnType<typeof zodOutputFormat> | null,
    effort: LlmRequest["effort"],
    timeoutMs: number,
  ): Promise<Anthropic.Message> {
    // The format without its parser: streamed, the SDK would parse the answer
    // itself and throw on JSON that is cut short or off the schema, where the
    // caller expects the text and the stop reason. The JSON sent is the same.
    const output_config = { ...(format ? { format: { type: format.type, schema: format.schema } } : {}), effort };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const message = await client.messages.stream({ ...request, output_config }, { signal: controller.signal }).finalMessage();
      if (message.stop_reason === null) throw new Anthropic.AnthropicError("Akış, yanıt tamamlanmadan bitti.");
      return message;
    } catch (error) {
      // Aborted by us, the SDK reports a user abort: say what happened instead.
      if (controller.signal.aborted) throw new Anthropic.AnthropicError(`Yanıt ${duration(timeoutMs)} tamamlanmadı.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete({ model, system, user, documents, maxTokens, effort, thinking, schema, stream, timeoutMs = STREAM_TIMEOUT_MS }) {
      const request: Omit<MessageCreateParamsBase, "output_config" | "stream"> = {
        model,
        max_tokens: maxTokens,
        // The system prompt is the same for every call; cached reads cost a tenth.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userContent(user, documents) }],
        ...(thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
      };
      const format = schema ? zodOutputFormat(schema) : null;
      const message = stream
        ? await streamed(request, format, effort, timeoutMs)
        : await client.messages.create({ ...request, output_config: { ...(format ? { format } : {}), effort } });
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

/** The user turn: the text alone, as without files, or each file and then the text. */
function userContent(user: string, documents: readonly LlmDocument[] | undefined): string | Anthropic.ContentBlockParam[] {
  if (!documents?.length) return user;
  const blocks = documents.map(
    (document, i): Anthropic.DocumentBlockParam => ({
      type: "document",
      source:
        document.kind === "pdf"
          ? { type: "base64", media_type: "application/pdf", data: base64(document.data) }
          : { type: "text", media_type: "text/plain", data: document.text },
      title: document.title,
      // The files come before the text: the next analysis of the same files reads them from the cache.
      ...(i === documents.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }),
  );
  return [...blocks, { type: "text", text: user }];
}

/** The bytes in base64, read in place: the array may be a view into a larger buffer. */
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** 1800000 as "30 dakikada", for messages; exact for whole minutes and seconds. */
function duration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} dakikada`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} saniyede`;
  return `${ms} milisaniyede`;
}
