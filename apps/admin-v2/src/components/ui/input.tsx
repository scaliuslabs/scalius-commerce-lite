import * as React from "react";

import { cn } from "@scalius/shared/utils";

/** Field chrome shared by Input, Textarea and SelectTrigger (see DESIGN.md). */
export const fieldClassName =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 text-body-lg text-foreground placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:bg-critical-surface sm:text-body";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, type, ...props }, ref) => (
  <input
    type={type}
    className={cn(
      fieldClassName,
      "flex h-11 py-1 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-foreground sm:h-9",
      className,
    )}
    ref={ref}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
