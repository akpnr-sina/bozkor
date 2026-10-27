import { cn } from "@/lib/utils";

/** What a list or panel says when it has nothing: a dashed box. */
export function EmptyState({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("border border-dashed border-line-strong p-3.5 text-[13px] leading-normal text-ink-600", className)}>{children}</div>;
}
