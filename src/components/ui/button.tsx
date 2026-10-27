import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// 36px (default) and 28px (sm), 2px corners; one primary (default) button per screen, labels start with a verb.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border text-sm font-medium whitespace-nowrap transition-colors select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 disabled:pointer-events-none data-disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default:
          "border-ink-900 bg-ink-900 text-white hover:border-ink-800 hover:bg-ink-800 disabled:border-line disabled:bg-canvas disabled:text-ink-400",
        outline:
          "border-line-strong bg-surface text-ink-900 hover:border-ink-900 aria-expanded:border-ink-900 disabled:border-line disabled:bg-canvas disabled:text-ink-400",
        secondary: "border-line bg-canvas text-ink-900 hover:border-line-strong disabled:text-ink-400",
        ghost: "border-transparent bg-transparent text-ink-900 hover:bg-canvas aria-expanded:bg-canvas disabled:text-ink-400",
        destructive:
          "border-err bg-err text-white hover:border-err-ink hover:bg-err-ink disabled:border-line disabled:bg-canvas disabled:text-ink-400",
        // A quiet way to dismiss or delete: grey until hovered.
        "destructive-outline":
          "border-line-strong bg-surface text-ink-600 hover:border-err-line hover:bg-err-soft hover:text-err disabled:border-line disabled:bg-canvas disabled:text-ink-400",
        link: "h-auto! border-transparent px-0! text-ink-900 underline underline-offset-4 hover:text-ink-600",
      },
      size: {
        default: "h-9 px-4",
        xs: "h-6 gap-1 px-2 text-xs",
        sm: "h-7 gap-1.5 px-2.5 text-[13px]",
        lg: "h-10 px-5",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
