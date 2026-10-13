import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Recorded real API payload from tests/fixtures/<source>/<name>.json. */
export function loadFixture<T = unknown>(source: string, name: string): T {
  return JSON.parse(readFileSync(`${root}${source}/${name}.json`, "utf8")) as T;
}
