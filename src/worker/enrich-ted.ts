import "@/lib/load-env";
import { closeDb, getDb } from "@/db";
import { createTedClient } from "@/sources/eu-ted/client";
import { enrichTedNotices } from "@/sources/eu-ted/enrich";

// Usage: pnpm enrich-ted
// Fetches the notices of the TED tenders the team sees (a current profile
// match or a decision) again with the fields added since they were stored,
// such as duration, award and selection criteria, and updates those tenders.
// Refetching every TED notice would only grow the raw store. Safe to repeat.
// Output is Turkish because the team runs this by hand.

const log = (message: string) => console.log(message);

async function main() {
  const db = getDb();
  const client = createTedClient({
    onRetry: ({ attempt, delayMs, reason }) => log(`  TED yanıt vermedi (${reason}); ${Math.round(delayMs / 1000)} sn sonra ${attempt + 1}. deneme.`),
  });
  log("Eşleşmesi ya da kararı olan TED ihalelerinin ilanları yeni alanlarla yeniden çekiliyor...");
  const stats = await enrichTedNotices(db, client, { log });
  log("");
  log("Bitti.");
  log(`  İhale: ${stats.tenders}, istenen ilan: ${stats.requested}, gelen: ${stats.fetched}`);
  log(`  Yeni ham kayıt: ${stats.rawInserted} (aynı içerik tekrar yazılmaz)`);
  log(`  Güncellenen ihale: ${stats.updated}${stats.normalizeErrors ? `, okunamayan ilan: ${stats.normalizeErrors}` : ""}`);
  if (stats.requested > stats.fetched) {
    log(`  ${stats.requested - stats.fetched} ilan TED'de bulunamadı; eski kayıtlarıyla kaldı.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
