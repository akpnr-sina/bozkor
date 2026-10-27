"use client";

import { DEEP_STALE_MINUTES } from "@/analysis/deep-limits";
import type { TenderProgress } from "./progress";
import { useProgressRefresh } from "./use-progress-refresh";

const EVERY_MS = 15_000;
/**
 * A deep analysis waits its turn and then reads every file, which takes
 * minutes; a few minutes past the time the worker takes up a request a dead
 * run left (DEEP_STALE_MINUTES), the page waits for a reload.
 */
const FOR_MS = (DEEP_STALE_MINUTES + 5) * 60_000;

/** Refreshes the page when the deep analysis request moves on (taken up, done, failed), so its result appears by itself. */
export function DeepRefresh({ tenderId, active, status }: { tenderId: string; active: boolean; status: TenderProgress["deep"] }) {
  useProgressRefresh(tenderId, "deep", status, { active, everyMs: EVERY_MS, forMs: FOR_MS });
  return null;
}
