"use client";

import { ChevronRight, Menu, Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { BozkorMark } from "@/components/brand";
import { NAV, isWithin, navItemOf, navNumber } from "@/lib/nav";
import { cn } from "@/lib/utils";

/** Reads the URL; render inside <Suspense> with <Crumbs pathname={null} /> as the fallback. */
export function Breadcrumb() {
  return <Crumbs pathname={usePathname()} />;
}

/** Pages under a menu item, named for the trail. */
const LEAVES: [RegExp, string][] = [
  [/^\/tenders\/[^/]+$/, "İhale"],
  [/^\/profiles\/new$/, "Yeni profil"],
  [/^\/profiles\/[^/]+$/, "Profil"],
];

export function Crumbs({ pathname }: { pathname: string | null }) {
  const item = pathname ? navItemOf(pathname) : undefined;
  const leaf = pathname && item && pathname !== item.href ? LEAVES.find(([pattern]) => pattern.test(pathname))?.[1] : undefined;
  return (
    <nav aria-label="Konum" className="flex min-w-0 items-center gap-2.5 text-[13px]">
      <span className="hidden text-ink-500 sm:inline">İhale radarı</span>
      {item && (
        <>
          <Chevron className="hidden sm:block" />
          {leaf ? (
            <Link href={item.href} className="text-ink-500 transition-colors hover:text-ink-900">
              {item.label}
            </Link>
          ) : (
            <span aria-current="page" className="font-medium text-ink-900">
              {item.label}
            </span>
          )}
        </>
      )}
      {leaf && (
        <>
          <Chevron />
          <span aria-current="page" className="truncate font-medium text-ink-900">
            {leaf}
          </span>
        </>
      )}
    </nav>
  );
}

function Chevron({ className }: { className?: string }) {
  return <ChevronRight aria-hidden className={cn("size-3 shrink-0 text-ink-400", className)} />;
}

/** The search box with the inbox's current search filled in. Reads the URL; render inside <Suspense>. */
export function SearchFromUrl() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = pathname === "/inbox" ? (params.get("q") ?? "") : "";
  return <SearchBox key={query} query={query} />;
}

/** Searches the inbox (title, buyer, notice number); "/" focuses it from anywhere but a field. */
export function SearchBox({ query }: { query: string }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Form action="/inbox" role="search" className="relative hidden w-[300px] sm:block">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-500" />
      <input
        ref={input}
        type="search"
        name="q"
        defaultValue={query}
        placeholder="İhale, alıcı ya da ilan no ara"
        aria-label="İhale ara"
        className="h-8 w-full rounded-sm border border-line-strong bg-surface pr-9 pl-8 text-[13px] text-ink-900 transition-[border-color,box-shadow] outline-none placeholder:text-ink-400 hover:border-ink-400 focus-visible:border-ink-900 focus-visible:shadow-[0_0_0_1px_var(--color-ink-900)] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 border border-line bg-canvas px-1.5 font-mono text-[11px] text-ink-500"
      >
        /
      </kbd>
    </Form>
  );
}

/** The menu for narrow screens, where the sidebar is hidden; closes on navigation. */
export function MobileMenu() {
  const pathname = usePathname();
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (details.current) details.current.open = false;
  }, [pathname]);
  return (
    <details ref={details} className="relative lg:hidden">
      <summary
        aria-label="Menü"
        className="flex size-8 cursor-pointer list-none items-center justify-center rounded-sm border border-line-strong text-ink-900 [&::-webkit-details-marker]:hidden"
      >
        <Menu className="size-4" />
      </summary>
      <nav aria-label="Sayfalar" className="absolute top-10 left-0 z-30 flex w-64 flex-col border border-nav-line bg-nav p-2 shadow-overlay">
        <span className="flex items-center gap-2 px-3 py-2 text-white">
          <BozkorMark className="size-4" />
          <span className="font-heading text-sm font-semibold tracking-[0.08em]">BOZKOR</span>
        </span>
        {NAV.map((item) => {
          const active = pathname !== null && item.sections.some((section) => isWithin(pathname, section));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-3 px-3 text-sm focus-visible:outline-white",
                active ? "bg-ink-800 text-white" : "text-ink-400 hover:text-white",
              )}
            >
              <span className="w-4 font-mono text-[10px]">{navNumber(item.href)}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </details>
  );
}
