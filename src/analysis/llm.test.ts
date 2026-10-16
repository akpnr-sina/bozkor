import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient, llmErrorStatus } from "./llm";

/** A fetch that answers like the Messages API and keeps what was sent. */
function fakeFetch(status: number, body: unknown) {
  const sent: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
