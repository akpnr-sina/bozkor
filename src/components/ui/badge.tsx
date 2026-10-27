import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// 22px, 2px corners; colour only for a status (ok, warn, err, info), grey for everything else.
const badgeVariants = cva(
  "group/badge inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 overflow-hidden rounded-sm px-2 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-canvas text-ink-600 shadow-[inset_0_0_0_1px_var(--color-line)]",
        outline: "bg-surface text-ink-600 shadow-[inset_0_0_0_1px_var(--color-line)]",
        solid: "bg-ink-900 text-white",
        ok: "bg-ok-soft text-ok",
        warn: "bg-warn-soft text-warn",
        err: "bg-err-soft text-err",
        info: "bg-info-soft text-info",
        // Earlier names.
        secondary: "bg-canvas text-ink-600 shadow-[inset_0_0_0_1px_var(--color-line)]",
        destructive: "bg-err-soft text-err",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>
const GREY: BadgeVariant[] = ["default", "outline", "secondary"]

/** `dot` adds the design's small square in the badge's colour (grey badges: a lighter grey). */
function Badge({
  className,
  variant = "default",
  dot = false,
  render,
  children,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  const tone = variant ?? "default"
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant: tone }), className),
        children: dot ? (
          <>
            <span aria-hidden className={cn("size-1.5 shrink-0", GREY.includes(tone) ? "bg-ink-400" : "bg-current")} />
            {children}
          </>
        ) : (
          children
        ),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant: tone,
    },
  })
}

export { Badge, badgeVariants, type BadgeVariant }
