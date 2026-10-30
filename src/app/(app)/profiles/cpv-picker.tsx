"use client";

import { ArrowRightLeft, ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CPV_NAMES_VERSION, cpvName, type CpvItem } from "@/matching/cpv/catalog";
import {
  addCpv,
  cpvStanding,
  LIST_NAMES,
  moveCpv,
  removeCpv,
  typedPrefix,
  type CategoryPrefix,
  type CpvLists,
  type CpvTarget,
} from "./cpv-selection";
import { createLatest, fetchJson, requestError } from "./latest";

// The CPV codes of a profile: a search box, the tree of the goods codes and the
// two lists of what is included and excluded. The vocabulary stays on the
// server (src/matching/cpv); the picker asks /api/cpv for what it shows, with
// plain requests rather than Server Actions, which the browser runs one at a
// time behind the live preview.

/** A prefix with what the vocabulary knows of it: null for a typed prefix that is no code. */
type Choice = { prefix: string; item: CpvItem | null };

const STANDING_BADGES = {
  include: { variant: "ok", label: "Dahil" },
  exclude: { variant: "err", label: "Hariç" },
  covered: { variant: "default", label: "Kapsanıyor" },
} as const;

export function CpvPicker({
  lists,
  onChange,
  names,
  categories,
  errors,
}: {
  lists: CpvLists;
  onChange: (lists: CpvLists) => void;
  /** What the page knew of the stored prefixes and the categories' ones. */
  names: Record<string, CpvItem | null>;
  /** The prefixes of the chosen categories, which count as included. */
  categories: readonly CategoryPrefix[];
  errors: Partial<Record<CpvTarget, string>>;
}) {
  const [known, setKnown] = useState<Record<string, CpvItem | null>>(names);
  const [message, setMessage] = useState<string | null>(null);
  const remember = (items: readonly CpvItem[]) =>
    setKnown((current) => ({ ...current, ...Object.fromEntries(items.map((item) => [item.prefix, item])) }));
  /** A stored prefix by the code it stands for, as people know codes; a typed one as it is. */
  const show = (prefix: string) => known[prefix]?.code ?? prefix;
  const standingOf = (prefix: string) => cpvStanding(lists, prefix, categories);

  const add = (choice: Choice, target: CpvTarget) => {
    if (choice.item) remember([choice.item]);
    const change = addCpv(lists, choice.prefix, target, categories, show);
    if (change.lists !== lists) onChange(change.lists);
    setMessage(change.message ?? `${show(choice.prefix)} ${LIST_NAMES[target]} listesine eklendi.`);
  };
  const move = (prefix: string) => {
    const change = moveCpv(lists, prefix, categories, show);
    if (change.lists !== lists) onChange(change.lists);
    setMessage(change.message);
  };
  const remove = (prefix: string) => {
    onChange(removeCpv(lists, prefix));
    setMessage(`${show(prefix)} çıkarıldı.`);
  };

  return (
    <div className="flex flex-col gap-4">
      <CpvSearch onPick={add} standingOf={standingOf} />
      <p role="status" className="min-h-4 text-xs text-ink-600">
        {message}
      </p>
      <CpvTree onPick={add} standingOf={standingOf} remember={remember} />
      <div className="grid gap-4 md:grid-cols-2">
        {(["include", "exclude"] as const).map((target) => (
          <ChipList key={target} target={target} prefixes={lists[target]} known={known} error={errors[target]} onMove={move} onRemove={remove} />
        ))}
      </div>
    </div>
  );
}

