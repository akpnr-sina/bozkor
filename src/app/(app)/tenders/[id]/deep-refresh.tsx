"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DEEP_STALE_MINUTES } from "@/analysis/deep-limits";

const EVERY_MS = 15_000;
/**
 * A deep analysis waits its turn and then reads every file, which takes
 * minutes; a few minutes past the time the worker takes up a request a dead
 * run left (DEEP_STALE_MINUTES), the page waits for a reload.
 */
const FOR_MS = (DEEP_STALE_MINUTES + 5) * 60_000;

/** Refreshes the page now and then while a deep analysis is queued or running, so its result appears by itself (as RefreshWhileReading does for files). */
export function DeepRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > FOR_MS) clearInterval(timer);
      else router.refresh();
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
