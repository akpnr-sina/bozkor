/** Codes of a connection that died under a query: a laptop that slept, a pooler that dropped it. */
const CONNECTION_LOST = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "CONNECTION_ENDED", "CONNECTION_CLOSED", "CONNECTION_DESTROYED"]);

/** True when the error, or one it wraps (Drizzle wraps the driver's), is a lost connection. */
export function isConnectionLost(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && CONNECTION_LOST.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Runs a read once more when its connection died under it: postgres-js drops
 * the dead connection and the second try gets a fresh one. Reads only; a
 * write may have reached the database before its connection died.
 */
export async function retryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isConnectionLost(error)) throw error;
    return read();
  }
}
