import { z } from "zod";
import { toZonedLocal } from "@/lib/time";
import { createThrottle, fetchJson, sleep, USER_AGENT, type RetryOptions } from "../http";
import type { SyncWindow } from "../types";
import { TED_BASE_QUERY, TED_FIELDS, TED_SEARCH_URL, tedDateRange } from "./fields";

/** TED publication dates are days on the Brussels (Luxembourg) calendar. */
export const TED_TIMEZONE = "Europe/Brussels";

const MAX_PAGES = 2_000;

// A page may hold at most 250 notices and 10,000 fields, counted as
// limit x (requested fields + the links field the API always adds). Checked on
// 14 October 2026 with 45 fields: 217 notices passed, 222 got HTTP 400.
const MAX_NOTICES_PER_PAGE = 250;
const MAX_FIELDS_PER_PAGE = 10_000;
export const TED_MAX_PAGE_SIZE = Math.min(
  MAX_NOTICES_PER_PAGE,
  Math.floor(MAX_FIELDS_PER_PAGE / (TED_FIELDS.length + 1)),
);

const tedPageSchema = z.object({
  notices: z.array(z.record(z.string(), z.unknown())),
  // Every scroll page carries a token, the last one too: the end is a page
  // without notices. A missing token ends the scroll as well.
  iterationNextToken: z.string().nullish(),
  totalNoticeCount: z.number(),
  timedOut: z.boolean().optional(),
});

export type TedClientOptions = RetryOptions & {
  /** Minimum gap between requests. */
  minIntervalMs?: number;
  /** Notices per page; capped at TED_MAX_PAGE_SIZE. */
  pageSize?: number;
  url?: string;
};

/** The TED publication day (YYYY-MM-DD, Brussels calendar) that `instant` falls on. */
export function tedDay(instant: Date): string {
  return toZonedLocal(instant, TED_TIMEZONE).slice(0, 10);
}

const DAY_MS = 86_400_000;

/** The calendar day after `day` (YYYY-MM-DD). */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** The notice without its links: the same notice in 24 languages and several formats, derivable from its number. */
function withoutLinks(notice: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...notice };
  delete copy.links;
  return copy;
}

export function createTedClient(options: TedClientOptions = {}) {
  const {
    minIntervalMs = 1_000,
    pageSize = TED_MAX_PAGE_SIZE,
    url = TED_SEARCH_URL,
    timeoutMs = 120_000,
    ...retry
  } = options;
  const limit = Math.max(1, Math.min(Math.floor(pageSize), TED_MAX_PAGE_SIZE));
  const throttle = createThrottle(minIntervalMs, retry.sleep ?? sleep, retry.now);
  const now = retry.now ?? Date.now;
  // Past days this client has scrolled through in full. Backfill windows
  // start at any hour, so consecutive windows share a day.
  const completedDays = new Set<string>();

  /**
   * Notices published on the window's days. Scroll mode ("ITERATION") keeps
   * a point in time on the server, so no notice is missed or repeated across
   * pages, and it has no cap on the number of results.
   *
   * Leading days an earlier window already fetched in full are skipped; when
   * none is left, nothing is requested. A scroll that ends cleanly marks its
   * days before today as complete; one that breaks off marks nothing.
   */
  async function* noticePages(window: SyncWindow): AsyncGenerator<unknown[]> {
    const toDay = tedDay(window.to);
    let fromDay = tedDay(window.from);
    while (fromDay <= toDay && completedDays.has(fromDay)) fromDay = nextDay(fromDay);
    if (fromDay > toDay) return;

    // Read before the first page: today's edition may not be out yet, so
    // only earlier days of this scroll can count as complete.
    const today = tedDay(new Date(now()));
    const query = `${TED_BASE_QUERY} AND ${tedDateRange(fromDay, toDay)}`;
    const seenTokens = new Set<string>();
    let token: string | undefined;

    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`TED pagination exceeded ${MAX_PAGES} pages`);

      await throttle();
      const body = tedPageSchema.parse(
        await fetchJson(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
            body: JSON.stringify({
              query,
              fields: TED_FIELDS,
              limit,
              scope: "ALL",
              paginationMode: "ITERATION",
              ...(token ? { iterationNextToken: token } : {}),
            }),
          },
          { ...retry, timeoutMs },
        ),
      );
      // A timed-out search can return part of a page; failing the run makes
      // the next one fetch these days again instead of skipping notices.
      if (body.timedOut) throw new Error(`TED search timed out on page ${page}`);
      if (!body.notices.length) break;
      // If the caller fails while storing this page, the generator is closed
      // here and the marking below never runs.
      yield body.notices.map(withoutLinks);

      const next = body.iterationNextToken;
      if (!next) break;
      if (seenTokens.has(next)) throw new Error(`TED pagination loop: page ${page} repeated an earlier token`);
      seenTokens.add(next);
      token = next;
    }

    for (let day = fromDay; day <= toDay && day < today; day = nextDay(day)) completedDays.add(day);
  }

  return { noticePages };
}
