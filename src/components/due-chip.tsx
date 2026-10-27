import { daysLeft, formatDaysLeft } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Days to a deadline in mono; amber when five days or fewer are left, grey once it has passed. */
export function DueChip({ deadline, now, className }: { deadline: Date | null; now: Date; className?: string }) {
  const days = daysLeft(deadline, now);
  const soon = days !== null && days >= 0 && days <= 5;
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 font-mono text-xs whitespace-nowrap",
        soon ? "bg-warn-soft text-warn" : days !== null && days < 0 ? "text-ink-400" : "text-ink-600",
        className,
      )}
    >
      {formatDaysLeft(days)}
    </span>
  );
}
