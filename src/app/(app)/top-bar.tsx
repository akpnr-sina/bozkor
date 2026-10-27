import Link from "next/link";
import { Suspense } from "react";
import { formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { loadShell, SYNC_DOT } from "./shell-data";
import { Breadcrumb, Crumbs, MobileMenu, SearchBox, SearchFromUrl } from "./top-bar-client";

/** The 60px bar over every page: where you are, the last sync, the search. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-15 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-6 lg:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <Suspense fallback={null}>
          <MobileMenu />
        </Suspense>
        <Suspense fallback={<Crumbs pathname={null} />}>
          <Breadcrumb />
        </Suspense>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <Suspense fallback={null}>
          <SyncChip />
        </Suspense>
        <Suspense fallback={<SearchBox query="" />}>
          <SearchFromUrl />
        </Suspense>
      </div>
    </header>
  );
}

async function SyncChip() {
  const { sync, now } = await loadShell();
  return (
    <Link
      href="/sources"
      className="hidden h-8 items-center gap-2 border border-line bg-surface-head px-3 text-xs text-ink-600 transition-colors hover:border-line-strong md:flex"
    >
      <span aria-hidden className={cn("size-1.5", SYNC_DOT[sync.tone])} />
      {sync.tone === "err" ? "Senkron hatası" : "Son senkron"}
      <span className="font-mono text-ink-900">{sync.lastSyncedAt ? formatClock(sync.lastSyncedAt, now) : "yok"}</span>
    </Link>
  );
}
