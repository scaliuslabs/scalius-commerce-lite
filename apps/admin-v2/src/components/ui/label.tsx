import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";

import { cn } from "@scalius/shared/utils";

const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("text-body font-medium peer-disabled:cursor-not-allowed peer-disabled:opacity-60", className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
