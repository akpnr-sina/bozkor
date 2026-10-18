"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 20_000;
/** The worker reads a file within a minute or two; a file still not read after this waits for a reload. */
const FOR_MS = 5 * 60_000;

/** Refreshes the page now and then while the worker reads files, so they turn "Analize girecek" by themselves. */
export function RefreshWhileReading({ active }: { active: boolean }) {
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
