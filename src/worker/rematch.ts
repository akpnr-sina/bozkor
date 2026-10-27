import "@/lib/load-env";
import { closeDb, getDb } from "@/db";
import { rematch } from "@/matching/apply";
import { fillValueEur } from "@/sources/value-eur";

// Usage: pnpm rematch
// Judges every open tender against the active profiles again. Run it after
// changing the matching code (src/matching/): syncs only judge the tenders
// they write, and a profile edit only that profile. Reads every open tender
// with its lots, about 30 MB of the Supabase egress quota (CLAUDE.md, "Veri çıkışı").

const log = (message: string) => console.log(message);

async function main() {
  const db = getDb();
  const value = await fillValueEur(db);
  const match = await rematch(db, { log });
  log(`Euro değeri güncellenen: ${value.updated}. Açık ihale: ${match.tenders}, profil: ${match.profiles}.`);
  log(`Eşleşme: ${match.matched} (${match.created} yeni, ${match.unmatched} artık eşleşmeyen).`);
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
