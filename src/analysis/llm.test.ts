import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, isPromptTooLong, llmErrorStatus, type LlmRequest } from "./llm";

/** A fetch that answers like the Messages API and keeps what was sent, parsed and as sent. */
function fakeFetch(status: number, body: unknown, contentType = "application/json") {
  const sent: { url: string; body: Record<string, unknown>; raw: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body);
    sent.push({ url: String(input), body: JSON.parse(raw), raw, headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5-20261001",
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 80,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
  },
};

describe("createLlmClient", () => {
  it("sends the schema as the output format, caches the system prompt and reads the usage", async () => {
    const { fetchImpl, sent } = fakeFetch(200, message);
    const llm = createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 });
    const response = await llm.complete({
      model: "claude-haiku-5-5",
      system: "Sistem",
      user: "İlan",
      maxTokens: 500,
      effort: "medium",
      schema: z.object({ ok: z.boolean() }),
    });

    expect(sent[0]?.url).toMatch(/\/v1\/messages$/);
    expect(sent[0]?.headers.get("x-api-key")).toBe("test-key");
    expect(sent[0]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 500,
      system: [{ type: "text", text: "Sistem", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "İlan" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: expect.objectContaining({ type: "object" }) } },
    });
    expect(response).toEqual({
      text: '{"ok":true}',
      stopReason: "end_turn",
      refusalCategory: null,
      model: "claude-haiku-5-5-20261001",
      usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 300, cacheWrite1hTokens: 200 },
    });
  });

  it("sends no output format without a schema", async () => {
    const { fetchImpl, sent } = fakeFetch(200, message);
    const llm = createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 });
    await llm.complete({ model: "claude-haiku-5-5", system: "Sistem", user: "İlan", maxTokens: 500, effort: "medium" });
    expect(sent[0]?.body.output_config).toEqual({ effort: "medium" });
  });

  it("reads only the text after Haiku's thinking, and the refusal category", async () => {
    const thinking = {
      ...message,
      content: [{ type: "thinking", thinking: "İlanı değerlendiriyorum", signature: "sig" }, ...message.content],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "general_harms", explanation: null },
    };
    const { fetchImpl } = fakeFetch(200, thinking);
    const llm = createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 });
    const response = await llm.complete({ model: "claude-haiku-5-5", system: "S", user: "U", maxTokens: 10, effort: "low", schema: z.object({}) });
    expect(response).toMatchObject({ text: '{"ok":true}', stopReason: "refusal", refusalCategory: "general_harms" });
  });

  it("reports the HTTP status of a failed call", async () => {
    const { fetchImpl } = fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const llm = createLlmClient("bad-key", { fetch: fetchImpl, maxRetries: 0 });
    const error = await llm
      .complete({ model: "claude-haiku-5-5", system: "S", user: "U", maxTokens: 10, effort: "low", schema: z.object({}) })
      .catch((e: unknown) => e);
    expect(llmErrorStatus(error)).toBe(401);
    expect(llmErrorStatus(new Error("x"))).toBeNull();
  });
});

describe("createLlmClient with files", () => {
  const request: LlmRequest = { model: "claude-sonnet-5-5", system: "Sistem", user: "Sorular", maxTokens: 500, effort: "medium" };
  // A PDF's first bytes and a byte that is not text, as a view into a larger buffer.
  const pdfBytes = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0xe2];
  const pdf = new Uint8Array([9, 9, 9, ...pdfBytes, 9, 9]).subarray(3, 3 + pdfBytes.length);

  async function send(more: Partial<LlmRequest>) {
    const { fetchImpl, sent } = fakeFetch(200, message);
    await createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 }).complete({ ...request, ...more });
    return sent[0]!;
  }

  it("sends each file as a document block, then the user text, a PDF as its bytes in base64", async () => {
    const sent = await send({
      documents: [
        { kind: "pdf", data: pdf, title: "Teknik şartname.pdf" },
        { kind: "text", text: "Fiyat cetveli\nKalem 1: 40 adet", title: "Prijzenblad.xlsx" },
      ],
    });
    expect(sent.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdfBytes).toString("base64") }, title: "Teknik şartname.pdf" },
          {
            type: "document",
            source: { type: "text", media_type: "text/plain", data: "Fiyat cetveli\nKalem 1: 40 adet" },
            title: "Prijzenblad.xlsx",
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "Sorular" },
        ],
      },
    ]);
    const [first] = (sent.body.messages as { content: { source: { data: string } }[] }[])[0]!.content;
    expect([...Buffer.from(first!.source.data, "base64")]).toEqual(pdfBytes);
  });

  it("marks only the last file and the system prompt for the cache", async () => {
    for (const count of [1, 3]) {
      const documents = Array.from({ length: count }, (_, i) => ({ kind: "text" as const, text: `Belge ${i}`, title: `belge-${i}.docx` }));
      const sent = await send({ documents });
      const content = (sent.body.messages as { content: { cache_control?: unknown }[] }[])[0]!.content;
      expect(content.map((block) => block.cache_control ?? null)).toEqual([...Array(count - 1).fill(null), { type: "ephemeral" }, null]);
      expect(sent.body.system).toEqual([{ type: "text", text: "Sistem", cache_control: { type: "ephemeral" } }]);
      expect(sent.raw.match(/"cache_control"/g)).toHaveLength(2);
    }
  });

  it("sends the request as before without files", async () => {
    const before = JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 500,
      system: [{ type: "text", text: "Sistem", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Sorular" }],
      output_config: { effort: "medium" },
    });
    expect((await send({})).raw).toBe(before);
    expect((await send({ documents: undefined })).raw).toBe(before);
    expect((await send({ documents: [] })).raw).toBe(before);
    expect((await send({ stream: false })).raw).toBe(before);
    expect((await send({ stream: undefined })).raw).toBe(before);
    // The limit of a stream is no part of a request that is not streamed.
    expect((await send({ timeoutMs: 1 })).raw).toBe(before);
  });
});

