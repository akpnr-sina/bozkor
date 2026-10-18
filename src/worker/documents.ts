import "@/lib/load-env";
import { parseArgs } from "node:util";
import { closeDb, getDb } from "@/db";
import { extractFile } from "@/documents/extract";
import { createCookieJar, createHostThrottle, fetchDocument } from "@/documents/fetch";
import { fetchDocuments, type FetchStats } from "@/documents/fetch-job";
import { createRobots, extractDocumentLinks } from "@/documents/portal";
import { processDocuments, type ProcessStats } from "@/documents/process-job";
import { FETCH_STATUS_LABELS, loadDocumentsStatus, portalHosts, recentLinks, type FetchStatus } from "@/documents/status";
import { createDocumentStorage, storageConfigured } from "@/documents/storage";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";

// Usage: pnpm documents --report [--limit=20] | --fetch [--limit=30] | --process [--limit=20]
// The documents stage by hand (SPEC Faz 5). --report shows where the links
// stand: documents per status, portal pages per site and the latest links
// tried, which the acceptance check goes through. --fetch and --process run
// one batch of the worker's fetch-documents and process-documents jobs.

const log = (message: string) => console.log(message);

const USAGE = "Kullanım: pnpm documents --report [--limit=20] | --fetch [--limit=30] | --process [--limit=20]   (limit: 1-1000)";
/** The report's length, and the worker's batch sizes (src/worker/jobs.ts). */
const DEFAULT_LIMITS = { report: 20, fetch: 30, process: 20 } as const;
type Mode = keyof typeof DEFAULT_LIMITS;

const STATUS_ORDER: FetchStatus[] = ["fetched", "needs_manual", "pending", "failed", "unsupported"];

const FETCH_STOPS: Record<NonNullable<FetchStats["stoppedBy"]>, string> = {
  storage: "Depo bir dosyayı kabul etmedi; sonrakiler de yazılamayacağı için çalıştırma durdu. Ayrıntılar yukarıda.",
  full: "Depo sınırı doldu; yeni dosya indirilmiyor.",
};
const PROCESS_STOPS: Record<NonNullable<ProcessStats["stoppedBy"]>, string> = {
  storage: "Depodan dosya okunamadı; çalıştırma durdu ve dosya yeniden denenecek. Ayrıntılar yukarıda.",
};

async function report(limit: number) {
  const db = getDb();
  const [status, hosts, links] = await Promise.all([loadDocumentsStatus(db, new Date()), portalHosts(db, limit), recentLinks(db, limit)]);
  log("Doküman durumu");
  for (const s of STATUS_ORDER) log(`  ${FETCH_STATUS_LABELS[s]}: ${formatNumber(status.byStatus[s])}`);
  log(`  Okunmayı bekleyen: ${formatNumber(status.unread)}, yeniden denenecek: ${formatNumber(status.retrying)}`);
  log(`  Depo: ${formatBytes(status.storedBytes)} / ${formatBytes(status.limitBytes)} sınır`);
  log("");
  log("Elle yüklenmesi gerekenler, siteye göre");
  if (!hosts.length) log("  Yok.");
  for (const h of hosts) log(`  ${h.host}: ${formatNumber(h.count)}`);
  log("");
  log(`Son denenen ${formatNumber(links.length)} link`);
  if (!links.length) log("  Henüz denenen link yok.");
  for (const link of links) {
    log(`  ${formatDateTime(link.at)} | ${FETCH_STATUS_LABELS[link.status]} | ${link.host}`);
    log(`    İhale: ${link.tenderTitle} (http://localhost:3000/tenders/${link.tenderId})`);
    log(`    Link: ${link.url}`);
    if (link.message) log(`    Not: ${link.message}`);
    if (link.retryAt) log(`    Yeniden deneme: ${formatDateTime(link.retryAt)}`);
  }
}

async function fetchBatch(limit: number) {
  // Both jobs claim each document first, so this can run beside the worker.
  log(`Doküman indirme: en fazla ${limit} link.`);
  const throttle = createHostThrottle();
  const robots = createRobots({ wait: (url) => throttle.wait(url) });
  const cookies = createCookieJar();
  const stats = await fetchDocuments(
    getDb(),
    {
      // The guard (terms and robots.txt) is asked before every request, redirects included.
      fetchDocument: (url, { guard, maxBytes }) => fetchDocument(url, { cookies, guard, maxBytes }),
      wait: (url) => throttle.wait(url),
      robots: (url) => robots.check(url),
      extractLinks: (html, pageUrl) => extractDocumentLinks(html, pageUrl),
      storage: createDocumentStorage(),
      log,
    },
    { limit },
  );
  log("");
  log("Bitti.");
  log(
    `  Denenen: ${stats.attempted}, indirilen: ${stats.fetched}, portal sayfası: ${stats.manual}, desteklenmeyen biçim: ${stats.unsupported}, ` +
      `indirilemeyen: ${stats.failed}, yeniden denenecek: ${stats.retry}, portal sayfalarından alınan: ${stats.pageFiles}, robots.txt engeli: ${stats.blocked}, kullanım şartları engeli: ${stats.forbidden}`,
  );
  if (stats.stoppedBy) log(`  ${FETCH_STOPS[stats.stoppedBy]}`);
  if (!stats.attempted && !stats.stoppedBy) log("  İndirilecek link yok.");
  if (stats.fetched) log("  İndirilen dosyaları okumak için: pnpm documents --process");
}

async function processBatch(limit: number) {
  log(`Doküman okuma: en fazla ${limit} dosya.`);
  const stats = await processDocuments(getDb(), { extract: (bytes, kind) => extractFile(bytes, kind), storage: createDocumentStorage(), log }, { limit });
  log("");
  log("Bitti.");
  log(
    `  Okunan: ${stats.processed}, ZIP'ten çıkan dosya: ${stats.members}, okunmayan tür ya da açılmayan ZIP: ${stats.skipped}, ` +
      `okunamayan: ${stats.failed}`,
  );
  if (stats.stoppedBy) log(`  ${PROCESS_STOPS[stats.stoppedBy]}`);
  if (!stats.processed && !stats.skipped && !stats.failed && !stats.stoppedBy) log("  Okunacak dosya yok.");
}

function readArgs(): { mode: Mode; limit: number } | null {
  let values;
  try {
    ({ values } = parseArgs({
      options: { report: { type: "boolean" }, fetch: { type: "boolean" }, process: { type: "boolean" }, limit: { type: "string" } },
    }));
  } catch {
    return null;
  }
  const modes = (Object.keys(DEFAULT_LIMITS) as Mode[]).filter((mode) => values[mode]);
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (modes.length !== 1 || (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 1000))) return null;
  const mode = modes[0]!;
  return { mode, limit: limit ?? DEFAULT_LIMITS[mode] };
}

async function main() {
  const args = readArgs();
  if (!args) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }
  if (args.mode === "report") return report(args.limit);
  if (!storageConfigured()) {
    log("Depo ayarları eksik: .env.local'de NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY ve SUPABASE_STORAGE_BUCKET tanımlı olmalı.");
    process.exitCode = 1;
    return;
  }
  return args.mode === "fetch" ? fetchBatch(args.limit) : processBatch(args.limit);
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
