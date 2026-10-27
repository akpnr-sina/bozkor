// The CPV prefixes a profile includes and excludes, as the picker edits them.
// Matching (src/matching/engine.ts) drops a tender's excluded codes first and
// then looks for an included prefix among the rest, the chosen categories'
// prefixes counting as included.

export type CpvLists = { include: string[]; exclude: string[] };
export type CpvTarget = keyof CpvLists;

/** A prefix the profile includes through a chosen category. */
export type CategoryPrefix = { prefix: string; category: string };

export type CpvChange = { lists: CpvLists; message: string | null };

export const LIST_NAMES: Record<CpvTarget, string> = { include: "Dahil", exclude: "Hariç" };

const other = (target: CpvTarget): CpvTarget => (target === "include" ? "exclude" : "include");
/** Whether `parent` holds `prefix` and is not the same prefix. */
const holds = (parent: string, prefix: string) => prefix !== parent && prefix.startsWith(parent);

/** What may be stored as a prefix: 2 to 8 digits; a full code may carry its check digit (31121000-7). */
export function typedPrefix(typed: string): string | null {
  const value = typed.trim().replace(/^(\d{8})-\d$/, "$1");
  return /^\d{2,8}$/.test(value) ? value : null;
}

/** How a prefix is named in messages; the picker writes the code it stands for. */
export type CpvDisplay = (prefix: string) => string;

/**
 * Adds a prefix to a list. Not added: one the list holds through a shorter
 * prefix; to include, one a chosen category holds, or one inside an excluded
 * prefix, which matching would never reach. Added: the prefixes it holds
 * leave the list, and it leaves the other list.
 */
export function addCpv(
  lists: CpvLists,
  prefix: string,
  target: CpvTarget,
  categories: readonly CategoryPrefix[] = [],
  show: CpvDisplay = (p) => p,
): CpvChange {
  const list = lists[target];
  const unchanged = (message: string): CpvChange => ({ lists, message });
  if (list.includes(prefix)) return unchanged(`${show(prefix)} zaten ${LIST_NAMES[target]} listesinde.`);
  const parent = list.find((p) => holds(p, prefix));
  if (parent) return unchanged(`${show(prefix)} zaten ${show(parent)} ile kapsanıyor.`);
  if (target === "include") {
    const category = categories.find((c) => c.prefix === prefix || holds(c.prefix, prefix));
    if (category) return unchanged(`${show(prefix)} zaten ${category.category} kategorisiyle (${show(category.prefix)}) kapsanıyor.`);
    const excluded = lists.exclude.find((p) => holds(p, prefix));
    if (excluded) {
      return unchanged(`${show(prefix)}, Hariç listesindeki ${show(excluded)} içinde kaldığı için eşleşmez. Önce ${show(excluded)} kodunu çıkarın.`);
    }
  }

  const dropped = list.filter((p) => holds(prefix, p));
  const moved = lists[other(target)].includes(prefix);
  const next: CpvLists = { include: lists.include, exclude: lists.exclude };
  next[target] = [...list.filter((p) => !holds(prefix, p)), prefix];
  next[other(target)] = lists[other(target)].filter((p) => p !== prefix);
  const blocked = target === "exclude" ? next.include.filter((p) => holds(prefix, p)) : [];

  const notes = [
    moved && `${show(prefix)}, ${LIST_NAMES[other(target)]} listesinden ${LIST_NAMES[target]} listesine taşındı.`,
    dropped.length > 0 && `${dropped.map(show).join(", ")} artık ${show(prefix)} ile kapsandığı için listeden çıktı.`,
    blocked.length > 0 && `Dahil listesindeki ${blocked.map(show).join(", ")} artık ${show(prefix)} ile hariç tutuluyor.`,
  ].filter((note): note is string => Boolean(note));
  return { lists: next, message: notes.length ? notes.join(" ") : null };
}

/** Moves a prefix to the other list, under the same rules as adding it there. */
export function moveCpv(lists: CpvLists, prefix: string, categories: readonly CategoryPrefix[] = [], show?: CpvDisplay): CpvChange {
  const from: CpvTarget = lists.include.includes(prefix) ? "include" : "exclude";
  return addCpv(lists, prefix, other(from), categories, show);
}

export function removeCpv(lists: CpvLists, prefix: string): CpvLists {
  return { include: lists.include.filter((p) => p !== prefix), exclude: lists.exclude.filter((p) => p !== prefix) };
}

/** Where a prefix stands: in a list, held by one of its prefixes (or a category), or nowhere. */
export function cpvStanding(lists: CpvLists, prefix: string, categories: readonly CategoryPrefix[] = []): CpvTarget | "covered" | null {
  if (lists.include.includes(prefix)) return "include";
  if (lists.exclude.includes(prefix)) return "exclude";
  if (lists.exclude.some((p) => holds(p, prefix))) return "exclude";
  if (lists.include.some((p) => holds(p, prefix)) || categories.some((c) => c.prefix === prefix || holds(c.prefix, prefix))) return "covered";
  return null;
}
