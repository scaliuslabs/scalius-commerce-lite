import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@scalius/shared/utils";

/**
 * Status badges (Polaris tones): secondary = neutral, destructive = critical,
 * attention = caution. `default` is the strong badge for counts. Map statuses
 * with the table in DESIGN.md; never restyle a badge with colour classes.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-0.5 text-caption font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border text-muted-foreground",
        success: "bg-success-surface text-success",
        warning: "bg-warning-surface text-warning",
        attention: "bg-caution-surface text-caution",
        destructive: "bg-critical-surface text-critical",
        info: "bg-info-surface text-info",
      },
    },
    defaultVariants: {
      variant: "secondary",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export type BadgeVariant = NonNullable<BadgeProps["variant"]>;

export { Badge, badgeVariants };
