import { cn } from "@/lib/utils";

/** A page's head: its place in the menu ("02 / 05", pageIndex), the title in Oxanium, a line under it and the page's actions. */
export function PageHeader({
  index,
  title,
  description,
  actions,
  className,
}: {
  index?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="flex min-w-0 flex-col gap-2.5">
        {index && <span className="font-mono text-[11px] tracking-[0.04em] text-ink-400">{index}</span>}
        <h1 className="font-heading text-[30px] leading-none font-semibold tracking-[0.005em] text-ink-900">{title}</h1>
        {description && <p className="max-w-3xl text-[13px] text-ink-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
