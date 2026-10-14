import "@/lib/load-env";
import { parseArgs } from "node:util";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { closeDb, getDb } from "@/db";
import { rawNotices } from "@/db/schema";
import { rematch } from "@/matching/apply";
import { createTedAdapter } from "@/sources/eu-ted";
import { addStats, emptySyncStats } from "@/sources/sync";
import { applyProcedures, scopeReport } from "@/sources/store";
import type { SourceAdapter, SourceId } from "@/sources/types";
import { createFatAdapter } from "@/sources/uk-fat";
import { fillValueEur } from "@/sources/value-eur";

// Usage: pnpm renormalize --source=uk_fat [--dry-run]  (or --source=eu_ted)
// Rebuilds every tender of a source from stored raw notices, without calling
// the API. Run it after changing a normalizer, the fold rules or the scope
// rule. --dry-run only reports what a real run would delete or keep.

const log = (message: string) => console.log(message);

const ADAPTERS: Record<SourceId, () => SourceAdapter> = {
  uk_fat: () => createFatAdapter(),
  eu_ted: () => createTedAdapter(),
};

const BATCH = 200;

async function main() {
  const { values } = parseArgs({ options: { source: { type: "string" }, "dry-run": { type: "boolean", default: false } } });
  const source = values.source && Object.hasOwn(ADAPTERS, values.source) ? (values.source as SourceId) : undefined;
  const createAdapter = source ? ADAPTERS[source] : undefined;
  if (!source || !createAdapter) {
    log("Kullanım: pnpm renormalize --source=uk_fat [--dry-run]   (kaynak: uk_fat ya da eu_ted)");
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

  if (values["dry-run"]) {
    log(`${source}: ${keys.length} prosedür kontrol ediliyor. Veritabanına bir şey yazılmayacak.`);
    const total = { wouldRemove: 0, wouldRemoveMatched: 0, wouldKeep: 0, wouldKeepMatched: 0, outOfScopeAbsent: 0, normalizeErrors: 0 };
    for (let i = 0; i < keys.length; i += BATCH) {
      const part = await scopeReport(db, source, keys.slice(i, i + BATCH), adapter.normalize, log);
      total.wouldRemove += part.wouldRemove;
      total.wouldRemoveMatched += part.wouldRemoveMatched;
      total.wouldKeep += part.wouldKeep;
      total.wouldKeepMatched += part.wouldKeepMatched;
      total.outOfScopeAbsent += part.outOfScopeAbsent;
      total.normalizeErrors += part.normalizeErrors;
      log(`  ${Math.min(i + BATCH, keys.length)} / ${keys.length}`);
    }
    log("Deneme bitti. Gerçek çalıştırmada:");
    log(`  Silinecek kapsam dışı ihale (hizmet, yapım, yazılım): ${total.wouldRemove} (bir profille eşleşmiş olan: ${total.wouldRemoveMatched})`);
    log(
      `  Kapsam dışı ama kararı, analizi ya da dokümanı olduğu için kalacak: ${total.wouldKeep}` +
        ` (profil eşleşmesi bitecek olan: ${total.wouldKeepMatched}; GO, REVIEW ya da WATCH kararlılar gelen kutusunda kalır)`,
    );
    log(`  Zaten ihalesi olmayan kapsam dışı prosedür: ${total.outOfScopeAbsent}`);
    if (total.normalizeErrors) log(`  Okunamayan ilan: ${total.normalizeErrors} (ayrıntılar yukarıda)`);
    return;
  }

  log(`${source}: ${keys.length} ihale ham veriden yeniden hesaplanıyor.`);
  // Re-folding is not a new notice, so nothing gets marked as changed.
  const runStartedAt = new Date(0);
  let total = emptySyncStats();
  for (let i = 0; i < keys.length; i += BATCH) {
    const stats = await applyProcedures(db, source, keys.slice(i, i + BATCH), adapter.normalize, runStartedAt, log);
    total = addStats(total, { ...stats, fetched: 0, rawInserted: 0 });
    log(`  ${Math.min(i + BATCH, keys.length)} / ${keys.length}`);
  }
  const value = await fillValueEur(db);
  const match = await rematch(db, { log });
  log(
    `Bitti. Güncellenen: ${total.updated}, yeni: ${total.inserted}, ` +
      `ihale ilanı olmadığı için atlanan: ${total.skipped}, okunamayan ilan: ${total.normalizeErrors}`,
  );
  log(`Kapsam dışı (hizmet, yapım, yazılım): ${total.outOfScope}, silinen ihale: ${total.removed}`);
  if (total.outOfScopeKept) log(`Kapsam dışı ama kararı, analizi ya da dokümanı olduğu için tutulan: ${total.outOfScopeKept}`);
  log(`Euro değeri güncellenen: ${value.updated}. Eşleşme: ${match.matched} (${match.created} yeni, ${match.unmatched} artık eşleşmeyen).`);
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
