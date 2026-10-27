import { describe, expect, it } from "vitest";
import { createLatest, fetchJson, requestError, ResponseError } from "./latest";

/** A request that waits until the test answers it, and records whether it was aborted. */
function pending<T>() {
  let answer!: (value: T) => void;
  let fail!: (error: unknown) => void;
  let signal!: AbortSignal;
  const request = (s: AbortSignal) => {
    signal = s;
    return new Promise<T>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
  };
  return { request, answer: (v: T) => answer(v), fail: (e: unknown) => fail(e), aborted: () => signal.aborted };
}

describe("createLatest", () => {
  it("aborts the running request when a new one starts, and drops its late answer", async () => {
    const latest = createLatest<string>();
    const first = pending<string>();
    const second = pending<string>();
    const firstOutcome = latest.run(first.request);
    const secondOutcome = latest.run(second.request);
    expect(first.aborted()).toBe(true);
    expect(second.aborted()).toBe(false);

    first.answer("31");
    second.answer("312");
    expect(await firstOutcome).toEqual({ status: "aborted" });
    expect(await secondOutcome).toEqual({ status: "done", value: "312" });
  });

  it("tells a failure from an abort", async () => {
    const latest = createLatest<string>();
    const failing = pending<string>();
    const outcome = latest.run(failing.request);
    failing.fail(new ResponseError(500));
    expect(await outcome).toEqual({ status: "failed", error: new ResponseError(500) });

    // A fetch aborted by the next request rejects; that is no failure.
    const aborted = pending<string>();
    const abortedOutcome = latest.run(aborted.request);
    const next = latest.run(async () => "ok");
    aborted.fail(new DOMException("The operation was aborted.", "AbortError"));
    expect(await abortedOutcome).toEqual({ status: "aborted" });
    expect(await next).toEqual({ status: "done", value: "ok" });
  });

  it("aborts the running request when the component goes away, and runs again after", async () => {
    const latest = createLatest<string>();
    const running = pending<string>();
    const outcome = latest.run(running.request);
    latest.abort();
    expect(running.aborted()).toBe(true);
    running.answer("late");
    expect(await outcome).toEqual({ status: "aborted" });
    expect(await latest.run(async () => "again")).toEqual({ status: "done", value: "again" });
  });
});

describe("fetchJson", () => {
  const fake = (status: number, body: unknown) =>
    (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

  it("reads the JSON of a 2xx answer, and throws the status of any other", async () => {
    const signal = new AbortController().signal;
    expect(await fetchJson("/api/cpv/search?q=3112", { signal }, fake(200, [{ prefix: "3112" }]))).toEqual([{ prefix: "3112" }]);
    await expect(fetchJson("/api/cpv/search?q=3112", { signal }, fake(401, { error: "unauthorized" }))).rejects.toEqual(new ResponseError(401));
  });

  it("words the failures for the team", () => {
    expect(requestError(new ResponseError(401))).toBe("Oturum süresi dolmuş olabilir; sayfayı yenileyin.");
    expect(requestError(new ResponseError(500))).toBe("Sunucuya ulaşılamadı; biraz sonra tekrar deneyin.");
    expect(requestError(new TypeError("fetch failed"))).toBe("Sunucuya ulaşılamadı; biraz sonra tekrar deneyin.");
  });
});
