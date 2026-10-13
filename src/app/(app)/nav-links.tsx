"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  // Tender detail pages are opened from the inbox.
  { href: "/inbox", label: "Gelen kutusu", sections: ["/inbox", "/tenders"] },
  { href: "/profiles", label: "Profiller", sections: ["/profiles"] },
  { href: "/settings", label: "Ayarlar", sections: ["/settings"] },
] as const;

const isWithin = (pathname: string, section: string) => pathname === section || pathname.startsWith(`${section}/`);

/** Reads the URL, so it suspends on dynamic routes such as /tenders/[id]; render it inside <Suspense>. */
export function NavLinks() {
  const pathname = usePathname();

  return <NavList pathname={pathname} />;
}

/** The links without URL access; a null pathname marks none active, for the Suspense fallback. */
export function NavList({ pathname }: { pathname: string | null }) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      {LINKS.map(({ href, label, sections }) => {
        const active = pathname !== null && sections.some((section) => isWithin(pathname, section));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
              active && "bg-muted text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
