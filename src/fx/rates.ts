import { gte, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { fxRates } from "@/db/schema";
import { toZonedLocal } from "@/lib/time";
import type { EcbRate } from "./ecb";

/** ECB reference dates follow the Frankfurt calendar. */
export const ECB_TIMEZONE = "Europe/Berlin";

/**
 * How far back toEur looks for a rate. The ECB publishes none on weekends
 * and TARGET holidays, so a day often has to borrow an earlier day's rate.
 */
export const MAX_LOOKBACK_DAYS = 10;

const DAY_MS = 86_400_000;

/** ECB reference day (YYYY-MM-DD) that `instant` falls on. */
export function ecbDay(instant: Date): string {
  return toZonedLocal(instant, ECB_TIMEZONE).slice(0, 10);
}

/** Whole calendar days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function addDays(day: string, days: number): string {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  // The round trip rejects impossible dates such as 2026-02-31.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new Error(`Expected a YYYY-MM-DD date, got ${JSON.stringify(day)}`);
  }
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

export type DatedRate = { date: string; ratePerEur: number };

/** Rates in memory, per currency, oldest first. */
export type RateTable = ReadonlyMap<string, readonly DatedRate[]>;

/** Groups rates by currency and sorts them by date; a repeated (date, currency) keeps the last rate. */
export function buildRateTable(rates: Iterable<EcbRate>): RateTable {
  const byCurrency = new Map<string, Map<string, number>>();
  for (const { date, currency, ratePerEur } of rates) {
    const code = currency.toUpperCase();
    let byDate = byCurrency.get(code);
    if (!byDate) byCurrency.set(code, (byDate = new Map()));
    byDate.set(date, ratePerEur);
  }
  return new Map(
    [...byCurrency].map(([code, byDate]) => [
      code,
      [...byDate]
        .map(([date, ratePerEur]) => ({ date, ratePerEur }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    ]),
  );
}

/** The rate of `day`, or of the closest earlier day within MAX_LOOKBACK_DAYS. */
function rateOn(rates: readonly DatedRate[], day: string): DatedRate | undefined {
  // Binary search for the last rate dated on or before `day`.
  let lo = 0;
  let hi = rates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const candidate = rates[mid];
    if (candidate && candidate.date <= day) lo = mid + 1;
    else hi = mid;
  }
  const rate = rates[lo - 1];
  return rate && daysBetween(rate.date, day) <= MAX_LOOKBACK_DAYS ? rate : undefined;
}

/**
 * Converts an amount to EUR at the ECB rate of `date`'s day, or of the
 * closest earlier working day within MAX_LOOKBACK_DAYS; a null date uses the
 * newest rate. EUR amounts come back unchanged, others rounded to cents.
 * Returns null when the amount, the currency or a usable rate is missing,
 * for example for AED, which the ECB does not publish.
 */
export function toEur(
  amount: number | null,
  currency: string | null,
  date: Date | null,
  table: RateTable,
): number | null {
  if (amount === null || !Number.isFinite(amount) || !currency) return null;
  const code = currency.trim().toUpperCase();
  if (code === "EUR") return amount;

  const rates = table.get(code);
  if (!rates?.length) return null;
  let rate: DatedRate | undefined;
  if (date === null) rate = rates.at(-1);
  else if (!Number.isNaN(date.getTime())) rate = rateOn(rates, ecbDay(date));
  return rate ? Math.round((amount / rate.ratePerEur) * 100) / 100 : null;
}

// 3 parameters per row; Postgres allows 65535 per statement.
const UPSERT_BATCH = 1_000;

/**
 * Upserts rates by (date, currency). Storing the same rates again writes
 * nothing; a rate the ECB corrected replaces the stored one.
 */
export async function storeRates(
  db: AppDb,
  rates: readonly EcbRate[],
): Promise<{ inserted: number; updated: number }> {
  // Postgres rejects an upsert that touches the same row twice.
  const unique = [...new Map(rates.map((r) => [`${r.date}|${r.currency}`, r])).values()];
  const result = { inserted: 0, updated: 0 };
  if (!unique.length) return result;

  await db.transaction(async (tx) => {
    for (let i = 0; i < unique.length; i += UPSERT_BATCH) {
      const written = await tx
        .insert(fxRates)
        .values(unique.slice(i, i + UPSERT_BATCH))
        .onConflictDoUpdate({
          target: [fxRates.date, fxRates.currency],
          set: { ratePerEur: sql`excluded.rate_per_eur`, fetchedAt: sql`now()` },
          setWhere: sql`${fxRates.ratePerEur} is distinct from excluded.rate_per_eur`,
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const row of written) {
        if (row.inserted) result.inserted++;
        else result.updated++;
      }
    }
  });
  return result;
}

/**
 * Loads stored rates for toEur. With `since` (YYYY-MM-DD), rates from
 * MAX_LOOKBACK_DAYS earlier are included too, so a weekend or holiday right
 * at `since` still finds the previous working day's rate.
 */
export async function loadRateTable(db: AppDb, since?: string): Promise<RateTable> {
  const rows = await db
    .select({ date: fxRates.date, currency: fxRates.currency, ratePerEur: fxRates.ratePerEur })
    .from(fxRates)
    .where(since === undefined ? undefined : gte(fxRates.date, addDays(since, -MAX_LOOKBACK_DAYS)));
  return buildRateTable(rows);
}
