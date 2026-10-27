import { cn } from "@/lib/utils";

const TONE = {
  warn: "border-warn-line bg-warn-soft text-warn-ink",
  err: "border-err-line bg-err-soft text-err-ink",
  info: "border-info-line bg-info-soft text-info-ink",
  ok: "border-ok-line bg-ok-soft text-ok-ink",
} as const;

/** A warning or message box: a bold line, a detail line, an action on the right. role="alert" only for what must interrupt. */
export function Notice({
  tone,
  title,
  children,
  action,
  role,
  className,
}: {
  tone: keyof typeof TONE;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  role?: "alert" | "status";
  className?: string;
}) {
  return (
    <div role={role} className={cn("flex items-center justify-between gap-3 border px-3.5 py-3", TONE[tone], className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && <span className="text-sm font-semibold">{title}</span>}
        {children && <div className="text-[13px]">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
