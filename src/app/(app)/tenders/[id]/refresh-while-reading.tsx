"use client";

import { useProgressRefresh } from "./use-progress-refresh";

const EVERY_MS = 20_000;
/** The worker reads a file within a minute or two; a file still not read after this waits for a reload. */
const FOR_MS = 5 * 60_000;

/** Refreshes the page when the worker has read a file, so it turns "Analize girecek" by itself. */
export function RefreshWhileReading({ tenderId, reading }: { tenderId: string; reading: number }) {
  useProgressRefresh(tenderId, "reading", reading, { active: reading > 0, everyMs: EVERY_MS, forMs: FOR_MS });
  return null;
}
