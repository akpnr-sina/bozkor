import Link from "next/link";
import { cn } from "@/lib/utils";

export type TabItem = { href: string; label: string; count?: number | null; active: boolean };

/** Tabs as links (the URL keeps the tab): a 2px black line under the current one, a grey count chip. */
export function TabNav({ items, label, className }: { items: readonly TabItem[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("flex gap-6 overflow-x-auto border-b border-line", className)}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          scroll={false}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 text-sm font-medium transition-colors",
            item.active ? "border-ink-900 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-900",
          )}
        >
          {item.label}
          {item.count != null && <span className="bg-canvas px-1.5 py-px font-mono text-[11px] text-ink-600">{item.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
