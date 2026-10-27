import { describe, expect, it } from "vitest";
import { CPV_CODE_COUNT, cpvJson, cpvProblems, cpvQuery, cpvQueryUrl, cpvRowsOf, parseCsv, type CpvRow } from "./source";

describe("parseCsv", () => {
  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    expect(parseCsv('code,label\r\n03000000,"Agricultural, farming"\n15000000,"A ""quoted"" name"\n44000000,"Two\nlines"\n')).toEqual([
      ["code", "label"],
      ["03000000", "Agricultural, farming"],
      ["15000000", 'A "quoted" name'],
      ["44000000", "Two\nlines"],
    ]);
    expect(parseCsv('a,""\nb,')).toEqual([
      ["a", ""],
      ["b", ""],
    ]);
  });
});

describe("cpvRowsOf", () => {
  it("drops the header of a SPARQL CSV answer and checks it", () => {
    expect(cpvRowsOf('code,label\n31121000,Generating sets\n31000000,"Electrical machinery, apparatus"\n')).toEqual([
      ["31121000", "Generating sets"],
      ["31000000", "Electrical machinery, apparatus"],
    ]);
    expect(() => cpvRowsOf("notation,name\n31121000,Generating sets\n")).toThrow("Unexpected CSV header: notation,name");
    expect(() => cpvRowsOf("code,label\n31121000\n")).toThrow("Row 2 has 1 fields");
  });
});

describe("cpvProblems", () => {
  it("finds a wrong count, a malformed or repeated code and an empty name", () => {
    const whole: CpvRow[] = Array.from({ length: CPV_CODE_COUNT }, (_, i) => [String(10_000_000 + i), `Code ${i}`]);
    expect(cpvProblems(whole)).toEqual([]);
    expect(cpvProblems([["31121000", "Generating sets"]])).toEqual([`1 codes, not ${CPV_CODE_COUNT}`]);
    const broken: CpvRow[] = [...whole.slice(3), ["3112100", "Short"], ["10000003", "Again"], ["10000004", ""]];
    expect(cpvProblems(broken)).toEqual(["Not eight digits: 3112100", "Twice: 10000003", "Twice: 10000004", "No name: 10000004"]);
  });
});

describe("the SPARQL query and the JSON", () => {
  it("asks for the vocabulary's English names in code order, page by page", () => {
    expect(cpvQuery(5000)).toContain('FILTER(lang(?label) = "en")');
    expect(cpvQuery(5000)).toMatch(/ORDER BY \?code LIMIT 5000 OFFSET 5000$/);
    const url = new URL(cpvQueryUrl(0));
    expect(url.origin + url.pathname).toBe("https://publications.europa.eu/webapi/rdf/sparql");
    expect(url.searchParams.get("format")).toBe("text/csv");
    expect(url.searchParams.get("query")).toContain("skos:inScheme <http://data.europa.eu/cpv/cpv>");
  });

  it("writes one code per line in code order", () => {
    expect(cpvJson([["31121000", "Generating sets"], ["03000000", 'A "name"']])).toBe('[\n["03000000","A \\"name\\""],\n["31121000","Generating sets"]\n]\n');
  });
});
