import "@/lib/load-env";
import { parseArgs } from "node:util";
import { count, eq } from "drizzle-orm";
import { closeDb, getDb, type AppDb } from "@/db";
import { rawNotices, tenders } from "@/db/schema";
import { backfill } from "@/sources/sync";
import type { SourceAdapter, SourceId } from "@/sources/types";
import { createFatAdapter } from "@/sources/uk-fat";

// Usage: pnpm backfill --source=uk_fat --days=30
// Output is Turkish because the team runs this by hand.

const log = (message: string) => console.log(message);

const ADAPTERS: Partial<Record<SourceId, () => SourceAdapter>> = {
  uk_fat: () =>
    createFatAdapter({
      onRetry: ({ delayMs, reason }) => log(`    ${reason}: ${Math.round(delayMs / 1000)} sn bekleyip tekrar deneniyor`),
    }),
};

const dayFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "medium" });

async function totals(db: AppDb, source: SourceId) {
  const [tenderRow] = await db.select({ n: count() }).from(tenders).where(eq(tenders.source, source));
  const [rawRow] = await db.select({ n: count() }).from(rawNotices).where(eq(rawNotices.source, source));
  return { tenders: tenderRow?.n ?? 0, raw: rawRow?.n ?? 0 };
}

async function main() {
  const { values } = parseArgs({
    options: { source: { type: "string" }, days: { type: "string", default: "30" } },
  });
  const source = values.source as SourceId | undefined;
  const createAdapter = source ? ADAPTERS[source] : undefined;
  const days = Number(values.days);
  if (!source || !createAdapter || !Number.isInteger(days) || days < 1 || days > 365) {
    log("Kullanım: pnpm backfill --source=uk_fat --days=30   (gün: 1-365)");
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const before = await totals(db, source);
  log(`${source}: son ${days} gün yükleniyor.`);
  log("API bazen yavaş yanıt veriyor; 30 gün genelde 10-30 dakika, yoğun saatlerde daha uzun sürebilir.");
  log("Her sayfa için bir nokta, her gün için bir özet satırı yazılır. Bu sırada worker'ı kapalı tutun.");

  let page = 0;
  const stats = await backfill(db, createAdapter(), days, {
    log,
    onRecovered: (s) => log(`  Önceki yarım kalan çalıştırmadan ${s.procedures + s.skipped} ihale tamamlandı.`),
    onPage: () => {
      page++;
      process.stdout.write(".");
    },
    onWindow: (window, s) => {
      if (page) process.stdout.write("\n");
      page = 0;
      log(
        `  ${dayFormat.format(window.to)}: ${s.fetched} ilan tarandı, ${s.rawInserted} yeni ham kayıt, ` +
          `${s.inserted} yeni ihale, ${s.updated} güncellenen ihale`,
      );
    },
  });

  const after = await totals(db, source);
  log("");
  log("Bitti.");
  log(`  Yeni ihale: ${stats.inserted}`);
  log(`  Güncellenen ihale: ${stats.updated} (değişti olarak işaretlenen: ${stats.changed})`);
  log(`  İhale ilanı olmadığı için atlanan prosedür: ${stats.skipped} (sonuç bildirimleri, eski düzeltmeler)`);
  log(`  Toplam ihale: ${after.tenders} (öncesi: ${before.tenders})`);
  log(`  Toplam ham ilan: ${after.raw} (öncesi: ${before.raw})`);
  if (stats.normalizeErrors) log(`  Okunamayan ilan: ${stats.normalizeErrors} (ayrıntılar yukarıda)`);
}

main()
  .catch((error: unknown) => {
    console.error(`\nHata: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Aynı komutu tekrar çalıştırabilirsin: yarım kalan ihaleler tamamlanır, kopya kayıt oluşmaz.");
    process.exitCode = 1;
  })
  .finally(() => closeDb());