/** Server-sent events as the Messages API streams them. */
const sse = (...events: [string, unknown][]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const messageStart = [
  "message_start",
  {
    type: "message_start",
    message: {
      id: "msg_2",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5-20261001",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1200,
        output_tokens: 1,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      },
    },
  },
] as [string, unknown];

/** Thinking, then the text in pieces: the events up to the end of the text block. */
const answerBlocks = (pieces: string[]): [string, unknown][] => [
  messageStart,
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Dosyaları okuyorum" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["ping", { type: "ping" }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
  ...pieces.map((text): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }]),
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
];

/** A whole answer; message_delta carries the stop reason and the totals that it overrides. */
const answerStream = (pieces = ['{"ok"', ":", "true}"], delta: Record<string, unknown> = { stop_reason: "end_turn", stop_sequence: null }) =>
  sse(
    ...answerBlocks(pieces),
    ["message_delta", { type: "message_delta", delta, usage: { output_tokens: 2400, input_tokens: 1250 } }],
    ["message_stop", { type: "message_stop" }],
  );

describe("createLlmClient streaming", () => {
  const request: LlmRequest = {
    model: "claude-sonnet-5-5",
    system: "Sistem",
    user: "Sorular",
    maxTokens: 500,
    effort: "high",
    schema: z.object({ ok: z.boolean() }),
    documents: [{ kind: "pdf", data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), title: "Şartname.pdf" }],
  };

  async function call(answer: string, more: Partial<LlmRequest> = {}, status = 200, contentType = "text/event-stream") {
    const { fetchImpl, sent } = fakeFetch(status, answer, contentType);
    const outcome = await createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 })
      .complete({ ...request, stream: true, ...more })
      .then(
        (response) => ({ response, error: null }),
        (error: unknown) => ({ response: null, error }),
      );
    return { ...outcome, sent };
  }

  it("sends the same request with stream: true, and an answer longer than the SDK allows unstreamed", async () => {
    const { sent } = await call(answerStream());
    const { fetchImpl, sent: plain } = fakeFetch(200, message);
    await createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 }).complete(request);
    const { stream, ...rest } = sent[0]!.body;
    expect(stream).toBe(true);
    expect(rest).toEqual(plain[0]!.body);
    expect((rest.messages as { content: { type: string }[] }[])[0]!.content.map((block) => block.type)).toEqual(["document", "text"]);

    // 32,000 tokens: refused unstreamed before anything is sent, read streamed.
    const unstreamed = fakeFetch(200, message);
    const refused = await createLlmClient("test-key", { fetch: unstreamed.fetchImpl, maxRetries: 0 })
      .complete({ ...request, maxTokens: 32_000 })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Anthropic.AnthropicError);
    expect(String(refused)).toContain("Streaming is required");
    expect(unstreamed.sent).toHaveLength(0);
    const long = await call(answerStream(), { maxTokens: 32_000 });
    expect(long.error).toBeNull();
    expect(long.sent[0]!.body.max_tokens).toBe(32_000);
  });

  it("joins the text after the thinking and reads the usage of message_start and message_delta", async () => {
    const { response } = await call(answerStream());
    expect(response).toEqual({
      text: '{"ok":true}',
      stopReason: "end_turn",
      refusalCategory: null,
      model: "claude-sonnet-5-5-20261001",
      // Output from message_delta, which also overrides the input total; the cache counts from message_start.
      usage: { inputTokens: 1250, outputTokens: 2400, cacheReadTokens: 900, cacheWriteTokens: 300, cacheWrite1hTokens: 200 },
    });
  });

  it("gives back an answer cut at max_tokens, off the schema or refused, as text for the caller to judge", async () => {
    const cut = await call(answerStream(['{"ok"', ":tr"], { stop_reason: "max_tokens", stop_sequence: null }));
    expect(cut.response).toMatchObject({ text: '{"ok":tr', stopReason: "max_tokens", refusalCategory: null });

    const offSchema = await call(answerStream(['{"ok":"evet"}']));
    expect(offSchema.response).toMatchObject({ text: '{"ok":"evet"}', stopReason: "end_turn" });

    const refusal = await call(
      answerStream([""], { stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: "cyber", explanation: null } }),
    );
    expect(refusal.response).toMatchObject({ text: "", stopReason: "refusal", refusalCategory: "cyber" });
  });

  it("throws an API error that comes in the stream", async () => {
    const { error } = await call(
      sse(...answerBlocks(['{"ok"']), ["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]),
    );
    expect(error).toBeInstanceOf(Anthropic.APIError);
    expect((error as InstanceType<typeof Anthropic.APIError>).type).toBe("overloaded_error");
    // Sent within a 200 answer: no HTTP status of its own.
    expect(llmErrorStatus(error)).toBeNull();
    expect(isPromptTooLong(error)).toBe(false);
  });

  it("throws when the stream ends before its message does, rather than giving part of it", async () => {
    const cut = await call(sse(...answerBlocks(['{"ok"'])));
    expect(cut.error).toBeInstanceOf(Anthropic.AnthropicError);
    expect(String(cut.error)).toContain("stream ended without producing a Message");

    // A message_stop without the message_delta that says why it stopped.
    const unfinished = await call(sse(...answerBlocks(['{"ok":true}']), ["message_stop", { type: "message_stop" }]));
    expect(unfinished.error).toBeInstanceOf(Anthropic.AnthropicError);
    expect(String(unfinished.error)).toContain("Akış, yanıt tamamlanmadan bitti.");
  });

  /** A stream that begins and then never ends, until the request is aborted, as fetch does. */
  const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(...answerBlocks(['{"ok"']))));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  it("cuts off a stream that does not end, saying after how long", async () => {
    const error = await createLlmClient("test-key", { fetch: hanging, maxRetries: 0 })
      .complete({ ...request, stream: true, timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Anthropic.AnthropicError);
    expect(error).not.toBeInstanceOf(Anthropic.APIUserAbortError);
    expect(String(error)).toContain("Yanıt 50 milisaniyede tamamlanmadı.");
    expect(llmErrorStatus(error)).toBeNull();
  });

  it("gives a stream 30 minutes by default, and leaves no timer behind one that ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const pending = createLlmClient("test-key", { fetch: hanging, maxRetries: 0 })
        .complete({ ...request, stream: true })
        .catch((e: unknown) => e)
        .finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(String(await pending)).toContain("Yanıt 30 dakikada tamamlanmadı.");

      const { fetchImpl } = fakeFetch(200, answerStream(), "text/event-stream");
      await createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 }).complete({ ...request, stream: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the status of an HTTP error that comes before the stream begins", async () => {
    const tooLong = await call(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 1042311 tokens > 1000000 maximum" } }),
      {},
      400,
      "application/json",
    );
    expect(llmErrorStatus(tooLong.error)).toBe(400);
    expect(isPromptTooLong(tooLong.error)).toBe(true);

    const tooLarge = await call("<html>413 Request Entity Too Large</html>", {}, 413, "text/html");
    expect(llmErrorStatus(tooLarge.error)).toBe(413);
    expect(isPromptTooLong(tooLarge.error)).toBe(true);
  });
});

