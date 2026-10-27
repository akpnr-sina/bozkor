import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { TenderProgress } from "./progress";

/**
 * While `active`, asks /api/tenders/[id]/progress every `everyMs` whether
 * `watch` has moved on from what the page shows, and refreshes the page once
 * it has: a refresh renders the whole page again from the database, the
 * question reads two small values. Gives up after `forMs`; a reload starts it again.
 */
export function useProgressRefresh<K extends keyof TenderProgress>(
  tenderId: string,
  watch: K,
  shown: TenderProgress[K],
  { active, everyMs, forMs }: { active: boolean; everyMs: number; forMs: number },
) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let done = false;
    const stop = () => {
      done = true;
      clearInterval(timer);
    };
    const timer = setInterval(async () => {
      if (done) return;
      if (Date.now() - started > forMs) return stop();
      try {
        const response = await fetch(`/api/tenders/${tenderId}/progress`, { cache: "no-store" });
        if (!response.ok || done) return;
        const progress = (await response.json()) as TenderProgress;
        if (progress[watch] === shown) return;
        stop();
        router.refresh();
      } catch {
        // Offline for a moment: the next tick asks again.
      }
    }, everyMs);
    return stop;
  }, [active, tenderId, watch, shown, everyMs, forMs, router]);
}
