import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import { USER_AGENT, type FetchLike } from "../http";
import type { SyncWindow } from "../types";
import { createTedClient, TED_MAX_PAGE_SIZE, tedDay } from "./client";
import { TED_BASE_QUERY, TED_FIELDS, TED_SEARCH_URL } from "./fields";

type Page = {
  notices: unknown;
  iterationNextToken?: string | null;
  totalNoticeCount?: number;
  timedOut?: boolean;
};
type RecordedPage = { notices: Record<string, unknown>[]; iterationNextToken: string };

// A scroll over Maltese supply notices of 13 October 2026, recorded without
// the links field; the last page is empty but still carries a token.
const first = loadFixture<RecordedPage>("eu-ted", "ted-search-page");
const second = loadFixture<RecordedPage>("eu-ted", "ted-search-page-2");
const last = loadFixture<RecordedPage>("eu-ted", "ted-search-page-3");
const [someNotice, otherNotice] = first.notices;

/** Serves scripted search pages and records each request. */
function fakeTed(pages: Page[]) {
  const requests: { url: string; method?: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const page = pages.shift();
    if (!page) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify({ totalNoticeCount: 4, timedOut: false, ...page }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

/** Puts back the links the API adds to every notice. */
const withLinks = (page: RecordedPage): Page => ({
  ...page,
  notices: page.notices.map((notice) => {
    const number = String(notice["publication-number"]);
    return {
      ...notice,
      links: {
        xml: { MUL: `https://ted.europa.eu/en/notice/${number}/xml` },
        pdf: { ENG: `https://ted.europa.eu/en/notice/${number}/pdf` },
      },
    };
  }),
});

const noSleep = async () => {};

async function collect(iterable: AsyncIterable<unknown[]>) {
  const pages: unknown[][] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

// 00:30 and 23:59:59 in Brussels summer time, both on 13 October.
const oneDay: SyncWindow = { from: new Date("2026-10-12T22:30:00Z"), to: new Date("2026-10-13T21:59:59Z") };

describe("createTedClient", () => {
  it("posts the supplies query for the window's days, the fields and scroll mode", async () => {
    const { fetch, requests } = fakeTed([last]);
    await collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay));

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(TED_SEARCH_URL);
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("content-type")).toBe("application/json");
    expect(request?.headers.get("accept")).toBe("application/json");
    expect(request?.headers.get("user-agent")).toBe(USER_AGENT);
    expect(request?.body).toEqual({
      query: `${TED_BASE_QUERY} AND publication-date>=20261013 AND publication-date<=20261013`,
      fields: [...TED_FIELDS],
      limit: TED_MAX_PAGE_SIZE,
      scope: "ALL",
      paginationMode: "ITERATION",
    });
  });

  it("scrolls through the recorded pages and drops the generated links", async () => {
    const { fetch, requests } = fakeTed([withLinks(first), withLinks(second), last]);
    const pages = await collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay));

    // Every field but links, as recorded.
    expect(pages).toEqual([first.notices, second.notices]);
    expect(requests.map((r) => r.body.iterationNextToken)).toEqual([
      undefined,
      first.iterationNextToken,
      second.iterationNextToken,
    ]);
    expect(new Set(requests.map((r) => r.body.query)).size).toBe(1);
  });

  it("stops when a page has no token", async () => {
    const { fetch, requests } = fakeTed([{ notices: [someNotice], iterationNextToken: null }]);
    const pages = await collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay));
    expect(pages).toEqual([[someNotice]]);
    expect(requests).toHaveLength(1);
  });

  it("turns the window into days on the Brussels calendar", async () => {
    const { fetch, requests } = fakeTed([last]);
    // 22:00 UTC on 13 October is already midnight of the 14th in Brussels.
    const window = { from: new Date("2026-10-13T21:59:59Z"), to: new Date("2026-10-13T22:00:00Z") };
    await collect(createTedClient({ fetch, sleep: noSleep }).noticePages(window));
    expect(requests[0]?.body.query).toBe(
      `${TED_BASE_QUERY} AND publication-date>=20261013 AND publication-date<=20261014`,
    );
  });

  it("caps the page size where the API's 10,000 fields per page would be exceeded", async () => {
    // The API counts the links field it adds to every notice.
    expect(TED_MAX_PAGE_SIZE * (TED_FIELDS.length + 1)).toBeLessThanOrEqual(10_000);
    expect(TED_MAX_PAGE_SIZE === 250 || (TED_MAX_PAGE_SIZE + 1) * (TED_FIELDS.length + 1) > 10_000).toBe(true);

    const big = fakeTed([last]);
    await collect(createTedClient({ fetch: big.fetch, sleep: noSleep, pageSize: 1_000 }).noticePages(oneDay));
    expect(big.requests[0]?.body.limit).toBe(TED_MAX_PAGE_SIZE);

    const small = fakeTed([last]);
    await collect(createTedClient({ fetch: small.fetch, sleep: noSleep, pageSize: 50 }).noticePages(oneDay));
    expect(small.requests[0]?.body.limit).toBe(50);
  });

  it("waits at least a second between requests", async () => {
    let clock = 0;
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
      clock += ms;
    };
    const { fetch } = fakeTed([first, second, last]);
    await collect(createTedClient({ fetch, sleep, now: () => clock }).noticePages(oneDay));
    expect(delays).toEqual([1_000, 1_000]);
  });

  it("stops when the API repeats a token", async () => {
    const { fetch } = fakeTed([
      { notices: [someNotice], iterationNextToken: "same" },
      { notices: [otherNotice], iterationNextToken: "same" },
    ]);
    await expect(collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay))).rejects.toThrow(/loop/);
  });

  it("fails instead of passing on a page from a timed-out search", async () => {
    const { fetch } = fakeTed([{ ...first, timedOut: true }]);
    await expect(collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay))).rejects.toThrow(/timed out/);
  });

  it("rejects a page that does not look like a search result", async () => {
    const { fetch } = fakeTed([{ notices: "none", iterationNextToken: null }]);
    await expect(collect(createTedClient({ fetch, sleep: noSleep }).noticePages(oneDay))).rejects.toThrow();
  });
});