describe("isPromptTooLong", () => {
  async function failure(status: number, body: unknown, contentType?: string) {
    const { fetchImpl } = fakeFetch(status, body, contentType);
    return createLlmClient("test-key", { fetch: fetchImpl, maxRetries: 0 })
      .complete({ model: "claude-sonnet-5-5", system: "S", user: "U", maxTokens: 10, effort: "low" })
      .catch((e: unknown) => e);
  }
  const apiError = (type: string, message: string) => ({ type: "error", error: { type, message }, request_id: "req_011CgB" });

  it("is true for a request too big for one call", async () => {
    for (const message of [
      "prompt is too long: 208310 tokens > 200000 maximum",
      "Prompt is too long: 1042311 tokens > 1000000 maximum",
      "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again",
      "messages.0.content.0.pdf.source.base64.data: A maximum of 100 PDF pages may be provided.",
    ]) {
      expect(isPromptTooLong(await failure(400, apiError("invalid_request_error", message))), message).toBe(true);
    }
    // Over 32 MB, whatever answers: the API's JSON or Cloudflare's page.
    expect(isPromptTooLong(await failure(413, apiError("request_too_large", "Request exceeds the maximum allowed number of bytes.")))).toBe(true);
    expect(isPromptTooLong(await failure(413, "<html><body>413 Request Entity Too Large</body></html>", "text/html"))).toBe(true);
  });

  it("is false for other failures and for anything that is not an API error", async () => {
    for (const message of [
      "messages.0.content.0.pdf.source.base64.data: The PDF specified was not valid.",
      "You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
      "max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-sonnet-5-5",
    ]) {
      expect(isPromptTooLong(await failure(400, apiError("invalid_request_error", message))), message).toBe(false);
    }
    expect(isPromptTooLong(await failure(429, apiError("rate_limit_error", "prompt is too long for this rate limit")))).toBe(false);
    expect(isPromptTooLong(await failure(401, apiError("authentication_error", "invalid x-api-key")))).toBe(false);
    for (const value of [new Error("prompt is too long: 208310 tokens > 200000 maximum"), "prompt is too long", null, undefined]) {
      expect(isPromptTooLong(value)).toBe(false);
    }
  });
});
