// Reading requests of the profile form (the CPV search, the live preview):
// only the latest answer counts, so starting a request aborts the one before
// it, and an answer that comes back after all is dropped.

export type Outcome<T> = { status: "done"; value: T } | { status: "aborted" } | { status: "failed"; error: unknown };

export type Latest<T> = {
  /** Runs a request, aborting the one still running. */
  run(request: (signal: AbortSignal) => Promise<T>): Promise<Outcome<T>>;
  /** Aborts the running request, if any (a component going away). */
  abort(): void;
};

export function createLatest<T>(): Latest<T> {
  let current: AbortController | null = null;
  return {
    async run(request) {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      try {
        const value = await request(controller.signal);
        return controller.signal.aborted ? { status: "aborted" } : { status: "done", value };
      } catch (error) {
        return controller.signal.aborted ? { status: "aborted" } : { status: "failed", error };
      } finally {
        if (current === controller) current = null;
      }
    },
    abort() {
      current?.abort();
      current = null;
    },
  };
}

/** What a failed request tells the team. */
export function requestError(error: unknown): string {
  if (error instanceof ResponseError && error.status === 401) return "Oturum süresi dolmuş olabilir; sayfayı yenileyin.";
  return "Sunucuya ulaşılamadı; biraz sonra tekrar deneyin.";
}

export class ResponseError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A JSON answer of the app's own API; any status but 2xx is a ResponseError. */
export async function fetchJson<T>(url: string, init: RequestInit & { signal: AbortSignal }, fetchImpl: typeof fetch = fetch): Promise<T> {
  const response = await fetchImpl(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  if (!response.ok) throw new ResponseError(response.status);
  return (await response.json()) as T;
}
