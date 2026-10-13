import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import type { FetchLike } from "../http";
import { createFatClient } from "./client";

type Package = { releases: unknown[]; links?: { next?: string } };

function fakeApi(pages: Package[]) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const page = pages.shift();
    if (!page) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(page), { status: 200 });
  };
  return { fetch, urls };
}

const noSleep = async () => {};

async function collect(iterable: AsyncIterable<unknown[]>) {
  const pages: unknown[][] = [];
  for await (const page of iterable) pages.push(page);
  return pages;
}

describe("createFatClient", () => {
  it("sends the window as UK local time and follows links.next", async () => {
    const first = loadFixture<Package>("uk-fat", "package-page");
    const second: Package = { releases: [loadFixture("uk-fat", "uk6-award")] };
    const { fetch, urls } = fakeApi([first, second]);
    const client = createFatClient({ fetch, sleep: noSleep });

    const pages = await collect(
      client.releasePages({ from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-12T23:00:00Z") }),
    );

    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    const firstUrl = new URL(urls[0] ?? "");
    expect(firstUrl.pathname).toBe("/api/1.0/ocdsReleasePackages");
    // 00:00 and 23:00 UTC are 01:00 and 00:00 the next day in British Summer Time.
    expect(firstUrl.searchParams.get("updatedFrom")).toBe("2026-10-12T01:00:00");
    expect(firstUrl.searchParams.get("updatedTo")).toBe("2026-10-13T00:00:00");
    expect(firstUrl.searchParams.get("limit")).toBe("100");
    expect(urls[1]).toBe(first.links?.next);
  });

  it("refuses pagination links that point to another host", async () => {
    const { fetch } = fakeApi([{ releases: [], links: { next: "https://evil.example/api" } }]);
    const client = createFatClient({ fetch, sleep: noSleep });
    await expect(
      collect(client.releasePages({ from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-12T01:00:00Z") })),
    ).rejects.toThrow(/another host/);
  });

  it("stops when the API repeats the same next link", async () => {
    const loop = "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?cursor=same";
    const { fetch } = fakeApi([
      { releases: [], links: { next: loop } },
      { releases: [], links: { next: loop } },
    ]);
    const client = createFatClient({ fetch, sleep: noSleep });
    await expect(
      collect(client.releasePages({ from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-12T01:00:00Z") })),
    ).rejects.toThrow(/loop/);
  });
});
