import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";

import { cn } from "@scalius/shared/utils";

/**
 * A 36x20 track with a 24px-tall hit area (44px on phones, C6), hanging
 * outside the track by negative margins so the layout keeps the track's size.
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer group -my-3 inline-flex h-11 w-9 shrink-0 cursor-pointer items-center rounded-full outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:-my-0.5 sm:h-6",
      className,
    )}
    {...props}
    ref={ref}
  >
    <span
      aria-hidden="true"
      className="flex h-5 w-9 items-center rounded-full border-2 border-transparent group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-background group-data-[state=checked]:bg-primary group-data-[state=unchecked]:bg-input"
    >
      <SwitchPrimitives.Thumb className="pointer-events-none block size-4 rounded-full bg-card shadow-xs transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 rtl:data-[state=checked]:-translate-x-4" />
    </span>
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
