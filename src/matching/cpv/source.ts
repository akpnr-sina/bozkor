// Where the CPV 2008 vocabulary (Regulation (EC) No 213/2008) comes from, and
// how its rows are read and checked before cpv-2008.json is written
// (build.ts). The Publications Office of the EU publishes it through its
// SPARQL API, which needs no key; a code's notation is its eight digits
// without the check digit. (TED's ZIP of the vocabulary answers a bot check
// instead of the file, which rule 1 does not get past.)

export const CPV_SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
/** The regulation's vocabulary has this many codes. */
export const CPV_CODE_COUNT = 9454;
/** Rows per SPARQL request. */
export const CPV_PAGE_SIZE = 5000;

/** The codes and their English names, one page of them. */
export function cpvQuery(offset: number): string {
  return [
    "PREFIX skos: <http://www.w3.org/2004/02/skos/core#>",
    "SELECT ?code ?label WHERE {",
    "  ?c skos:inScheme <http://data.europa.eu/cpv/cpv> ; skos:notation ?code ; skos:prefLabel ?label .",
    '  FILTER(lang(?label) = "en")',
    `} ORDER BY ?code LIMIT ${CPV_PAGE_SIZE} OFFSET ${offset}`,
  ].join("\n");
}

export function cpvQueryUrl(offset: number): string {
  return `${CPV_SPARQL_ENDPOINT}?${new URLSearchParams({ query: cpvQuery(offset), format: "text/csv" })}`;
}

export type CpvRow = [code: string, label: string];

/** CSV as SPARQL writes it (RFC 4180): a quoted field may hold commas, line breaks and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (char === '"' && !started) {
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      started = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (started || row.length) rows.push([...row, field]);
  return rows;
}

/** The code,label rows of a SPARQL CSV answer, its header checked and dropped. */
export function cpvRowsOf(csv: string): CpvRow[] {
  const [header, ...rows] = parseCsv(csv);
  if (header?.join(",") !== "code,label") throw new Error(`Unexpected CSV header: ${header?.join(",") ?? "(none)"}`);
  return rows.map((row, i) => {
    if (row.length !== 2) throw new Error(`Row ${i + 2} has ${row.length} fields: ${row.join(",")}`);
    return [row[0]!.trim(), row[1]!.trim()];
  });
}

/** What is wrong with the rows, if anything: their count, a code's form, a code twice, an empty name. */
export function cpvProblems(rows: readonly CpvRow[]): string[] {
  const problems: string[] = [];
  if (rows.length !== CPV_CODE_COUNT) problems.push(`${rows.length} codes, not ${CPV_CODE_COUNT}`);
  const seen = new Set<string>();
  for (const [code, label] of rows) {
    if (!/^\d{8}$/.test(code)) problems.push(`Not eight digits: ${code}`);
    if (seen.has(code)) problems.push(`Twice: ${code}`);
    if (!label) problems.push(`No name: ${code}`);
    seen.add(code);
  }
  return problems;
}

/** One code per line, in code order: small, and a diff shows what changed. */
export function cpvJson(rows: readonly CpvRow[]): string {
  const sorted = [...rows].sort((a, b) => a[0].localeCompare(b[0]));
  return `[\n${sorted.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
}
