import { describe, expect, it, vi } from "vitest";
import { createThrottle, fetchJson, HttpError, parseRetryAfter, type FetchLike } from "./http";

function scripted(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function recorder() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("fetchJson", () => {
  it("returns the parsed body on success", async () => {
    const { fetch } = scripted([json({ ok: true })]);
    await expect(fetchJson("https://api.test/x", {}, { fetch })).resolves.toEqual({ ok: true });
  });

  it("waits for Retry-After on 429 before retrying", async () => {
    const { fetch, calls } = scripted([json({}, 429, { "retry-after": "7" }), json({ ok: true })]);
    const { delays, sleep } = recorder();
    await expect(fetchJson("https://api.test/x", {}, { fetch, sleep })).resolves.toEqual({ ok: true });
    expect(delays).toEqual([7_000]);
    expect(calls).toHaveLength(2);
  });

  it("backs off exponentially on server errors", async () => {
    const { fetch } = scripted([json({}, 503), json({}, 502), json({ ok: true })]);
    const { delays, sleep } = recorder();
    await fetchJson("https://api.test/x", {}, { fetch, sleep, random: () => 1, baseDelayMs: 1_000 });
    expect(delays).toEqual([1_000, 2_000]);
  });

  it("retries network errors", async () => {
    const { fetch } = scripted([new TypeError("fetch failed"), json({ ok: true })]);
    const { delays, sleep } = recorder();
    await expect(fetchJson("https://api.test/x", {}, { fetch, sleep })).resolves.toEqual({ ok: true });
    expect(delays).toHaveLength(1);
  });

  it("retries when the body breaks off or is not valid JSON", async () => {
    const truncated = new Response('{"releases": [', { status: 200, headers: { "content-type": "application/json" } });
    const { fetch, calls } = scripted([truncated, json({ ok: true })]);
    const { delays, sleep } = recorder();
    await expect(fetchJson("https://api.test/x", {}, { fetch, sleep })).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(delays).toHaveLength(1);
  });

  it("does not retry client errors other than 429", async () => {
    const { fetch, calls } = scripted([json({ error: "nope" }, 404)]);
    await expect(fetchJson("https://api.test/x", {}, { fetch })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after the maximum number of attempts", async () => {
    const { fetch, calls } = scripted([json({}, 503), json({}, 503), json({}, 503)]);
    const { sleep } = recorder();
    await expect(fetchJson("https://api.test/x", {}, { fetch, sleep, maxAttempts: 3 })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(3);
  });

  it("caps very long Retry-After values", async () => {
    const { fetch } = scripted([json({}, 429, { "retry-after": "86400" }), json({ ok: true })]);
    const { delays, sleep } = recorder();
    await fetchJson("https://api.test/x", {}, { fetch, sleep, maxDelayMs: 60_000 });
    expect(delays).toEqual([60_000]);
  });
});

describe("parseRetryAfter", () => {
  it("accepts seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter("Tue, 13 Oct 2026 12:01:00 GMT", now)).toBe(60_000);
  });

  it("ignores missing or malformed values", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });
});

describe("createThrottle", () => {
  it("spaces consecutive calls by the minimum interval", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const throttle = createThrottle(1_500, sleep, () => clock);
    await throttle();
    clock += 500;
    await throttle();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
