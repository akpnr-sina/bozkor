import { cn } from "@/lib/utils";

// The BOZKOR mark (the design's brand symbol) and the wordmark in Oxanium.

export function BozkorMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={cn("block size-5 shrink-0 fill-current", className)} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path
        fillRule="evenodd"
        d="M10.69 0 L31.31 0 L42 10.69 L42 31.31 L31.31 42 L10.69 42 L0 31.31 L0 10.69Z M15.66 12 L26.34 12 L30 15.66 L30 26.34 L26.34 30 L15.66 30 L12 26.34 L12 15.66Z"
      />
      <path
        fillRule="evenodd"
        d="M89.31 0 L68.69 0 L58 10.69 L58 31.31 L68.69 42 L89.31 42 L100 31.31 L100 10.69Z M84.34 12 L73.66 12 L70 15.66 L70 26.34 L73.66 30 L84.34 30 L88 26.34 L88 15.66Z"
      />
      <path d="M1.76 33.07 L68.68 100 L100 100 L100 39.1 L88 51.1 L88 88 L73.66 88 L10.24 24.59Z" />
      <path d="M89.76 24.59 L53.9 60.45 L62.38 68.93 L98.24 33.07Z" />
      <path d="M37.63 76.72 L26.34 88 L12 88 L12 51.1 L0 39.1 L0 100 L31.32 100 L46.11 85.2Z" />
    </svg>
  );
}

/** Mark and wordmark; the colour follows the text colour. */
export function BozkorLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-[11px]", className)}>
      <BozkorMark className="size-[19.8px]" />
      {/* Oxanium's capitals sit about 1px above the middle of its line; this centres them on the mark. */}
      <span className="relative top-px font-heading text-[18px] leading-none font-semibold tracking-[0.08em]">BOZKOR</span>
    </span>
  );
}
