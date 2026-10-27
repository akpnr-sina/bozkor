"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, isWithin, navNumber } from "@/lib/nav";
import { cn } from "@/lib/utils";

const GROUPS = ["Takip", "Yönetim"] as const;

/** Reads the URL, so it suspends on dynamic routes such as /tenders/[id]; render it inside <Suspense>. */
export function NavLinks({ counts }: { counts: Record<string, number> }) {
  const pathname = usePathname();

  return <NavList pathname={pathname} counts={counts} />;
}

/** The menu without URL access; a null pathname marks none active, for the Suspense fallback. */
export function NavList({ pathname, counts }: { pathname: string | null; counts: Record<string, number> | null }) {
  return (
    <nav aria-label="Sayfalar" className="flex flex-col gap-4 px-3 pt-5 pb-2">
      {GROUPS.map((group) => (
        <div key={group} className="flex flex-col gap-0.5">
          <span className="px-3 pb-2.5 font-heading text-[10px] font-medium tracking-[0.16em] text-ink-600 uppercase">{group}</span>
          {NAV.filter((item) => item.group === group).map((item) => {
            const active = pathname !== null && item.sections.some((section) => isWithin(pathname, section));
            const count = counts?.[item.href];
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-[38px] items-center gap-3 px-3 text-sm transition-colors focus-visible:outline-white",
                  active ? "bg-[linear-gradient(90deg,#232321,#1a1a19)] text-white" : "text-ink-400 hover:bg-nav-hover hover:text-white",
                )}
              >
                <span aria-hidden className={cn("absolute top-[9px] bottom-[9px] left-0 w-0.5", active ? "bg-white" : "bg-transparent")} />
                <span className={cn("w-4 font-mono text-[10px]", active ? "text-white" : "text-ink-600")}>{navNumber(item.href)}</span>
                <span className="flex-1">{item.label}</span>
                {count !== undefined && (
                  <span className={cn("px-1.5 py-px font-mono text-[11px] text-ink-400", active && "bg-ink-700")}>{count}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
