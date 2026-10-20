import "@/lib/load-env";
import { parseArgs } from "node:util";
import { desc, eq } from "drizzle-orm";
import { analyzeTenderDeep, deepModel, loadDeepPrompts, runDeepRequests } from "@/analysis/deep";
import { readStoredDeep, type DeepClaim } from "@/analysis/deep-schema";
import { loadDeepView } from "@/analysis/deep-view";
import { createLlmClient } from "@/analysis/llm";
import { monthlyLlmSpend } from "@/analysis/budget";
import { closeDb, getDb } from "@/db";
import { analyses, tenders } from "@/db/schema";
import { createDocumentStorage, storageConfigured } from "@/documents/storage";
import { formatDateTime } from "@/lib/format";

// Usage: pnpm deep --tender=<id> | --queue [--limit=2] | --report [--limit=20]
// The deep analysis by hand (SPEC 7.2, Faz 6). --tender analyses one tender
// now (past the monthly budget too, with a warning: CLAUDE.md rule 7) and
// prints what the acceptance check looks at: the turnover requirement, the
// origin restriction and the deadline, each with its source. --queue runs the
// worker's deep-analysis job once; --report lists the latest analyses.

const log = (message: string) => console.log(message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = "Kullanım: pnpm deep --tender=<id> | --queue [--limit=2] | --report [--limit=20]";
const usd = (n: number) => `${n.toFixed(4)} USD`;

function claimLine(label: string, claim: DeepClaim, check: string | null | undefined, files: { n: number; name: string }[]): string {
  if (!claim.value) return `  ${label}: dokümanlarda yok`;
  const source =
    check === undefined || check === null
      ? "doğrulanmadı"
      : check.startsWith("file:")
        ? (() => {
            const [, n, page] = check.split(":");
            const name = files.find((f) => f.n === Number(n))?.name ?? `dosya ${n}`;
            return page ? `${name}, sayfa ${page.slice(1)}` : name;
          })()
        : "ilan metni";
  return `  ${label}: ${claim.value} [${source}]`;
}

async function analyseOne(tenderId: string) {
  const db = getDb();
  const [tender] = await db.select({ title: tenders.title }).from(tenders).where(eq(tenders.id, tenderId));
  if (!tender) {
    log("İhale bulunamadı.");
    process.exitCode = 1;
    return;
  }
  const budget = await monthlyLlmSpend(db);
  if (budget.exceeded) log(`Uyarı: aylık LLM bütçesi (${budget.budgetUsd} USD) doldu; elle başlatıldığı için devam ediliyor.`);
  log(`Derin analiz: ${tender.title}`);
  const outcome = await analyzeTenderDeep(db, { llm: createLlmClient(), storage: createDocumentStorage(), log }, tenderId, {
    model: deepModel(),
    prompts: loadDeepPrompts(),
  });
  if (outcome.status !== "valid") {
    log(`Analiz tamamlanamadı: ${outcome.error} (maliyet ${usd(outcome.costUsd)})`);
    process.exitCode = 1;
    return;
  }
  const view = await loadDeepView(db, tenderId);
  const result = view.result!;
  const { output, quoteChecks: checks } = result;
  log(`Bitti: ${outcome.parts} parça, maliyet ${usd(outcome.costUsd)}.`);
  log("");
  log(output.summaryTr);
  log("");
  log("Kabul kontrolü");
  log(claimLine("Asgari ciro", output.eligibility.minTurnover, checks["eligibility.minTurnover"], result.files));
  log(claimLine("Ürün menşei", output.eligibility.productOrigin, checks["eligibility.productOrigin"], result.files));
  log(claimLine("Tedarikçi yeri", output.eligibility.supplierLocation, checks["eligibility.supplierLocation"], result.files));
  log(claimLine("Teklif son tarihi", output.timeline.submissionDeadline, checks["timeline.submissionDeadline"], result.files));
  const quotes = Object.values(checks);
  log(`Alıntılar: ${quotes.filter(Boolean).length}/${quotes.length} doğrulandı.`);
  if (output.missingInfo.length) log(`Eksik bilgiler: ${output.missingInfo.join("; ")}`);
  if (result.skipped.length) log(`Alınmayan dosyalar: ${result.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}`);
  log(`AI önerisi: ${output.suggestedDecision.decision}: ${output.suggestedDecision.reasons.join("; ")}`);
  log(`Sayfa: http://localhost:3000/tenders/${tenderId}`);
}

async function runQueue(limit: number) {
  const stats = await runDeepRequests(getDb(), { llm: createLlmClient(), storage: createDocumentStorage(), log }, { limit });
  log(`Bitti. Analiz edilen: ${stats.analysed}, tamamlanamayan: ${stats.failed}, maliyet: ${usd(stats.costUsd)}${stats.stoppedBy ? `, durdu: ${stats.stoppedBy}` : ""}.`);
}

async function report(limit: number) {
  const rows = await getDb()
    .select({ tenderId: analyses.tenderId, title: tenders.title, createdAt: analyses.createdAt, valid: analyses.valid, output: analyses.output, costUsd: analyses.costUsd, error: analyses.error, promptVersion: analyses.promptVersion })
    .from(analyses)
    .innerJoin(tenders, eq(tenders.id, analyses.tenderId))
    .where(eq(analyses.kind, "deep"))
    .orderBy(desc(analyses.createdAt))
    .limit(limit);
  if (!rows.length) log("Henüz derin analiz yok.");
  for (const row of rows) {
    const stored = readStoredDeep(row.output);
    const quotes = stored ? Object.values(stored.quoteChecks) : [];
    const what = stored
      ? `sonuç, ${stored.parts} parça, alıntı ${quotes.filter(Boolean).length}/${quotes.length}, öneri ${stored.output.suggestedDecision.decision}`
      : row.valid
        ? `parça (${row.promptVersion})`
        : `geçersiz: ${row.error ?? "?"}`;
    log(`${formatDateTime(row.createdAt)} | ${usd(row.costUsd)} | ${row.title.slice(0, 60)} | ${what}`);
  }
}

function readArgs() {
  try {
    const { values } = parseArgs({ options: { tender: { type: "string" }, queue: { type: "boolean" }, report: { type: "boolean" }, limit: { type: "string" } } });
    const modes = [values.tender !== undefined, values.queue === true, values.report === true].filter(Boolean).length;
    const limit = values.limit === undefined ? null : Number(values.limit);
    if (modes !== 1 || (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100))) return null;
    if (values.tender !== undefined && !UUID.test(values.tender)) return null;
    return { tender: values.tender, queue: values.queue === true, limit };
  } catch {
    return null;
  }
}

async function main() {
  const args = readArgs();
  if (!args) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!args.tender && !args.queue) return report(args.limit ?? 20);
  if (!storageConfigured()) {
    log("Depo ayarları eksik: .env.local'de NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY ve SUPABASE_STORAGE_BUCKET tanımlı olmalı.");
    process.exitCode = 1;
    return;
  }
  return args.tender ? analyseOne(args.tender) : runQueue(args.limit ?? 2);
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
