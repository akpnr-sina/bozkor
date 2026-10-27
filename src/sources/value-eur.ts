import { and, gte, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "@/db";
import { tenders } from "@/db/schema";
import { ecbDay, loadRateTable, toEur, type RateTable } from "@/fx/rates";

/**
 * value_amount in EUR at the ECB rate of the publication day (or the closest
 * earlier working day). Tenders outside the stored rate range use the nearest
 * end of it rather than no value; currencies the ECB does not publish stay null.
 */
export function valueInEur(
  amount: number | null,
  currency: string | null,
  publishedAt: Date | null,
  table: RateTable,
): number | null {
  const exact = toEur(amount, currency, publishedAt, table);
  if (exact !== null || amount === null || !currency) return exact;
  const rates = table.get(currency.trim().toUpperCase());
  const oldest = rates?.[0];
  if (!oldest) return null;
  const beforeRange = publishedAt !== null && ecbDay(publishedAt) < oldest.date;
  return toEur(amount, currency, beforeRange ? new Date(`${oldest.date}T12:00:00Z`) : null, table);
}

export type ValueEurStats = {
  checked: number;
  updated: number;
  unconverted: number;
  /** Tenders whose EUR value changed: updated_at stays, so matching is told about them by id. */
  changedIds: string[];
};

const BATCH = 500;

/**
 * Fills tenders.value_eur. With `since`, only tenders upserted since then plus
 * those still without a EUR value are checked; without it, every tender is.
 * Writes only rows whose value changes and leaves updated_at alone.
 */
export async function fillValueEur(db: AppDb, options: { since?: Date } = {}): Promise<ValueEurStats> {
  const stats: ValueEurStats = { checked: 0, updated: 0, unconverted: 0, changedIds: [] };
  const needsValue = and(isNotNull(tenders.valueAmount), isNull(tenders.valueEur))!;
  // A correction that removes the amount must also clear the EUR value.
  const stale = and(isNull(tenders.valueAmount), isNotNull(tenders.valueEur))!;
  const where: SQL = options.since
    ? or(gte(tenders.updatedAt, options.since), needsValue, stale)!
    : or(isNotNull(tenders.valueAmount), stale)!;

  const rows = await db
    .select({
      id: tenders.id,
      valueAmount: tenders.valueAmount,
      valueCurrency: tenders.valueCurrency,
      publishedAt: tenders.publishedAt,
      valueEur: tenders.valueEur,
    })
    .from(tenders)
    .where(where);
  stats.checked = rows.length;
  if (!rows.length) return stats;

  const table = await loadRateTable(db);
  const changes: { id: string; valueEur: number | null }[] = [];
  for (const row of rows) {
    const valueEur = valueInEur(row.valueAmount, row.valueCurrency, row.publishedAt, table);
    if (valueEur === null && row.valueAmount !== null) stats.unconverted++;
    if (valueEur !== row.valueEur) changes.push({ id: row.id, valueEur });
  }

  for (let i = 0; i < changes.length; i += BATCH) {
    const values = sql.join(
      changes.slice(i, i + BATCH).map((c) => sql`(${c.id}::uuid, ${c.valueEur}::numeric)`),
      sql`, `,
    );
    await db.execute(
      sql`update ${tenders} set value_eur = v.value_eur from (values ${values}) as v(id, value_eur) where ${tenders.id} = v.id`,
    );
  }
  stats.updated = changes.length;
  stats.changedIds = changes.map((c) => c.id);
  return stats;
}
