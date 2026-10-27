import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

// 36px, 1px line; focus draws a black border, an error a red one.
const fieldClass =
  "w-full min-w-0 rounded-sm border border-line-strong bg-surface px-2.5 text-base text-ink-900 transition-[border-color,box-shadow] outline-none placeholder:text-ink-400 focus-visible:border-ink-900 focus-visible:shadow-[0_0_0_1px_var(--color-ink-900)] focus-visible:outline-none disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-400 aria-invalid:border-err aria-invalid:shadow-[0_0_0_1px_var(--color-err)] md:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        fieldClass,
        "h-9 file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink-900",
        className
      )}
      {...props}
    />
  )
}

export { Input, fieldClass }
