import "@/lib/load-env";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { closeDb, getDb } from "@/db";
import { formatNumber } from "@/lib/format";
import { findingLines, packageFileNames, prepareImport, type Finding } from "@/manufacturers/import";
import { outcomeText, storeImport } from "@/manufacturers/import-store";

// Usage: pnpm manufacturers --dir <package folder> --version 2.3 [--dry-run] [--force]
// Imports a version of the manufacturer pool the team builds outside the platform (SPEC 10, 8.1): the
// files are checked against the package's SHA256SUMS and the 48 columns, firms the KVKK guard finds
// personal data in are left out, and the rest is written in one transaction (src/manufacturers/). The same
// version with the same files writes nothing; --force writes it again after the import's rules changed.
// --dry-run reads the database to say what would change and writes nothing. The output is Turkish (the
// team runs this by hand) and names firms, places and rules, never a value.

const log = (message: string) => console.log(message);

const USAGE = "Kullanım: pnpm manufacturers --dir <paket klasörü> --version 2.3 [--dry-run] [--force]";
const SUMS = "SHA256SUMS.txt";
const MAX_ERRORS = 50;

function readArgs(): { dir: string; version: string; dryRun: boolean; force: boolean } | null {
  try {
    const { values } = parseArgs({
      options: {
        dir: { type: "string" },
        version: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
      },
    });
    if (!values.dir || !values.version) return null;
    return { dir: values.dir, version: values.version, dryRun: values["dry-run"], force: values.force };
  } catch {
    return null;
  }
}

function printFindings(rejected: readonly Finding[], review: readonly Finding[]) {
  const firms = (findings: readonly Finding[]) => new Set(findings.map((f) => f.manufacturerId)).size;
  if (rejected.length) {
    log(`KVKK nedeniyle yüklenmeyen ${formatNumber(firms(rejected))} firma (havuz dosyasında düzeltilmeli):`);
    for (const line of findingLines(rejected)) log(`  ${line}`);
  } else log("KVKK nedeniyle yüklenmeyen firma yok.");
  if (review.length) {
    log(`İncelenecek ${formatNumber(firms(review))} firma (yüklendi, bir kişi bakmalı):`);
    for (const line of findingLines(review)) log(`  ${line}`);
  }
}

async function main() {
  const args = readArgs();
  if (!args) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }
  let names: string[];
  try {
    names = readdirSync(args.dir);
  } catch {
    log(`Klasör okunamadı: ${args.dir}`);
    process.exitCode = 1;
    return;
  }
  const files = packageFileNames(names, args.version);
  if ("error" in files) {
    log(files.error);
    process.exitCode = 1;
    return;
  }
  if (!names.includes(SUMS)) {
    log(`Klasörde ${SUMS} yok; dosyalar denetlenemez.`);
    process.exitCode = 1;
    return;
  }

  log(`Paket: ${args.dir}, sürüm ${args.version}${args.dryRun ? " (deneme)" : ""}${args.force ? " (zorla)" : ""}`);
  const result = prepareImport({
    version: args.version,
    pool: { name: files.pool, bytes: readFileSync(join(args.dir, files.pool)) },
    sources: { name: files.sources, bytes: readFileSync(join(args.dir, files.sources)) },
    sha256Sums: readFileSync(join(args.dir, SUMS), "utf8"),
  });
  if (!result.ok) {
    log(`Paket yüklenemedi, hiçbir şey yazılmadı. ${formatNumber(result.errors.length)} hata:`);
    for (const error of result.errors.slice(0, MAX_ERRORS)) log(`  - ${error}`);
    if (result.errors.length > MAX_ERRORS) log(`  ... ve ${formatNumber(result.errors.length - MAX_ERRORS)} hata daha.`);
    // The guard may not have run (a file that does not read); then it has nothing to say.
    if (result.rejected.length || result.review.length) printFindings(result.rejected, result.review);
    process.exitCode = 1;
    return;
  }

  const { plan } = result;
  log(`Dosyalar SHA256SUMS ile aynı. Havuz: ${formatNumber(plan.poolRows)} firma, ${formatNumber(plan.sourceRows)} alan kaynağı satırı.`);
  printFindings(plan.rejected, plan.review);
  if (plan.notes.length) {
    log("İçe aktarmanın kendi verdiği kararlar:");
    for (const note of plan.notes) log(`  ${note.manufacturerId}: ${note.text}`);
  }
  log(`Yüklenecek: ${formatNumber(plan.manufacturers.length)} firma, ${formatNumber(plan.certifications.length)} belge, ${formatNumber(plan.sources.length)} alan kaynağı satırı.`);
  log(outcomeText(await storeImport(getDb(), plan, { dryRun: args.dryRun, force: args.force })));
}

main()
  .catch((error: unknown) => {
    console.error(`Hata: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