describe("completed days", () => {
  // 14 October in Brussels: days up to the 13th can be complete.
  const now = () => Date.parse("2026-10-14T10:00:00Z");
  const days = (from: string, to: string): SyncWindow => ({ from: new Date(from), to: new Date(to) });
  const dayRange = (request: { body: Record<string, unknown> }) =>
    String(request.body.query).replace(`${TED_BASE_QUERY} AND `, "");

  it("starts after the days an earlier window fetched in full", async () => {
    const { fetch, requests } = fakeTed([first, last, last]);
    const client = createTedClient({ fetch, sleep: noSleep, now });
    // 08:00 to 08:00 UTC spans two Brussels days; the second window starts on the first one's last day.
    await collect(client.noticePages(days("2026-10-11T08:00:00Z", "2026-10-12T08:00:00Z")));
    await collect(client.noticePages(days("2026-10-12T08:00:00Z", "2026-10-13T08:00:00Z")));
    expect(requests.map(dayRange)).toEqual([
      "publication-date>=20261011 AND publication-date<=20261012",
      "publication-date>=20261011 AND publication-date<=20261012",
      "publication-date>=20261013 AND publication-date<=20261013",
    ]);
  });

  it("sends nothing when every day of the window is complete", async () => {
    const { fetch, requests } = fakeTed([last]);
    const client = createTedClient({ fetch, sleep: noSleep, now });
    await collect(client.noticePages(days("2026-10-11T08:00:00Z", "2026-10-12T08:00:00Z")));
    const pages = await collect(client.noticePages(days("2026-10-11T12:00:00Z", "2026-10-12T12:00:00Z")));
    expect(pages).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("never marks today, whose edition may still be on its way", async () => {
    const { fetch, requests } = fakeTed([last, last]);
    const client = createTedClient({ fetch, sleep: noSleep, now });
    const window = days("2026-10-13T08:00:00Z", "2026-10-14T08:00:00Z");
    await collect(client.noticePages(window));
    await collect(client.noticePages(window));
    expect(requests.map(dayRange)).toEqual([
      "publication-date>=20261013 AND publication-date<=20261014",
      "publication-date>=20261014 AND publication-date<=20261014",
    ]);
  });

  it("marks nothing when a scroll breaks off", async () => {
    const window = days("2026-10-11T08:00:00Z", "2026-10-12T08:00:00Z");
    const range = "publication-date>=20261011 AND publication-date<=20261012";

    const timedOut = fakeTed([{ ...first, timedOut: true }, last]);
    const a = createTedClient({ fetch: timedOut.fetch, sleep: noSleep, now });
    await expect(collect(a.noticePages(window))).rejects.toThrow(/timed out/);
    await collect(a.noticePages(window));
    expect(timedOut.requests.map(dayRange)).toEqual([range, range]);

    const malformed = fakeTed([first, { notices: "none", iterationNextToken: null }, last]);
    const b = createTedClient({ fetch: malformed.fetch, sleep: noSleep, now });
    await expect(collect(b.noticePages(window))).rejects.toThrow();
    await collect(b.noticePages(window));
    expect(malformed.requests.map(dayRange)).toEqual([range, range, range]);

    // The sync fails while storing the first page and closes the generator.
    const storing = fakeTed([first, last]);
    const c = createTedClient({ fetch: storing.fetch, sleep: noSleep, now });
    const failWhileStoring = async () => {
      for await (const page of c.noticePages(window)) {
        if (page.length) throw new Error("database down");
      }
    };
    await expect(failWhileStoring()).rejects.toThrow("database down");
    await collect(c.noticePages(window));
    expect(storing.requests.map(dayRange)).toEqual([range, range]);
  });
});

describe("tedDay", () => {
  it("reads the Brussels date in summer and winter time", () => {
    expect(tedDay(new Date("2026-10-13T21:59:59Z"))).toBe("2026-10-13");
    expect(tedDay(new Date("2026-10-13T22:00:00Z"))).toBe("2026-10-14");
    expect(tedDay(new Date("2026-12-01T22:59:59Z"))).toBe("2026-12-01");
    expect(tedDay(new Date("2026-12-01T23:00:00Z"))).toBe("2026-12-02");
  });
});
