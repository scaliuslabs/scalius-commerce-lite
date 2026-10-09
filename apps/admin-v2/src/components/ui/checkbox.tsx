import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@scalius/shared/utils";

/**
 * A 16px box with a 24px hit area (44px on phones, C6). The hit area hangs
 * outside the box by negative margins, so the box takes 16px in the layout.
 */
const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer group -m-3.5 inline-flex size-11 shrink-0 items-center justify-center rounded-lg outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:-m-1 sm:size-6",
      className,
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center rounded border border-input bg-card group-hover:border-muted-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-aria-invalid:border-destructive group-data-[state=checked]:border-primary group-data-[state=checked]:bg-primary group-data-[state=checked]:text-primary-foreground group-data-[state=indeterminate]:border-primary group-data-[state=indeterminate]:bg-primary group-data-[state=indeterminate]:text-primary-foreground"
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="size-3.5 group-data-[state=indeterminate]:hidden" strokeWidth={3} />
        <Minus className="hidden size-3.5 group-data-[state=indeterminate]:block" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </span>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
