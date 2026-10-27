// Writes cpv-2008.json, the CPV 2008 vocabulary with its English names, from
// the Publications Office's SPARQL API (source.ts):
//   pnpm exec tsx src/matching/cpv/build.ts
// or from a CSV of the same query saved before (code,label with a header):
//   pnpm exec tsx src/matching/cpv/build.ts --from-csv <path>
// A development step run by hand when the vocabulary changes; the app and the
// tests read the JSON and never the network.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchText, USER_AGENT } from "@/sources/http";
import { CPV_PAGE_SIZE, cpvJson, cpvProblems, cpvQueryUrl, cpvRowsOf, type CpvRow } from "./source";

async function fromSparql(): Promise<CpvRow[]> {
  const rows: CpvRow[] = [];
  // Page by page, one request at a time; fetchText waits out a 429's Retry-After (CLAUDE.md rule 1).
  for (let offset = 0; ; offset += CPV_PAGE_SIZE) {
    const page = cpvRowsOf(await fetchText(cpvQueryUrl(offset), { headers: { "User-Agent": USER_AGENT, Accept: "text/csv" } }));
    rows.push(...page);
    console.log(`[cpv] ${rows.length} codes read`);
    if (page.length < CPV_PAGE_SIZE) return rows;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--from-csv");
  const path = at >= 0 ? args[at + 1] : undefined;
  if (at >= 0 && !path) throw new Error("--from-csv needs the path of a CSV file");
  const rows = path ? cpvRowsOf(readFileSync(path, "utf8")) : await fromSparql();

  const problems = cpvProblems(rows);
  if (problems.length) throw new Error(`The vocabulary did not pass its checks:\n${problems.slice(0, 20).join("\n")}`);
  const out = new URL("./cpv-2008.json", import.meta.url);
  writeFileSync(out, cpvJson(rows));
  console.log(`[cpv] ${rows.length} codes written to ${fileURLToPath(out)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
