import { max } from "drizzle-orm";
import type { AppDb } from "@/db";
import { fxRates } from "@/db/schema";
import type { RetryOptions } from "@/sources/http";
import { ECB_DAILY_URL, ECB_HIST_90D_URL, fetchEcbRates } from "./ecb";
import { daysBetween, ecbDay, storeRates } from "./rates";

/** When the newest stored rate is older than this, the daily file is not enough to catch up. */
const STALE_AFTER_DAYS = 5;

export type EcbSyncStats = {
  source: "daily" | "hist-90d";
  /** Reference dates in the downloaded file. */
  dates: number;
  /** Rates in the downloaded file. */
  rows: number;
  /** Rows that were new. */
  inserted: number;
  /** Stored rows whose rate the ECB had corrected. */
  updated: number;
  /** Newest reference date in fx_rates after the run. */
  latestDate: string;
};

/**
 * Brings fx_rates up to date. An empty table, or one whose newest rate is
 * more than five days old, gets the 90-day history; otherwise the daily file
 * is enough. Running it again stores nothing new. `options.now` sets the
 * clock (tests) and `options.fetch` replaces the network.
 */
export async function syncEcbRates(db: AppDb, options: RetryOptions = {}): Promise<EcbSyncStats> {
  const [stored] = await db.select({ latest: max(fxRates.date) }).from(fxRates);
  const latest = stored?.latest ?? null;
  const today = ecbDay(new Date((options.now ?? Date.now)()));
  const source = latest === null || daysBetween(latest, today) > STALE_AFTER_DAYS ? "hist-90d" : "daily";

  const rates = await fetchEcbRates(source === "daily" ? ECB_DAILY_URL : ECB_HIST_90D_URL, options);
  const { inserted, updated } = await storeRates(db, rates);

  const dates = [...new Set(rates.map((r) => r.date))].sort();
  const newest = dates.at(-1) ?? "";
  return {
    source,
    dates: dates.length,
    rows: rates.length,
    inserted,
    updated,
    latestDate: latest !== null && latest > newest ? latest : newest,
  };
}
