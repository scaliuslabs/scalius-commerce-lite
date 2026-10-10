import * as React from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";

import { cn } from "@scalius/shared/utils";

const RadioGroup = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => <RadioGroupPrimitive.Root className={cn("grid gap-2", className)} {...props} ref={ref} />);
RadioGroup.displayName = RadioGroupPrimitive.Root.displayName;

const RadioGroupItem = React.forwardRef<
  React.ComponentRef<typeof RadioGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  // A 16px circle with a 24px hit area (44px on phones, C6), hung outside it by negative margins, as Checkbox.
  <RadioGroupPrimitive.Item
    ref={ref}
    className={cn(
      "peer group -m-3.5 inline-flex size-11 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:-m-1 sm:size-6",
      className,
    )}
    {...props}
  >
    <span
      aria-hidden="true"
      className="flex size-4 items-center justify-center rounded-full border border-primary bg-primary group-hover:border-muted-foreground group-aria-invalid:border-destructive group-data-[state=unchecked]:border-input group-data-[state=unchecked]:bg-card"
    >
      <RadioGroupPrimitive.Indicator className="size-1.5 rounded-full bg-primary-foreground" />
    </span>
  </RadioGroupPrimitive.Item>
));
RadioGroupItem.displayName = RadioGroupPrimitive.Item.displayName;

export { RadioGroup, RadioGroupItem };
