import "@/lib/load-env";
import { parseArgs } from "node:util";
import { createLlmClient } from "@/analysis/llm";
import { matchesOfTender, runTriage, triageModel, type TriageRunStats } from "@/analysis/triage";
import { closeDb, getDb } from "@/db";

// Usage: pnpm triage [--limit=50] [--tender=<id>]
// AI pre-assessment of pending matches, or of every current match of one
// tender. A manual run goes on past the monthly budget with a warning
// (CLAUDE.md rule 7); the worker's automatic runs stop there.

const log = (message: string) => console.log(message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (n: number) => `${n.toFixed(4)} USD`;

const STOP_REASONS: Record<NonNullable<TriageRunStats["stoppedBy"]>, string> = {
  budget: "Aylık bütçe doldu.",
  auth: "API anahtarı reddedildi; .env.local'deki ANTHROPIC_API_KEY'i ve Anthropic hesabının kredisini kontrol et.",
  credit: "Anthropic hesabının kredisi bitti; console.anthropic.com adresinde Plans & Billing bölümünden kredi yükle. Kredi yüklenince worker kendiliğinden devam eder.",
  errors: "Art arda API hataları geldi; çalıştırma durduruldu. Ayrıntılar yukarıda.",
};

async function main() {
  const { values } = parseArgs({ options: { limit: { type: "string", default: "50" }, tender: { type: "string" } } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (values.tender && !UUID.test(values.tender))) {
    log("Kullanım: pnpm triage [--limit=50] [--tender=<ihale id>]   (limit: 1-1000)");
    process.exitCode = 1;
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY tanımlı değil (.env.local).");
    process.exitCode = 1;
    return;
  }

  const db = getDb();
  const keys = values.tender ? await matchesOfTender(db, values.tender) : undefined;
  if (keys && !keys.length) {
    log("Bu ihalenin güncel bir profil eşleşmesi yok.");
    return;
  }
  log(`Triage: model ${triageModel()}, ${keys ? `ihalenin ${keys.length} eşleşmesi` : `en fazla ${limit} bekleyen eşleşme`}.`);
  const stats = await runTriage(db, createLlmClient(), {
    limit,
    manual: true,
    keys,
    log,
    onProgress: (s, total) => {
      if (s.attempted % 10 === 0 || s.attempted === total) {
        log(`  ${s.attempted} / ${total}: ${s.valid} geçerli, ${s.invalid} geçersiz, ${s.apiErrors} API hatası, ${usd(s.costUsd)}`);
      }
    },
  });
  log("");
  log("Bitti.");
  log(`  Denenen: ${stats.attempted}, geçerli: ${stats.valid}, geçersiz (bir kez tekrar denendi): ${stats.invalid}, API hatası: ${stats.apiErrors}`);
  log(`  Maliyet: ${usd(stats.costUsd)}. Bu ay toplam: ${usd(stats.spentBeforeUsd + stats.costUsd)} / ${stats.budgetUsd} USD bütçe`);
  if (stats.stoppedBy) log(`  ${STOP_REASONS[stats.stoppedBy]}`);
  if (!stats.attempted && !stats.stoppedBy) log("  Bekleyen eşleşme yok.");
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
