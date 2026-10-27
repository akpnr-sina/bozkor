import Link from "next/link";
import { cn } from "@/lib/utils";

export type Stat = {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  /** Colour only when the figure is a status (CLAUDE.md, "Arayüz"). */
  tone?: "ok" | "warn" | "err" | "info";
  href?: string;
};

const TONE: Record<NonNullable<Stat["tone"]>, string> = { ok: "text-ok", warn: "text-warn", err: "text-err", info: "text-info" };

/**
 * Figures side by side in one box, split by 1px lines: "lg" for a page's key figures (KPIs, 4 to a row),
 * "md" for a record's facts (6 to a row on a wide screen).
 */
export function StatStrip({ items, size = "lg", className }: { items: readonly Stat[]; size?: "lg" | "md"; className?: string }) {
  return (
    <div
      className={cn(
        "grid gap-px border border-line bg-line",
        size === "lg" ? "grid-cols-2 md:grid-cols-4" : "grid-cols-2 md:grid-cols-3 2xl:grid-cols-6",
        className,
      )}
    >
      {items.map((item) => {
        const body = (
          <>
            <span className="eyebrow">{item.label}</span>
            <span
              className={cn(
                "font-heading leading-none font-medium text-ink-900",
                size === "lg" ? "text-[30px]" : "text-[22px] leading-[1.1]",
                item.tone && TONE[item.tone],
              )}
            >
              {item.value}
            </span>
            {item.note && <span className="truncate text-xs text-ink-500">{item.note}</span>}
          </>
        );
        const cell = cn("flex min-w-0 flex-col bg-surface", size === "lg" ? "gap-3 px-[18px] py-4" : "gap-2 px-[18px] py-4");
        return item.href ? (
          <Link key={item.label} href={item.href} className={cn(cell, "transition-colors hover:bg-surface-hover")}>
            {body}
          </Link>
        ) : (
          <div key={item.label} className={cell}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
