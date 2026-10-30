import { isProductScope } from "@/sources/scope";

// The CPV 2008 vocabulary (Regulation (EC) No 213/2008) as the profile form
// reads it: each code with its official English name, its Turkish name (goods
// codes), its prefix, its level and its parent. The hierarchy is in the trailing zeros: a division has 2 significant
// digits, a group 3, a class 4, a category 5, subcategories 6 to 8. Matching
// works on prefixes (src/matching): a profile's prefix holds every code that
// starts with it.

export type CpvLevel = "Bölüm" | "Grup" | "Sınıf" | "Kategori" | "Alt kategori";

export type CpvItem = {
  /** What a profile stores: the code without its trailing zeros, e.g. "31121". */
  prefix: string;
  /** The eight digits, without the check digit, e.g. "31121000". */
  code: string;
  /** The official English name. */
  label: string;
  /** The Turkish name, a translation (index.ts); null outside the goods divisions. */
  labelTr: string | null;
  level: CpvLevel;
  hasChildren: boolean;
};

/**
 * Goes into the profile form's requests to /api/cpv, which browsers keep for an
 * hour: change it when the names change, so the form does not show old ones.
 */
export const CPV_NAMES_VERSION = "tr-2026-10-30";

/** The name to show: the Turkish one where there is one, else the official English. */
export const cpvName = (item: Pick<CpvItem, "label" | "labelTr">): string => item.labelTr ?? item.label;

/** "31121000" as "31121": the trailing zeros dropped, the division's two digits kept. */
export function cpvPrefixOf(code: string): string {
  const trimmed = code.replace(/0+$/, "");
  return trimmed.length >= 2 ? trimmed : code.slice(0, 2);
}

export function cpvLevelOf(prefix: string): CpvLevel {
  if (prefix.length <= 2) return "Bölüm";
  if (prefix.length === 3) return "Grup";
  if (prefix.length === 4) return "Sınıf";
  if (prefix.length === 5) return "Kategori";
  return "Alt kategori";
}

/** For comparing names: no accents, lower case, words split by single spaces. */
export function normalizeCpvText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type Entry = Omit<CpvItem, "hasChildren"> & { text: string; textTr: string | null; inScope: boolean; parent: string | null };

export type CpvCatalog = {
  /** The code a stored prefix stands for: its own, or the eight digits given in full. Null when the vocabulary has none. */
  item(prefix: string): CpvItem | null;
  label(prefix: string): string | null;
  /**
   * Codes in scope (goods, src/sources/scope.ts) for what was typed. Digits:
   * the codes they begin, the code itself first. Words, any case or accent, in
   * the English or the Turkish name, whichever matches better: the name as
   * typed, then names that start with it, names with a word that starts with
   * it, names that contain it, names with all its words. Higher levels first
   * within each.
   */
  search(query: string, limit?: number): CpvItem[];
  /** The codes right under a prefix; under null, the goods divisions (03 to 44 without 48). */
  children(prefix: string | null): CpvItem[];
};

/** `turkish`: Turkish names by code, for the codes that have one. */
export function createCpvCatalog(rows: readonly (readonly [string, string])[], turkish: readonly (readonly [string, string])[] = []): CpvCatalog {
  const turkishNames = new Map(turkish);
  const byPrefix = new Map<string, Entry>();
  const byCode = new Map<string, Entry>();
  for (const [code, label] of rows) {
    const prefix = cpvPrefixOf(code);
    const labelTr = turkishNames.get(code) ?? null;
    const entry: Entry = {
      prefix,
      code,
      label,
      labelTr,
      level: cpvLevelOf(prefix),
      text: normalizeCpvText(label),
      textTr: labelTr === null ? null : normalizeCpvText(labelTr),
      inScope: isProductScope(null, code),
      parent: null,
    };
    byPrefix.set(prefix, entry);
    byCode.set(code, entry);
  }

  // A parent is the nearest shorter prefix the vocabulary has; a level may be skipped.
  const children = new Map<string, Entry[]>();
  for (const entry of byPrefix.values()) {
    for (let length = entry.prefix.length - 1; length >= 2; length--) {
      const parent = entry.prefix.slice(0, length);
      if (!byPrefix.has(parent)) continue;
      entry.parent = parent;
      children.set(parent, [...(children.get(parent) ?? []), entry]);
      break;
    }
  }

  const byCodeOrder = (a: Entry, b: Entry) => a.code.localeCompare(b.code);
  const higherFirst = (a: Entry, b: Entry) => a.prefix.length - b.prefix.length || byCodeOrder(a, b);
  const toItem = ({ prefix, code, label, labelTr, level }: Entry): CpvItem => ({ prefix, code, label, labelTr, level, hasChildren: children.has(prefix) });
  const roots = [...byPrefix.values()].filter((e) => e.prefix.length === 2 && e.inScope).sort(byCodeOrder);
  const inScope = [...byPrefix.values()].filter((e) => e.inScope);

  function ranked(rank: (entry: Entry) => number | null, limit: number): CpvItem[] {
    return inScope
      .flatMap((entry) => {
        const r = rank(entry);
        return r === null ? [] : [{ entry, r }];
      })
      .sort((a, b) => a.r - b.r || higherFirst(a.entry, b.entry))
      .slice(0, limit)
      .map(({ entry }) => toItem(entry));
  }

  return {
    item(prefix) {
      const entry = byPrefix.get(prefix) ?? byCode.get(prefix);
      return entry ? toItem(entry) : null;
    },
    label(prefix) {
      return (byPrefix.get(prefix) ?? byCode.get(prefix))?.label ?? null;
    },
    search(query, limit = 20) {
      const typed = query.trim();
      // A code is often copied with its check digit, e.g. 31121000-7.
      const digits = /^\d{8}-\d$/.test(typed) ? typed.slice(0, 8) : /^[\d\s.]+$/.test(typed) ? typed.replace(/\D/g, "") : null;
      if (digits !== null) {
        if (!digits || digits.length > 8) return [];
        return ranked((e) => (e.prefix === digits || e.code === digits ? 0 : e.code.startsWith(digits) ? 1 : null), limit);
      }
      const words = normalizeCpvText(typed);
      if (words.length < 2) return [];
      const tokens = words.split(" ");
      const rank = (text: string): number | null => {
        if (text === words) return 0;
        if (text.startsWith(words)) return 1;
        if (` ${text}`.includes(` ${words}`)) return 2;
        if (text.includes(words)) return 3;
        return tokens.every((token) => text.includes(token)) ? 4 : null;
      };
      return ranked((e) => {
        const ranks = [rank(e.text), e.textTr === null ? null : rank(e.textTr)].filter((r) => r !== null);
        return ranks.length ? Math.min(...ranks) : null;
      }, limit);
    },
    children(prefix) {
      if (prefix === null) return roots.map(toItem);
      return [...(children.get(prefix) ?? [])].sort(byCodeOrder).map(toItem);
    },
  };
}
