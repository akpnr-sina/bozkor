import { createCpvCatalog, type CpvItem } from "./catalog";
import vocabulary from "./cpv-2008.json";

// The CPV 2008 vocabulary on the server. Some 9,000 codes: pages and actions
// pass the form only what it shows, and client code imports types from
// ./catalog, never this module.

export type { CpvItem, CpvLevel } from "./catalog";

const catalog = createCpvCatalog(vocabulary as [string, string][]);

/** The English name of the code a stored prefix stands for, or null. */
export const cpvLabel = (prefix: string): string | null => catalog.label(prefix);

/** Goods codes for what was typed: digits begin a code, words are in its name (see CpvCatalog.search). */
export const searchCpv = (query: string, limit = 20): CpvItem[] => catalog.search(query, limit);

/** The codes right under a prefix; under null, the goods divisions. */
export const cpvChildren = (prefix: string | null): CpvItem[] => catalog.children(prefix);

/** The codes of stored prefixes, for showing them by name; null for a prefix the vocabulary does not have. */
export function cpvItems(prefixes: Iterable<string>): Record<string, CpvItem | null> {
  return Object.fromEntries([...new Set(prefixes)].map((prefix) => [prefix, catalog.item(prefix)]));
}
