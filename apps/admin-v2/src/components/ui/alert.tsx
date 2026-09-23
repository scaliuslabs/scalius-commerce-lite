import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@scalius/shared/utils";

/** Polaris banner. `destructive` is the critical tone. */
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-xl border px-4 py-3 text-body text-foreground has-[>svg]:grid-cols-[--spacing(4)_1fr] has-[>svg]:gap-x-3 [&>svg]:mt-[calc(0.5lh-0.5rem)] [&>svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card [&>svg]:text-muted-foreground",
        info: "border-info bg-info-surface [&>svg]:text-info",
        success: "border-success bg-success-surface [&>svg]:text-success",
        warning: "border-warning bg-warning-surface [&>svg]:text-warning",
        destructive: "border-critical bg-critical-surface [&>svg]:text-critical",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 font-semibold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("col-start-2 space-y-1", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
