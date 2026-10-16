import "@/lib/load-env";
import { parseArgs } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { factsModel, runFacts } from "@/analysis/facts";
import { createLlmClient } from "@/analysis/llm";
import type { RunStats } from "@/analysis/runner";
import { closeDb, getDb, type AppDb } from "@/db";
import { rawNotices, tenders } from "@/db/schema";
import { lotLabel } from "@/lib/format";
import type { ReadFacts } from "@/analysis/facts-evidence";
import { assessOne, assessTenders } from "@/policy/assess";
import { expectedScore } from "@/policy/engine";
import { STATUS_LABELS } from "@/policy/labels";

// Usage: pnpm facts [--limit=50] [--tender=<id>] [--notice=702149-2026,fat:096535-2026]
// Facts from the notices the team sees, or from the given tenders (done again
// even if they have facts), then the qualification policy's verdict. With
// --tender or --notice the verdict of each tender is printed. A manual run
// goes on past the monthly budget with a warning (CLAUDE.md rule 7).

const log = (message: string) => console.log(message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (n: number) => `${n.toFixed(4)} USD`;

const STOP_REASONS: Record<NonNullable<RunStats["stoppedBy"]>, string> = {
  budget: "Aylık bütçe doldu.",
  auth: "API anahtarı reddedildi; .env.local'deki ANTHROPIC_API_KEY'i ve Anthropic hesabının kredisini kontrol et.",
  credit: "Anthropic hesabının kredisi bitti; console.anthropic.com adresinde Plans & Billing bölümünden kredi yükle. Kredi yüklenince worker kendiliğinden devam eder.",
  errors: "Art arda API hataları geldi; çalıştırma durduruldu. Ayrıntılar yukarıda.",
};

const PREFIXES: Record<string, string> = { fat: "uk_fat", ted: "eu_ted" };

/**
 * Tenders of the given notice numbers, through any notice of the procedure.
 * Find a Tender and TED number notices alike ("096535-2026"), so "fat:" or
 * "ted:" picks the source; a bare number that both have is reported, not guessed.
 */
async function tendersOfNotices(db: AppDb, inputs: string[]): Promise<Map<string, string>> {
  const wanted = inputs.map((input) => {
    const [prefix, number] = input.includes(":") ? (input.split(":", 2) as [string, string]) : ["", input];
    return { input, number, source: PREFIXES[prefix.toLowerCase()] ?? null, badPrefix: prefix !== "" && !PREFIXES[prefix.toLowerCase()] };
  });
  const rows = await db
    .selectDistinct({ number: rawNotices.externalId, source: tenders.source, id: tenders.id })
    .from(rawNotices)
    .innerJoin(tenders, and(eq(tenders.source, rawNotices.source), eq(tenders.procedureKey, rawNotices.procedureKey)))
    .where(inArray(rawNotices.externalId, wanted.map((w) => w.number)));
  const result = new Map<string, string>();
  for (const w of wanted) {
    if (w.badPrefix) {
      log(`  ${w.input}: önek "fat:" ya da "ted:" olmalı.`);
      continue;
    }
    const matches = rows.filter((r) => r.number === w.number && (!w.source || r.source === w.source));
    const sources = new Set(matches.map((m) => m.source));
    if (matches.length === 1) result.set(w.input, matches[0]!.id);
    else if (!w.source && sources.size > 1) log(`  ${w.input}: hem Find a Tender'da hem TED'de var; fat:${w.number} ya da ted:${w.number} yaz.`);
    else if (matches.length > 1) log(`  ${w.input}: birden fazla ihaleye denk geliyor (${matches.map((m) => m.id).join(", ")}); --tender ile birini seç.`);
    else log(`  ${w.input}: veritabanında böyle bir ilan yok.`);
  }
  return result;
}

const CODE_TR: Record<string, string> = {
  REQUIRED: "zorunlu",
  NOT_REQUIRED: "yok",
  NONE: "yok",
  MINOR: "basit montaj",
  YES: "evet",
  NO: "hayır",
  UNKNOWN: "?",
  SINGLE: "tek",
  FEW: "birkaç",
  REPEATED: "tekrarlı",
};

/** The facts the decisions turn on, in one line; a stated fact whose quote was not found is marked. */
function factsLine(stored: ReadFacts): string {
  const { facts, quoteChecks } = stored;
  const mark = (key: keyof NonNullable<typeof quoteChecks>["facts"], known: boolean) =>
    known && !quoteChecks?.facts[key] ? " (doğrulanmadı)" : "";
  const item = (label: string, key: "installation" | "localService" | "commissioningTraining" | "deliveryPattern" | "pastPerformance" | "turnover") =>
    `${label} ${CODE_TR[facts[key].value] ?? facts[key].value}${mark(key, facts[key].value !== "UNKNOWN")}`;
  return [
    item("kurulum", "installation"),
    item("servis", "localService"),
    item("devreye alma", "commissioningTraining"),
    item("teslimat", "deliveryPattern"),
    item("referans", "pastPerformance"),
    item("ciro", "turnover"),
    `garanti ${facts.warranty.years ?? "?"}${mark("warranty", facts.warranty.years !== null)}`,
  ].join(", ");
}

async function printVerdict(db: AppDb, tenderId: string, label: string) {
  const [tender] = await db.select({ title: tenders.title }).from(tenders).where(eq(tenders.id, tenderId));
  const one = await assessOne(db, tenderId);
  log("");
  log(`${label}: ${tender?.title ?? tenderId}`);
  if (!one) {
    log("  Geçerli olgu yok; değerlendirilemedi.");
    return;
  }
  const { assessment, latest } = one;
  log(`  Detay: http://localhost:3000/tenders/${tenderId}`);
  log(`  Olgular: ${factsLine(latest.stored)}`);
  for (const lot of assessment.lots) {
    const name = assessment.lots.length > 1 ? `${lotLabel(lot.lotNumber)} ` : "";
    log(
      `  ${name}${STATUS_LABELS[lot.status]} | uyum ${expectedScore(lot.scores.fit)} (${lot.scores.fit.low}-${lot.scores.fit.high}), ` +
        `ön puan ${expectedScore(lot.scores.preliminary)}, güven %${lot.confidence}`,
    );
    log(`    ${lot.explanation}`);
    for (const action of lot.actions.slice(0, 3)) log(`    > ${action}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: { limit: { type: "string", default: "50" }, tender: { type: "string" }, notice: { type: "string" } },
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || (values.tender && !UUID.test(values.tender))) {
    log("Kullanım: pnpm facts [--limit=50] [--tender=<ihale id>] [--notice=<ilan no>,ted:<ilan no>,fat:<ilan no>]   (limit: 1-1000)");
    process.exitCode = 1;
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log("ANTHROPIC_API_KEY tanımlı değil (.env.local).");
    process.exitCode = 1;
    return;
  }
  const db = getDb();

  const chosen = new Map<string, string>();
  if (values.tender) chosen.set(values.tender, values.tender);
  if (values.notice) {
    const numbers = values.notice.split(",").map((n) => n.trim()).filter(Boolean);
    const found = await tendersOfNotices(db, numbers);
    for (const [number, id] of found) chosen.set(id, number);
    if (!chosen.size) {
      process.exitCode = 1;
      return;
    }
  }
  const tenderIds = chosen.size ? [...chosen.keys()] : undefined;

  log(`Olgu çıkarma: model ${factsModel()}, ${tenderIds ? `${tenderIds.length} ihale` : `en fazla ${limit} ihale`}.`);
  const stats = await runFacts(db, createLlmClient(), {
    limit,
    manual: true,
    tenderIds,
    log,
    onProgress: (s, total) => {
      if (s.attempted % 10 === 0 || s.attempted === total) {
        log(`  ${s.attempted} / ${total}: ${s.valid} geçerli, ${s.invalid} geçersiz, ${s.apiErrors} API hatası, ${usd(s.costUsd)}`);
      }
    },
  });
  const assessed = await assessTenders(db, { tenderIds, log });
  log("");
  log("Bitti.");
  log(`  Denenen: ${stats.attempted}, geçerli: ${stats.valid}, geçersiz (bir kez tekrar denendi): ${stats.invalid}, API hatası: ${stats.apiErrors}`);
  log(`  Maliyet: ${usd(stats.costUsd)}. Bu ay toplam: ${usd(stats.spentBeforeUsd + stats.costUsd)} / ${stats.budgetUsd} USD bütçe`);
  log(`  Değerlendirilen ihale: ${assessed.assessed}, değişen: ${assessed.changed}`);
  if (stats.stoppedBy) log(`  ${STOP_REASONS[stats.stoppedBy]}`);
  if (!stats.attempted && !stats.stoppedBy) log("  Olgusu çıkarılacak ihale yok.");
  for (const [id, label] of chosen) await printVerdict(db, id, label);
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
