import "@/lib/load-env";
import { parseArgs } from "node:util";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { rawNotices } from "@/db/schema";
import { applyProcedures, emptyApplyStats } from "@/sources/store";
import type { SourceAdapter, SourceId } from "@/sources/types";
import { createFatAdapter } from "@/sources/uk-fat";

// Usage: pnpm renormalize --source=uk_fat
// Rebuilds every tender of a source from stored raw notices, without calling
// the API. Run it after changing a normalizer or the fold rules.

const log = (message: string) => console.log(message);

const ADAPTERS: Partial<Record<SourceId, () => SourceAdapter>> = { uk_fat: () => createFatAdapter() };

const BATCH = 200;

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" } } });
  const source = values.source as SourceId | undefined;
  const createAdapter = source ? ADAPTERS[source] : undefined;
  if (!source || !createAdapter) {
    log("Kullanım: pnpm renormalize --source=uk_fat");
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const adapter = createAdapter();
  const keys = (
    await db
      .selectDistinct({ procedureKey: rawNotices.procedureKey })
      .from(rawNotices)
      .where(and(eq(rawNotices.source, source), isNotNull(rawNotices.procedureKey)))
      .orderBy(asc(rawNotices.procedureKey))
  ).map((row) => row.procedureKey as string);

  log(`${source}: ${keys.length} ihale ham veriden yeniden hesaplanıyor.`);
  // Re-folding is not a new notice, so nothing gets marked as changed.
  const runStartedAt = new Date(0);
  const total = emptyApplyStats();
  for (let i = 0; i < keys.length; i += BATCH) {
    const stats = await applyProcedures(db, source, keys.slice(i, i + BATCH), adapter.normalize, runStartedAt, log);
    total.procedures += stats.procedures;
    total.inserted += stats.inserted;
    total.updated += stats.updated;
    total.skipped += stats.skipped;
    total.normalizeErrors += stats.normalizeErrors;
    log(`  ${Math.min(i + BATCH, keys.length)} / ${keys.length}`);
  }
  log(
    `Bitti. Güncellenen: ${total.updated}, yeni: ${total.inserted}, ` +
      `ihale ilanı olmadığı için atlanan: ${total.skipped}, okunamayan ilan: ${total.normalizeErrors}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
