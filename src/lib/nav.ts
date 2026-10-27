// The app's pages as the menu lists them (CLAUDE.md, "Arayüz"): numbered in order, the number is shown
// on the page too ("02 / 05"). Tender pages belong to the inbox.

export type NavItem = { href: string; label: string; group: "Takip" | "Yönetim"; sections: readonly string[] };

export const NAV: readonly NavItem[] = [
  { href: "/panel", label: "Panel", group: "Takip", sections: ["/panel"] },
  { href: "/inbox", label: "Gelen kutusu", group: "Takip", sections: ["/inbox", "/tenders"] },
  { href: "/profiles", label: "Profiller", group: "Yönetim", sections: ["/profiles"] },
  { href: "/sources", label: "Kaynaklar", group: "Yönetim", sections: ["/sources"] },
  { href: "/settings", label: "Ayarlar", group: "Yönetim", sections: ["/settings"] },
];

const two = (n: number) => String(n).padStart(2, "0");

/** The menu number of a page: "02". */
export function navNumber(href: string): string {
  return two(NAV.findIndex((item) => item.href === href) + 1);
}

/** The page's place among all pages: "02 / 05". */
export function pageIndex(href: string): string {
  return `${navNumber(href)} / ${two(NAV.length)}`;
}

export const isWithin = (pathname: string, section: string) => pathname === section || pathname.startsWith(`${section}/`);

/** The menu item a path belongs to. */
export function navItemOf(pathname: string): NavItem | undefined {
  return NAV.find((item) => item.sections.some((section) => isWithin(pathname, section)));
}
