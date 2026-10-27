import { cn } from "@/lib/utils";

const TONE = { ink: "bg-ink-900", ok: "bg-ok", warn: "bg-warn", err: "bg-err", info: "bg-info", muted: "bg-ink-400" } as const;

/** A thin bar for a score (fit, a share): 4px high, grey track. */
export function Meter({
  value,
  max = 100,
  tone = "ink",
  label,
  className,
}: {
  value: number;
  max?: number;
  tone?: keyof typeof TONE;
  label?: string;
  className?: string;
}) {
  const share = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label} className={cn("h-1 w-14 shrink-0 bg-line", className)}>
      <div className={cn("h-full", TONE[tone])} style={{ width: `${share}%` }} />
    </div>
  );
}