/** The codes the chosen categories bring in, by name; they count as included. */
export function CategoryCodes({ categories, names }: { categories: readonly CategoryPrefix[]; names: Record<string, CpvItem | null> }) {
  if (!categories.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-500">Seçili kategorilerden gelen kodlar (dahil sayılır)</span>
      <ul className="flex flex-wrap gap-1.5">
        {categories.map(({ prefix, category }) => {
          const item = names[prefix] ?? null;
          return (
            <li key={`${category}-${prefix}`} title={chipTitle(prefix, item, category)} className={cn(CHIP, "pr-2 text-ink-600")}>
              <span className="font-mono text-ink-900">{item?.code ?? prefix}</span>
              <span className="max-w-56 truncate">{item ? cpvName(item) : "Adı bilinmiyor"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const CHIP = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-sm bg-canvas pl-2 text-[13px] shadow-[inset_0_0_0_1px_var(--color-line)]";

function chipTitle(prefix: string, item: CpvItem | null, category?: string): string {
  const name = item
    ? `${item.code} ${cpvName(item)} (${item.level})${item.labelTr ? `; resmi adı: ${item.label}` : ""}`
    : `${prefix}: adı bilinmeyen önek`;
  const from = category ? `, ${category} kategorisinden` : "";
  return `${name}${from}. ${prefix} ile başlayan tüm kodlar sayılır.`;
}

function ChipList({
  target,
  prefixes,
  known,
  error,
  onMove,
  onRemove,
}: {
  target: CpvTarget;
  prefixes: readonly string[];
  known: Record<string, CpvItem | null>;
  error?: string;
  onMove: (prefix: string) => void;
  onRemove: (prefix: string) => void;
}) {
  const otherName = LIST_NAMES[target === "include" ? "exclude" : "include"];
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">
        {LIST_NAMES[target]} ({prefixes.length})
      </span>
      {prefixes.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {prefixes.map((prefix) => {
            const item = known[prefix] ?? null;
            const code = item?.code ?? prefix;
            return (
              <li key={prefix} title={chipTitle(prefix, item)} className={CHIP}>
                <span className="font-mono">{code}</span>
                <span className={cn("max-w-56 truncate", item ? "text-ink-600" : "text-ink-400")}>{item ? cpvName(item) : "Adı bilinmiyor"}</span>
                <span className="flex items-center">
                  <button
                    type="button"
                    onClick={() => onMove(prefix)}
                    aria-label={`${code} kodunu ${otherName} listesine taşı`}
                    title={`${otherName} listesine taşı`}
                    className="flex size-6 items-center justify-center text-ink-500 transition-colors hover:text-ink-900"
                  >
                    <ArrowRightLeft className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(prefix)}
                    aria-label={`${code} kodunu kaldır`}
                    title="Kaldır"
                    className="flex size-6 items-center justify-center text-ink-500 transition-colors hover:text-err"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState className="p-2.5 text-xs">
          {target === "include" ? "Dahil edilen kod yok; kategoriler ve anahtar kelimeler yine eşleşir." : "Hariç tutulan kod yok."}
        </EmptyState>
      )}
      {error && <span className="text-xs text-err">{error}</span>}
    </div>
  );
}

/** Whether a code is in a list already, or held by one there. */
function Standing({ standing }: { standing: CpvTarget | "covered" | null }) {
  if (!standing) return null;
  const badge = STANDING_BADGES[standing];
  return (
    <Badge variant={badge.variant} dot className="shrink-0">
      {badge.label}
    </Badge>
  );
}

/** "Dahil et" and "Hariç tut" for a code; the search box keeps the focus when they are clicked. */
function PickButtons({ choice, onPick, focusable }: { choice: Choice; onPick: (choice: Choice, target: CpvTarget) => void; focusable: boolean }) {
  const code = choice.item?.code ?? choice.prefix;
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        tabIndex={focusable ? undefined : -1}
        aria-label={`${code} dahil et`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(choice, "include")}
      >
        Dahil et
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        tabIndex={focusable ? undefined : -1}
        aria-label={`${code} hariç tut`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onPick(choice, "exclude")}
      >
        Hariç tut
      </Button>
    </span>
  );
}

function CpvSearch({
  onPick,
  standingOf,
}: {
  onPick: (choice: Choice, target: CpvTarget) => void;
  standingOf: (prefix: string) => CpvTarget | "covered" | null;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; items: CpvItem[] } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searches] = useState(() => createLatest<CpvItem[]>());
  const typed = query.trim();

  // Asked a moment after typing stops; a new search aborts the one still running.
  useEffect(() => {
    if (!typed) {
      searches.abort();
      return;
    }
    const timer = setTimeout(async () => {
      const outcome = await searches.run((signal) => fetchJson<CpvItem[]>(`/api/cpv/search?${new URLSearchParams({ q: typed, v: CPV_NAMES_VERSION })}`, { signal }));
      if (outcome.status === "done") {
        setFound({ query: typed, items: outcome.value });
        setActive(0);
      } else if (outcome.status === "failed") setFailed(requestError(outcome.error));
    }, 200);
    return () => clearTimeout(timer);
  }, [typed, searches]);
  useEffect(() => () => searches.abort(), [searches]);

  const items = typed && found?.query === typed ? found.items : [];
  const manual = typedPrefix(typed);
  const options: Choice[] = [
    // A prefix that is no code of the vocabulary may still be added as it is.
    ...(manual && found?.query === typed && !items.some((item) => item.prefix === manual || item.code === manual) ? [{ prefix: manual, item: null }] : []),
    ...items.map((item) => ({ prefix: item.prefix, item })),
  ];
  const current = Math.min(active, options.length - 1);
  const showList = open && typed.length > 0;
  const optionId = (index: number) => `${id}-option-${index}`;

  const choose = (choice: Choice | undefined, target: CpvTarget) => {
    if (choice) onPick(choice, target);
  };

  return (
    <div className="relative flex flex-col gap-1.5">
      <label htmlFor={`${id}-input`} className="text-[13px] leading-none font-medium text-ink-900">
        Kod ya da ürün adı ara
      </label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-500" />
        <Input
          id={`${id}-input`}
          role="combobox"
          aria-expanded={showList}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={showList && current >= 0 ? optionId(current) : undefined}
          aria-describedby={`${id}-hint`}
          autoComplete="off"
          value={query}
          placeholder="örn. 3112, jeneratör ya da generating sets"
          className="pl-8"
          onChange={(e) => {
            setQuery(e.target.value);
            setFailed(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive(Math.min(current + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(current - 1, 0));
            } else if (e.key === "Enter") {
              // Never the form's submit from here.
              e.preventDefault();
              if (showList) choose(options[current], e.shiftKey ? "exclude" : "include");
            } else if (e.key === "Escape" && showList) {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
      </div>
      <span id={`${id}-hint`} className="text-xs text-ink-500">
        Kodlar resmi CPV 2008 listesinden. Türkçe adlar çeviridir, resmi İngilizce ad yanında ya da üzerine gelince görünür; iki dilde de arayabilirsiniz. Oklarla seçin; Enter dahil eder, Shift+Enter hariç tutar.
      </span>
      {showList && (
        <div className="absolute top-full right-0 left-0 z-20 mt-1 border border-line bg-surface shadow-overlay" onMouseDown={(e) => e.preventDefault()}>
          <ul id={`${id}-list`} role="listbox" aria-label="CPV kodları" className="max-h-80 overflow-y-auto">
            {options.map((choice, index) => (
              <li
                key={choice.item ? choice.prefix : `typed-${choice.prefix}`}
                id={optionId(index)}
                role="option"
                aria-selected={index === current}
                onMouseEnter={() => setActive(index)}
                className={cn("flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0", index === current && "bg-surface-hover")}
              >
                <span className="w-[4.5rem] shrink-0 font-mono text-[13px]">{choice.item?.code ?? choice.prefix}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px]" title={choice.item ? cpvName(choice.item) : undefined}>
                    {choice.item ? cpvName(choice.item) : `Öneki ekle: ${choice.prefix}`}
                  </span>
                  <span className="truncate text-xs text-ink-500" title={choice.item?.labelTr ? `Resmi adı: ${choice.item.label}` : undefined}>
                    {choice.item
                      ? `${choice.item.level}${choice.item.labelTr ? ` · ${choice.item.label}` : ""}`
                      : "Listede yok; bu rakamlarla başlayan kodlar sayılır"}
                  </span>
                </span>
                <Standing standing={standingOf(choice.prefix)} />
                <PickButtons choice={choice} onPick={onPick} focusable={false} />
              </li>
            ))}
          </ul>
          {!options.length && (
            <p className="px-3 py-2.5 text-[13px] text-ink-500">
              {failed ?? (found?.query !== typed ? "Aranıyor..." : "Eşleşen kod yok.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CpvTree({
  onPick,
  standingOf,
  remember,
}: {
  onPick: (choice: Choice, target: CpvTarget) => void;
  standingOf: (prefix: string) => CpvTarget | "covered" | null;
  remember: (items: readonly CpvItem[]) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  /** The codes under each prefix loaded so far; "" for the divisions. */
  const [levels, setLevels] = useState<Record<string, CpvItem[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  // Levels load side by side; they are aborted only when the picker goes away.
  const requests = useRef(new Set<AbortController>());
  useEffect(() => {
    const running = requests.current;
    return () => {
      for (const controller of running) controller.abort();
      running.clear();
    };
  }, []);

  async function load(prefix: string | null) {
    const key = prefix ?? "";
    if (levels[key] || loading.has(key)) return;
    setLoading((current) => new Set(current).add(key));
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const items = await fetchJson<CpvItem[]>(`/api/cpv/tree?${new URLSearchParams({ prefix: key, v: CPV_NAMES_VERSION })}`, { signal: controller.signal });
      setLevels((current) => ({ ...current, [key]: items }));
      remember(items);
      setFailed(null);
    } catch (error) {
      if (!controller.signal.aborted) setFailed(requestError(error));
    } finally {
      requests.current.delete(controller);
      setLoading((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  const toggle = (prefix: string) => {
    const next = new Set(expanded);
    if (next.has(prefix)) next.delete(prefix);
    else {
      next.add(prefix);
      void load(prefix);
    }
    setExpanded(next);
  };

  function level(prefix: string, depth: number): React.ReactNode {
    const items = levels[prefix];
    if (!items) return loading.has(prefix) ? <p className="py-1.5 pl-8 text-xs text-ink-500">Yükleniyor...</p> : null;
    return (
      <ul className={cn("flex flex-col", depth > 0 && "ml-3 border-l border-line pl-2")}>
        {items.map((item) => {
          const isOpen = expanded.has(item.prefix);
          return (
            <li key={item.prefix}>
              <div className="flex items-center gap-2 py-1">
                {item.hasChildren ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`${item.code} altındaki kodları ${isOpen ? "gizle" : "göster"}`}
                    onClick={() => toggle(item.prefix)}
                    className="flex size-6 shrink-0 items-center justify-center text-ink-500 transition-colors hover:text-ink-900"
                  >
                    {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                ) : (
                  <span aria-hidden className="size-6 shrink-0" />
                )}
                <span className="w-[4.5rem] shrink-0 font-mono text-[13px]">{item.code}</span>
                <span className="min-w-0 flex-1 truncate text-[13px]" title={`${item.labelTr ? `Resmi adı: ${item.label}` : item.label} (${item.level})`}>
                  {cpvName(item)}
                </span>
                <Standing standing={standingOf(item.prefix)} />
                <PickButtons choice={{ prefix: item.prefix, item }} onPick={onPick} focusable />
              </div>
              {isOpen && level(item.prefix, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-controls={`${id}-tree`}
        className="w-fit"
        onClick={() => {
          setOpen(!open);
          if (!open) void load(null);
        }}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
        Kod ağacından seç
      </Button>
      {open && (
        <div id={`${id}-tree`} className="max-h-96 overflow-y-auto border border-line p-2">
          {failed && <p className="pb-1.5 text-xs text-err">Kodlar yüklenemedi. {failed}</p>}
          {level("", 0)}
        </div>
      )}
    </div>
  );
}
