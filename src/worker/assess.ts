import "@/lib/load-env";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { bidWindow } from "@/analysis/rubric";
import { closeDb, getDb, type AppDb } from "@/db";
import { tenderAssessments, tenders } from "@/db/schema";
import { assessTenders, type AssessStats } from "@/policy/assess";
import { STATUSES, type Status } from "@/policy/engine";
import { GATE_LABELS, STATUS_LABELS } from "@/policy/labels";
import { POLICY } from "@/policy/policy";

// Usage: pnpm assess [--dry-run] [--report]
// Applies the qualification policy to every tender with facts, as the worker
// does once a day. With --dry-run nothing is written: it shows how many
// verdicts would change, e.g. after editing src/policy/policy.ts. --report
// writes nothing either: it summarises the stored verdicts for calibration,
// with why tenders are rejected and how the partner lead time weighs.

const log = (message: string) => console.log(message);

function logByStatus(byStatus: Partial<Record<Status, number>>) {
  for (const status of STATUSES) {
    const count = byStatus[status];
    if (count) log(`  ${STATUS_LABELS[status]}: ${count}`);
  }
}

async function report(db: AppDb) {
  const rows = await db
    .select({
      status: tenderAssessments.status,
      blocking: tenderAssessments.blocking,
      explanation: tenderAssessments.explanation,
      title: tenders.title,
      externalId: tenders.externalId,
      deadline: tenders.submissionDeadline,
    })
    .from(tenderAssessments)
    .innerJoin(tenders, eq(tenders.id, tenderAssessments.tenderId))
    .orderBy(sql`random()`);
  const now = new Date();
  const byStatus: Partial<Record<Status, number>> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  log(`Kayıtlı kararlar, politika ${POLICY.version}: ${rows.length} ihale`);
  logByStatus(byStatus);

  const noBid = rows.filter((r) => r.status === "NO_BID");
  if (noBid.length) {
    const h03 = noBid.filter((r) => r.blocking.includes("H03")).length;
    const h05 = noBid.filter((r) => r.blocking.includes("H05")).length;
    const both = noBid.filter((r) => r.blocking.includes("H03") && r.blocking.includes("H05")).length;
    log("");
    log(`${STATUS_LABELS.NO_BID} nedenleri:`);
    log(`  H05 ${GATE_LABELS.H05} (zorunlu kurulum ya da servis, ortak yok, süre yetmiyor): ${h05}`);
    log(`  H03 ${GATE_LABELS.H03} (referans ya da istekli belgesi, süre yetmiyor): ${h03}`);
    if (both) log(`  İkisi birden: ${both}`);
    const buckets = { "0": 0, "1-2": 0, "3-5": 0, "6-9": 0, "10+ ya da bilinmiyor": 0 };
    for (const row of noBid) {
      const days = bidWindow(row.deadline, now).workingDays;
      if (days === null || days >= 10) buckets["10+ ya da bilinmiyor"]++;
      else if (days === 0) buckets["0"]++;
      else if (days <= 2) buckets["1-2"]++;
      else if (days <= 5) buckets["3-5"]++;
      else buckets["6-9"]++;
    }
    log(`  Son tarihe kalan iş günü: ${Object.entries(buckets).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }

  // How much the partner lead time decides: the same facts under shorter ones, nothing written.
  for (const days of [5, 3]) {
    const whatIf: AssessStats = await assessTenders(db, { dryRun: true, policy: { ...POLICY, partnerLeadWorkingDays: days }, log: () => {} });
    log("");
    log(`Ortak bulma süresi ${days} iş günü olsaydı (şu an ${POLICY.partnerLeadWorkingDays}):`);
    logByStatus(whatIf.byStatus);
  }

  for (const status of ["NO_BID", "COMMERCIAL_NO_BID", "NEEDS_DOCUMENTS"] as const) {
    const sample = rows.filter((r) => r.status === status).slice(0, status === "NEEDS_DOCUMENTS" ? 3 : 8);
    if (!sample.length) continue;
    log("");
    log(`Rastgele "${STATUS_LABELS[status]}" örnekleri:`);
    for (const row of sample) {
      log(`  - ${row.title.slice(0, 100)} [${row.externalId}]`);
      log(`    ${row.explanation}`);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: { "dry-run": { type: "boolean", default: false }, report: { type: "boolean", default: false } },
  });
  const db = getDb();
  if (values.report) {
    await report(db);
    return;
  }
  const dryRun = values["dry-run"];
  const stats = await assessTenders(db, { dryRun, log });
  log(`Politika ${POLICY.version}${dryRun ? " (deneme, hiçbir şey yazılmadı)" : ""}`);
  log(`  Değerlendirilen ihale: ${stats.assessed}, değişen: ${stats.changed}, durumu değişen: ${stats.statusChanged}`);
  if (stats.errors) log(`  Değerlendirilemeyen ihale: ${stats.errors} (ayrıntılar yukarıda)`);
  if (stats.removed) log(`  Olgusu artık okunamayan ihale: ${stats.removed} (kararları kaldırıldı; olgular yeniden çıkarılınca döner)`);
  logByStatus(stats.byStatus);
  if (!stats.assessed) log("  Olgusu çıkarılmış ihale yok; önce pnpm facts çalıştır.");
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
