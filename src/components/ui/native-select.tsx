import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "cn"
import { fieldClass } from "./input"

/** A native select drawn like the other fields. */
function NativeSelect({ className, size = "default", ...props }: Omit<React.ComponentProps<"select">, "size"> & { size?: "default" | "sm" }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        data-slot="native-select"
        className={cn(fieldClass, "cursor-pointer appearance-none pr-8", size === "sm" ? "h-8 text-[13px] md:text-[13px]" : "h-9")}
        {...props}
      />
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-ink-500" />
    </span>
  )
}

export { NativeSelect }
