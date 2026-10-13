import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_AGENT, type FetchLike } from "@/sources/http";
import { ECB_DAILY_URL, fetchEcbRates, parseEcbXml } from "./ecb";

/** Recorded on 2026-10-13; the 90-day file is cut to its five newest days. */
const ecbFixture = (name: string) =>
  readFileSync(new URL(`../../tests/fixtures/ecb/${name}.xml`, import.meta.url), "utf8");

const daily = ecbFixture("eurofxref-daily");
const history = ecbFixture("eurofxref-hist-90d");

describe("parseEcbXml", () => {
  it("reads the daily file, whose attributes use single quotes", () => {
    const rates = parseEcbXml(daily);
    expect(rates).toHaveLength(29);
    expect(new Set(rates.map((r) => r.date))).toEqual(new Set(["2026-10-13"]));
    expect(rates).toContainEqual({ date: "2026-10-13", currency: "GBP", ratePerEur: 0.8446 });
    expect(rates).toContainEqual({ date: "2026-10-13", currency: "IDR", ratePerEur: 20004.87 });
    expect(rates.map((r) => r.currency)).not.toContain("EUR");
  });

  it("reads the history file, one day per line with double quotes", () => {
    const rates = parseEcbXml(history);
    expect(rates).toHaveLength(5 * 29);
    expect([...new Set(rates.map((r) => r.date))]).toEqual([
      "2026-10-13",
      "2026-10-12",
      "2026-10-09",
      "2026-10-08",
      "2026-10-07",
    ]);
    expect(rates).toContainEqual({ date: "2026-10-09", currency: "GBP", ratePerEur: 0.84763 });
    expect(rates).toContainEqual({ date: "2026-10-07", currency: "JPY", ratePerEur: 176.85 });
  });

  it("rejects an empty body", () => {
    expect(() => parseEcbXml("")).toThrow("ECB response is empty");
    expect(() => parseEcbXml(" \n\t")).toThrow("ECB response is empty");
  });

  it("rejects an error page served with status 200", () => {
    expect(() => parseEcbXml("<!DOCTYPE html><html><body>Service unavailable</body></html>")).toThrow(
      /not a complete eurofxref document: <!DOCTYPE html>/,
    );
  });

  it("rejects a cut-off document instead of returning the rates read so far", () => {
    expect(() => parseEcbXml(daily.slice(0, 700))).toThrow(/not a complete eurofxref document/);
  });

  it("rejects a document without rates", () => {
    const empty = daily.replace(/<Cube currency='[A-Z]+' rate='[\d.]+'\/>/g, "");
    expect(() => parseEcbXml(empty)).toThrow(/contains no rates/);
  });

  it("names the rate that fails validation", () => {
    expect(() => parseEcbXml(daily.replace("rate='1.1188'", "rate='n/a'"))).toThrow(
      /invalid rate .*"currency":"USD".*expected a decimal number/,
    );
    expect(() => parseEcbXml(daily.replace("currency='GBP'", "currency='gb'"))).toThrow(/expected an ISO 4217 code/);
    expect(() => parseEcbXml(daily.replace("time='2026-10-13'", "time='13.10.2026'"))).toThrow(/invalid rate/);
    expect(() => parseEcbXml(daily.replace("rate='0.84460'", "rate='0'"))).toThrow(/invalid rate/);
  });

  it("rejects a rate outside a dated Cube", () => {
    const undated = daily.replace("<Cube time='2026-10-13'>", "<Cube>");
    expect(() => parseEcbXml(undated)).toThrow(/rate outside a dated Cube/);
  });
});

describe("fetchEcbRates", () => {
  it("sends the platform User-Agent and parses the body", async () => {
    const requests: { url: string; userAgent: string | null }[] = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
      return new Response(daily, { status: 200, headers: { "content-type": "text/xml" } });
    };

    const rates = await fetchEcbRates(ECB_DAILY_URL, { fetch });
    expect(rates).toHaveLength(29);
    expect(requests).toEqual([{ url: ECB_DAILY_URL, userAgent: USER_AGENT }]);
  });

  it("puts the URL in parse errors", async () => {
    const fetch: FetchLike = async () => new Response("", { status: 200 });
    await expect(fetchEcbRates(ECB_DAILY_URL, { fetch })).rejects.toThrow(
      `${ECB_DAILY_URL}: ECB response is empty`,
    );
  });
});
