import { LogOut } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { BozkorLogo } from "@/components/brand";
import { formatAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { signOut } from "./actions";
import { NavLinks, NavList } from "./nav-links";
import { loadShell, SYNC_DOT, syncText } from "./shell-data";

/** The dark menu on the left (248px, wide screens; the top bar has a menu button below that). */
export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-svh w-62 shrink-0 flex-col border-r border-nav-line bg-nav text-white lg:flex">
      {/* The link is a flex box so the logo is centred by its own height; as a line of text it sat 3px high.
          The 24px sides match the menu's: the logo starts with the labels, "İHALE" ends with the counts. */}
      <div className="flex h-15 shrink-0 items-center justify-between gap-3 border-b border-nav-line bg-nav-top px-6 shadow-[inset_0_1px_0_#1a1a18]">
        <Link href="/panel" aria-label="Panel" className="flex items-center focus-visible:outline-white">
          <BozkorLogo />
        </Link>
        <span className="flex items-center gap-2.5 font-mono text-[10px] leading-none tracking-[0.12em] text-ink-500">
          <span aria-hidden className="h-3 w-px bg-ink-800" />
          İHALE
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Suspense fallback={<NavList pathname={null} counts={null} />}>
          <SidebarNav />
        </Suspense>
        <Suspense fallback={<div className="mt-auto h-[118px] border-t border-nav-line" />}>
          <SidebarFooter />
        </Suspense>
      </div>
    </aside>
  );
}

async function SidebarNav() {
  const { counts } = await loadShell();
  return <NavLinks counts={counts} />;
}

/** The sources' health and the signed-in user. */
async function SidebarFooter() {
  const { user, sync, now } = await loadShell();
  const [name = user.email] = user.email.split("@");
  return (
    <div className="mt-auto flex flex-col gap-3.5 border-t border-nav-line px-4 py-3.5">
      <Link href="/sources" className="flex items-center gap-2 px-1 text-xs text-ink-400 transition-colors hover:text-white focus-visible:outline-white">
        <span aria-hidden className={cn("size-1.5 shrink-0", SYNC_DOT[sync.tone])} />
        <span className="flex-1">{syncText(sync)}</span>
        {sync.lastSyncedAt && (
          <span className="font-mono text-[11px] text-ink-600" title="Son senkronun üzerinden geçen süre">
            {formatAgo(sync.lastSyncedAt, now)}
          </span>
        )}
      </Link>
      <div className="flex items-center gap-2.5 border border-nav-card-line bg-nav-card p-2.5">
        <span
          aria-hidden
          className="chamfer-all flex size-[30px] shrink-0 items-center justify-center bg-white font-heading text-xs font-semibold text-ink-900"
        >
          {initials(name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[13px] font-medium">{name}</span>
          <span className="truncate text-xs text-ink-500">{user.email}</span>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            title="Çıkış yap"
            aria-label="Çıkış yap"
            className="flex size-7 items-center justify-center text-ink-500 transition-colors hover:text-white focus-visible:outline-white"
          >
            <LogOut className="size-3.5" />
          </button>
        </form>
      </div>
    </div>
  );
}

const initials = (name: string) => (name.replace(/[^\p{L}]/gu, "").slice(0, 2) || "?").toLocaleUpperCase("tr");
