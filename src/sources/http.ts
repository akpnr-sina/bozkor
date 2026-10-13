export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const USER_AGENT = "BozkorTenderIntelligence/0.1";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "HttpError";
  }
}

export type RetryOptions = {
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Total attempts including the first one. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
};

/** Retry-After as seconds or an HTTP date; returns milliseconds or null. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * GET JSON with a timeout per attempt. 429 honours Retry-After, otherwise
 * 429 / 5xx / network errors back off exponentially with jitter.
 */
export async function fetchJson(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<unknown> {
  const {
    fetch: fetchImpl = fetch,
    sleep: sleepImpl = sleep,
    maxAttempts = 6,
    baseDelayMs = 2_000,
    maxDelayMs = 5 * 60_000,
    timeoutMs = 60_000,
    random = Math.random,
    now = Date.now,
    onRetry,
  } = options;

  const backoff = (attempt: number) => {
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + random() * 0.5));
  };

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // Reading the body can also time out, drop the socket or end in
      // truncated JSON; those are as transient as a failed connection.
      if (response.ok) body = await response.json();
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const delayMs = backoff(attempt);
      onRetry?.({ attempt, delayMs, reason: error instanceof Error ? error.message : String(error) });
      await sleepImpl(delayMs);
      continue;
    }

    if (response.ok) return body;

    const text = await response.text().catch(() => "");
    if (!isRetryableStatus(response.status) || attempt >= maxAttempts) {
      throw new HttpError(response.status, url, text);
    }
    const retryAfter =
      response.status === 429 ? parseRetryAfter(response.headers.get("retry-after"), now()) : null;
    const delayMs = Math.min(retryAfter ?? backoff(attempt), maxDelayMs);
    onRetry?.({ attempt, delayMs, reason: `HTTP ${response.status}` });
    await sleepImpl(delayMs);
  }
}

/** Spaces out calls so consecutive requests start at least `minIntervalMs` apart. */
export function createThrottle(minIntervalMs: number, sleepImpl: Sleep = sleep, now: () => number = Date.now) {
  let last = -Infinity;
  return async () => {
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleepImpl(wait);
    last = now();
  };
}
