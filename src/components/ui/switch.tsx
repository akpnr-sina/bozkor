"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

// A square switch: black when on, grey when off.
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-[18px] w-8 shrink-0 items-center rounded-sm bg-line-strong p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 data-checked:bg-ink-900 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 rounded-xs bg-white transition-transform data-checked:translate-x-3.5" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
