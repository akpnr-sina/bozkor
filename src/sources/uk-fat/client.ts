import { toZonedLocal } from "@/lib/time";
import { createThrottle, fetchJson, sleep, USER_AGENT, type RetryOptions } from "../http";
import type { SyncWindow } from "../types";
import { FAT_TIMEZONE } from "./normalize";
import { fatPackageSchema } from "./schema";

export const FAT_API_BASE = "https://www.find-tender.service.gov.uk/api/1.0";

const MAX_PAGES = 2_000;

export type FatClientOptions = RetryOptions & {
  /** Minimum gap between requests; the API rate limits aggressively. */
  minIntervalMs?: number;
  pageSize?: number;
  baseUrl?: string;
};

export function createFatClient(options: FatClientOptions = {}) {
  const {
    minIntervalMs = 1_500,
    pageSize = 100,
    baseUrl = FAT_API_BASE,
    // Full pages (~1 MB) regularly take 20-45 s before the first byte.
    timeoutMs = 120_000,
    ...retry
  } = options;
  const throttle = createThrottle(minIntervalMs, retry.sleep ?? sleep, retry.now);
  const origin = new URL(baseUrl).origin;

  /**
   * Release pages for a window, newest first. The API ignores UTC offsets in
   * updatedFrom/updatedTo and reads them as UK local time, so we send that.
   */
  async function* releasePages(window: SyncWindow): AsyncGenerator<unknown[]> {
    const params = new URLSearchParams({
      limit: String(pageSize),
      updatedFrom: toZonedLocal(window.from, FAT_TIMEZONE),
      updatedTo: toZonedLocal(window.to, FAT_TIMEZONE),
    });
    let url: string | null = `${baseUrl}/ocdsReleasePackages?${params}`;
    const visited = new Set<string>();

    for (let page = 0; url; page++) {
      if (page >= MAX_PAGES) throw new Error(`Find a Tender pagination exceeded ${MAX_PAGES} pages`);
      if (visited.has(url)) throw new Error(`Find a Tender pagination loop at ${url}`);
      visited.add(url);

      await throttle();
      const body = fatPackageSchema.parse(
        await fetchJson(
          url,
          { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
          { ...retry, timeoutMs },
        ),
      );
      yield body.releases;

      const next: string | null = body.links?.next ?? null;
      if (next && new URL(next).origin !== origin) {
        throw new Error(`Refusing to follow pagination link to another host: ${next}`);
      }
      url = next;
    }
  }

  return { releasePages };
}
